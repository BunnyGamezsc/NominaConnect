import test from "node:test";
import assert from "node:assert/strict";

import { countAccessRules } from "../tools/lab/tailnet-policy.js";
import { runIndependentCleanup } from "../tools/lab/independent-cleanup.mjs";
import { restoreCloneWithLeftoverCheck } from "../tools/lab/proxmox-recovery.mjs";

test("tailnet access-rule count adds ACL and grant sections", () => {
  assert.equal(countAccessRules({ acls: [{}, {}], grants: [{}] }), 3);
  assert.equal(countAccessRules({ acls: [], grants: [{}, {}] }), 2);
  assert.equal(countAccessRules({ grants: [{}] }), 1);
  assert.equal(countAccessRules({}), 0);
});

test("cleanup attempts every restoration and returns failures", async () => {
  const attempted = [];
  const failures = await runIndependentCleanup([
    ["first", async () => { attempted.push("first"); throw new Error("first failed"); }],
    ["second", async () => { attempted.push("second"); }],
    ["third", async () => { attempted.push("third"); throw new Error("third failed"); }]
  ]);

  assert.deepEqual(attempted, ["first", "second", "third"]);
  assert.equal(failures.length, 2);
  assert.deepEqual(failures.map((error) => error.message), ["first", "third"]);
});

test("failed pct restore reports the VMID when a partial clone remains", async () => {
  const calls = [];
  const restoreError = new Error("restore timed out");
  const run = async (binary, args) => {
    calls.push({ binary, args });
    if (args[0] === "restore") throw restoreError;
    return { stdout: "hostname: partial-clone\n" };
  };

  await assert.rejects(
    restoreCloneWithLeftoverCheck(run, { vmid: 104, archive: "/tmp/backup.tar.zst" }),
    (error) => error instanceof Error && error.cause === restoreError && /VMID 104/.test(error.message)
  );
  assert.deepEqual(calls.map(({ args }) => args[0]), ["restore", "config"]);
});

test("failed pct restore preserves its error when no clone config exists", async () => {
  const restoreError = new Error("restore failed before allocation");
  const run = async (_binary, args) => {
    if (args[0] === "restore") throw restoreError;
    throw new Error("container does not exist");
  };

  await assert.rejects(
    restoreCloneWithLeftoverCheck(run, { vmid: 104, archive: "/tmp/backup.tar.zst" }),
    (error) => error === restoreError
  );
});
