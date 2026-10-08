import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createCaddyAdapter } from "../src/caddy-adapter.js";
import { createHttpClient } from "../src/adapter-runtime.js";

// Optional real-process regression. Run under an isolated network namespace
// on Linux: unshare --net sh -c 'ip link set lo up; NOMINA_CADDY_BINARY=... node --test ...'.
// CA data and trust stay in this process's temporary directory.
test("Caddy preserves trusted HTTPS when tailnet access is toggled", {
  skip: !process.env.NOMINA_CADDY_BINARY,
  timeout: 30_000
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nomina-caddy-wire-"));
  const endpoint = "http://127.0.0.1:22019";
  const config = {
    admin: { listen: "127.0.0.1:22019" },
    apps: {
      pki: { certificate_authorities: { local: { install_trust: false } } },
      http: { http_port: 22080, https_port: 443, servers: {
        srv_http: { listen: ["127.0.0.1:22080"], routes: [] },
        // Traversing a missing Caddy path with PUT can leave a server that
        // has routes but no listener, as the live suite's unmanaged seed did.
        srv_https: { routes: [] }
      } }
    }
  };
  const configPath = path.join(directory, "caddy.json");
  fs.writeFileSync(configPath, JSON.stringify(config));
  const log = fs.openSync(path.join(directory, "caddy.log"), "w", 0o600);
  const child = spawn(process.env.NOMINA_CADDY_BINARY, ["run", "--config", configPath], {
    env: { ...process.env, XDG_DATA_HOME: directory, XDG_CONFIG_HOME: directory },
    stdio: ["ignore", log, log]
  });
  const backend = http.createServer((_request, response) => response.end("backend ok"));
  backend.listen(0, "127.0.0.1");
  await once(backend, "listening");
  t.after(async () => {
    backend.close();
    child.kill();
    if (child.exitCode === null) await once(child, "exit");
    fs.closeSync(log);
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const httpClient = createHttpClient();
  for (let attempt = 0; ; attempt++) {
    try {
      const ready = await httpClient.request({ method: "GET", url: `${endpoint}/config/` });
      assert.equal(ready.status, 200);
      break;
    } catch (error) {
      if (attempt === 40) {
        console.error(fs.readFileSync(path.join(directory, "caddy.log"), "utf8").slice(-3000));
        throw error;
      }
      await delay(100);
    }
  }
  const adapter = createCaddyAdapter({ httpClient, secretResolver: { resolve() {} } });
  const request = { endpoint, hostname: "photos.productioncheck.internal",
    backendIp: "127.0.0.1", backendPort: backend.address().port,
    caStrategy: "caddy-internal-ca", tailnetGatewayIp: "127.0.0.2", httpRedirect: true };
  await adapter.publishRoute({ ...request, tailnet: true });
  const ca = (await httpClient.request({ method: "GET", url: `${endpoint}/pki/ca/local/certificates` })).body;
  const probe = (gateway, tls = true) => new Promise((resolve, reject) => {
    const transport = tls ? https : http;
    const req = transport.request({ hostname: "127.0.0.1", port: tls ? 443 : 22080,
      servername: request.hostname, ca, rejectUnauthorized: true, agent: false,
      localAddress: gateway ? "127.0.0.2" : "127.0.0.1", timeout: 2000,
      headers: { Host: request.hostname, "X-Forwarded-For": "127.0.0.1" }
    }, response => { response.resume(); resolve(response.statusCode); });
    req.on("error", reject);
    req.on("timeout", () => req.destroy(new Error("probe timed out")));
    req.end();
  });
  for (let attempt = 0; ; attempt++) {
    try { assert.equal(await probe(true), 200); break; }
    catch (error) { if (attempt === 40) throw error; await delay(100); }
  }
  await adapter.publishRoute({ ...request, tailnet: false });
  assert.equal(await probe(true), 404, "gateway HTTPS must deny forged forwarding headers");
  assert.equal(await probe(false), 200, "LAN HTTPS must survive opting out");
  assert.equal(await probe(true, false), 404, "gateway HTTP must not bypass denial");
  assert.equal(await probe(false, false), 308, "LAN HTTP must keep its redirect");
  await adapter.publishRoute({ ...request, tailnet: true });
  assert.equal(await probe(true), 200, "reenabling must restore gateway HTTPS");
});
