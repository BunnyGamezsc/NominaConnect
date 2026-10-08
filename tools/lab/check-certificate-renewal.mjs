// Run on the Proxmox root shell against an explicitly retained lab project.
// Only the temporary renewcheck exposure is removed. Existing LXCs are retained.
import fs from 'node:fs';
import https from 'node:https';
import assert from 'node:assert/strict';
import { createCommandRunner, createHttpClient, createProductionAdapters } from '../../src/adapter-runtime.js';
import { runCli } from '../../src/cli.js';
import { loadProject } from '../../src/config.js';

const projectDir = process.argv[2];
assert.equal(process.env.NOMINA_READINESS, '1');
assert.ok(projectDir && fs.existsSync(`${projectDir}/nomina.yaml`));
const clock = await createCommandRunner().run({binary:'/usr/bin/timedatectl',
  args:['show','--property=NTPSynchronized','--value']});
assert.equal(clock.stdout.trim(),'yes','Synchronize the Proxmox clock before testing short-lived certificates.');
const filesystem = {
  exists: fs.existsSync, read: p => fs.readFileSync(p, 'utf8'),
  mkdir: p => fs.mkdirSync(p, {recursive:true}), writeFile: fs.writeFileSync,
  rename: fs.renameSync, chmod: fs.chmodSync,
  deletePath: p => fs.rmSync(p, {recursive:true, force:true})
};
const production = createProductionAdapters();
const httpClient = createHttpClient();
const adapters = {filesystem, runtime:{isRoot:()=>process.getuid()===0, isProxmoxHost:()=>fs.existsSync('/usr/sbin/pct')}, ...production};
const project = loadProject(filesystem, projectDir);
const ref = key => project.state.providerReferences[project.config.managedInventory.platform[key].id];
const caRef = ref('certificateAuthority'), proxyRef = ref('reverseProxy'), dnsRef = ref('dns');
const name = `renewcheck-${Date.now()}`;
const hostname = `${name}.${project.config.baseLocalDomain}`;
assert.ok(!project.config.managedInventory.services.some(s => s.name === name || s.exposure?.hostname === hostname));
const backupDir = `${projectDir}/.nomina/renewal-check`;
if (fs.existsSync(backupDir)) {
  assert.ok(fs.existsSync(`${backupDir}/restored`), 'A previous renewal check needs recovery before another run.');
  fs.renameSync(backupDir,`${backupDir}.${Date.now()}`);
}
fs.mkdirSync(backupDir, {mode:0o700});
const exec = (vmid, binary, args, stdin) => production.proxmox.pctExec(vmid, {binary,args,timeoutMs:30000,...(stdin===undefined?{}:{stdin})});
const caPath = '/var/lib/stepca/config/ca.json';
const caOriginal = (await exec(caRef.vmid, '/bin/cat', [caPath])).stdout;
fs.writeFileSync(`${backupDir}/ca.json`, caOriginal, {mode:0o600});
const admin = `http://${proxyRef.ip}:2019`;
async function caddy(method, route, body) {
  const r = await httpClient.request({method,url:admin+route,
    headers:body===undefined?{}:{'Content-Type':'application/json'},
    ...(body===undefined?{}:{body:JSON.stringify(body)})});
  assert.ok(r.status>=200 && r.status<300, `Caddy ${method} ${route}: HTTP ${r.status}`);
  return r.body ? JSON.parse(r.body) : null;
}
const caddyOriginal = await caddy('GET','/config/');
fs.writeFileSync(`${backupDir}/caddy.json`,JSON.stringify(caddyOriginal),{mode:0o600});
const ca = (await exec(caRef.vmid,'/bin/cat',['/var/lib/stepca/certs/root_ca.crt'])).stdout;
const writeCa = contents => exec(caRef.vmid,'/usr/bin/python3',['-c',
  'import sys; p="/var/lib/stepca/config/ca.json"; open(p,"w").write(sys.stdin.read())'],contents);
function leaf() {
  return new Promise((resolve,reject)=>{
    const req=https.request({hostname,path:`/?renewal-check=${Date.now()}`,ca,agent:false,
      lookup:(_h,o,cb)=>o.all?cb(null,[{address:proxyRef.ip,family:4}]):cb(null,proxyRef.ip,4)},res=>{
      const cert=res.socket.getPeerCertificate();
      const tlsVerified=res.socket.authorized;
      res.resume();res.on('end',()=>{
        try {assert.equal(res.statusCode,200);assert.equal(tlsVerified,true);
          resolve({serial:cert.serialNumber,fingerprint:cert.fingerprint256,notBefore:cert.valid_from,notAfter:cert.valid_to,time:new Date().toISOString()});
        } catch(e){reject(e);}
      });
    });
    req.setTimeout(10000,()=>req.destroy(new Error('HTTPS timed out')));
    req.on('error',reject);req.end();
  });
}
let published=false;
try {
  const config=JSON.parse(caOriginal);
  const provisioner=config.authority.provisioners.find(p=>p.type==='ACME' && p.name==='acme');
  assert.ok(provisioner);
  provisioner.claims={...provisioner.claims,minTLSCertDuration:'5m',defaultTLSCertDuration:'5m',maxTLSCertDuration:'24h'};
  await writeCa(JSON.stringify(config));
  await exec(caRef.vmid,'/bin/systemctl',['restart','step-ca']);
  await runCli(['exposure','publish','--project-dir',projectDir,'--name',name,'--hostname',hostname,
    '--backend-ip',dnsRef.ip,'--backend-port','5380','--tailnet','true'],adapters);
  published=true;
  const current=await caddy('GET','/config/');
  current.apps.tls.automation.renew_interval='10s';
  const policy=current.apps.tls.automation.policies.find(p=>p.subjects?.includes(hostname));
  assert.ok(policy);policy.renewal_window_ratio=0.5;
  await caddy('POST','/load',current);
  // Start a fresh certificate-maintenance ticker with the test interval.
  // Existing caches can retain the interval from the original process start.
  await exec(proxyRef.vmid,'/usr/bin/python3',['-c','import sys;open("/etc/caddy/caddy.json","w").write(sys.stdin.read())'],JSON.stringify(current));
  await exec(proxyRef.vmid,'/bin/systemctl',['restart','caddy']);
  let first;
  for (let attempt=0;attempt<30;attempt++) {
    try { first=await leaf(); break; } catch(error) {
      if(attempt===29) throw error;
      await new Promise(r=>setTimeout(r,2000));
    }
  }
  assert.ok(Date.parse(first.notAfter)-Date.parse(first.notBefore)<=7*60*1000,'CA did not issue a short-lived test certificate');
  console.log(JSON.stringify({event:'short-lived-certificate-issued',hostname,...first}));
  const deadline=Date.now()+8*60*1000;
  let renewed;
  while(Date.now()<deadline){
    await new Promise(r=>setTimeout(r,10000));
    const next=await leaf();
    if(next.serial!==first.serial && Date.parse(next.notAfter)>Date.parse(first.notAfter)+30000){renewed=next;break;}
  }
  assert.ok(renewed,'Caddy did not automatically renew within eight minutes');
  assert.ok(Date.parse(renewed.notAfter)>Date.parse(first.notAfter));
  const result={hostname,initial:first,renewed,tlsVerified:true};
  fs.writeFileSync(`${projectDir}/.nomina/renewal-results.json`,JSON.stringify(result,null,2)+'\n',{mode:0o600});
  console.log(JSON.stringify({event:'automatic-renewal-verified',...result}));
} finally {
  await writeCa(caOriginal);
  await exec(caRef.vmid,'/bin/systemctl',['restart','step-ca']);
  if(published) await runCli(['service','remove',name,'--project-dir',projectDir],adapters);
  await caddy('POST','/load',caddyOriginal);
  await exec(proxyRef.vmid,'/usr/bin/python3',['-c','import sys;open("/etc/caddy/caddy.json","w").write(sys.stdin.read())'],JSON.stringify(caddyOriginal));
  await exec(proxyRef.vmid,'/bin/systemctl',['restart','caddy']);
  fs.writeFileSync(`${backupDir}/restored`,'Original CA and Caddy settings restored; only temporary exposure removed.\n',{mode:0o600});
  console.log('Original CA duration and Caddy renewal settings restored. Main deployment retained.');
}
