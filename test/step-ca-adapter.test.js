import test from "node:test";
import assert from "node:assert/strict";

import { createStepCaAdapter } from "../src/step-ca-adapter.js";

function noopSecretResolver() {}

test("step-ca install requests a SAN for step-ca.<baseLocalDomain> so Caddy can reach the ACME directory by name", async () => {
  const adapter = createStepCaAdapter({ httpClient: {}, secretResolver: noopSecretResolver });

  const plan = await adapter.setup({ zone: "bunnyhome.test" });
  const commands = plan.lxcCommands.map((command) =>
    typeof command === "string" ? command : `${command.binary} ${command.args.join(" ")}`
  );
  const initScript = commands.find((command) => command.includes("step ca init"));

  assert.notEqual(initScript, undefined, "install plan must contain step ca init");
  assert.match(
    initScript,
    /--dns "\$\(hostname -f\),localhost,step-ca\.bunnyhome\.test"/,
    "init must request a DNS SAN for step-ca.<zone>; bare IPs are not valid SAN targets for the ACME directory URL"
  );
});

test("step-ca install omits the extra SAN when no zone is provided (backwards compatible)", async () => {
  const adapter = createStepCaAdapter({ httpClient: {}, secretResolver: noopSecretResolver });

  const plan = await adapter.setup({});
  const commands = plan.lxcCommands.map((command) =>
    typeof command === "string" ? command : `${command.binary} ${command.args.join(" ")}`
  );
  const initScript = commands.find((command) => command.includes("step ca init"));

  assert.notEqual(initScript, undefined);
  assert.doesNotMatch(initScript, /step-ca\.undefined/);
});
