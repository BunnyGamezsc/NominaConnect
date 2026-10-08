// Read-only policy inspection. Never print the token or private policy body.
import fs from 'node:fs';
const token=fs.readFileSync('/root/tskey/api','utf8').trim();
const response=await fetch('https://api.tailscale.com/api/v2/tailnet/-/acl',{
  headers:{Authorization:`Bearer ${token}`,Accept:'application/json'},signal:AbortSignal.timeout(15000)
});
const body=await response.text();
const result={status:response.status};
if(response.ok){
  fs.writeFileSync('/root/nomina-production-check-backups/tailnet-policy.json',body,{mode:0o600});
  try {
    const policy=JSON.parse(body);
    result.ruleCount=(policy.acls??[]).length+(policy.grants??[]).length;
    result.broadAllow=(policy.acls??[]).some(r=>r.action==='accept' && r.src?.includes('*') && r.dst?.includes('*:*'))
      ||(policy.grants??[]).some(r=>r.src?.includes('*') && r.dst?.includes('*') && r.ip?.includes('*'));
  }catch{result.format='HuJSON; saved privately for policy review';}
}
fs.writeFileSync('/root/nomina-production-check-backups/tailnet-policy-summary.json',JSON.stringify(result,null,2)+'\n',{mode:0o600});
console.log(JSON.stringify(result));
