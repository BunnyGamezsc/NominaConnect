#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { runCli } from "../src/cli.js";

const filesystem = {
  exists: fs.existsSync,
  mkdir: (path) => fs.mkdirSync(path, { recursive: true }),
  writeFile: fs.writeFileSync,
  rename: fs.renameSync,
  chmod: fs.chmodSync
};

const promptInterface = createInterface({ input: process.stdin, output: process.stdout });

try {
  const result = await runCli(process.argv.slice(2), {
    filesystem,
    runtime: {
      isRoot: () => process.getuid?.() === 0,
      isProxmoxHost: () => fs.existsSync("/usr/sbin/pct") || fs.existsSync("/usr/bin/pct")
    },
    prompts: {
      ask: async (question, fallback) => {
        const suffix = fallback === undefined ? "" : ` [${fallback}]`;
        const answer = (await promptInterface.question(`${question}${suffix}: `)).trim();
        return answer || fallback;
      }
    }
  });
  process.stdout.write(result.stdout);
} catch (error) {
  process.stderr.write(`nomina: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  promptInterface.close();
}
