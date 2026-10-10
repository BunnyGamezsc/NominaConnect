import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Treat a process as alive unless the OS confirms its PID does not exist. */
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== "ESRCH"; }
}

/** Remove a recorded dead owner's lock under a recovery guard; leave live or unverifiable owners untouched. */
function recoverAbandonedLock(lock) {
  const recovery = `${lock}.recovery`;
  try { fs.mkdirSync(recovery, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") return; throw error; }
  try {
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); } catch { return; }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) return;
    const abandoned = `${lock}.${randomUUID()}.abandoned`;
    fs.renameSync(lock, abandoned);
    fs.rmSync(abandoned, { recursive: true });
  } finally { fs.rmdirSync(recovery); }
}

/** Acquire a named per-project filesystem lock within five seconds and return an ownership-checked release callback. */
export async function acquireProjectLock(projectDirectory, name = "write") {
  const lock = path.join(projectDirectory, ".nomina", `${name}.lock`);
  const deadline = Date.now() + 5000;
  const token = randomUUID();
  while (true) {
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
      try { fs.writeFileSync(path.join(lock, "owner.json"), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }); }
      catch (error) { fs.rmdirSync(lock); throw error; }
      return () => {
        let owner;
        try { owner = JSON.parse(fs.readFileSync(path.join(lock, "owner.json"), "utf8")); }
        catch (error) { if (error.code === "ENOENT" && !fs.existsSync(lock)) return; throw error; }
        if (owner.token !== token) throw new Error("Project lock ownership changed unexpectedly.");
        fs.unlinkSync(path.join(lock, "owner.json"));
        fs.rmdirSync(lock);
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      recoverAbandonedLock(lock);
      if (Date.now() >= deadline) throw new Error(`Project is busy or has an interrupted operation. Check ${lock} before retrying; remove this lock only after confirming no Nomina process is using it.`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}
