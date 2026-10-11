import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadProject, serializeProjectConfiguration } from "./config.js";

const queues = new Map();

// Reload inside the queue, then commit both files without an asynchronous gap.
// Production also holds a filesystem lock across processes.
/** Queue per-project updates, reload under the write lock and replace config and state without an asynchronous gap. */
export async function updateProject(filesystem, projectDirectory, update, { maxRetries = 0, baseDelayMs = 1000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  const key = path.resolve(projectDirectory);
  const previous = queues.get(key) ?? Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    let release;
    for (let attempt = 0; ; attempt++) {
      try {
        release = await filesystem.acquireProjectLock?.(projectDirectory);
        break;
      } catch (error) {
        if (error.code !== "NOMINA_PROJECT_BUSY" || attempt >= maxRetries) throw error;
        await sleep(baseDelayMs);
      }
    }
    try {
      const project = loadProject(filesystem, projectDirectory);
      const result = update(project) ?? project;
      atomicWrite(filesystem, project.configPath, serializeProjectConfiguration(result.config));
      atomicWrite(filesystem, project.statePath, `${JSON.stringify(result.state, null, 2)}\n`, 0o600);
      return result;
    } finally {
      release?.();
    }
  });
  queues.set(key, pending);
  try { return await pending; } finally { if (queues.get(key) === pending) queues.delete(key); }
}

/** Write through a unique temporary file, optionally restrict its permissions, then atomically replace the destination. */
export function atomicWrite(filesystem, destination, content, mode = undefined) {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  filesystem.writeFile(temporary, content);
  if (mode !== undefined) filesystem.chmod?.(temporary, mode);
  filesystem.rename(temporary, destination);
}
