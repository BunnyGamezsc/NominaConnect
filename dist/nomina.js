#!/usr/bin/env node
import fs from "node:fs";
import process from "node:process";
import * as clack from "@clack/prompts";

import { runCli } from "../src/cli.js";
import { createClackPrompts } from "../src/prompts.js";
import { runInteractiveApp } from "../src/tui.js";
import { createProductionAdapters } from "../src/adapter-runtime.js";

const filesystem = {
  exists: fs.existsSync,
  read: (path) => fs.readFileSync(path, "utf8"),
  mkdir: (path) => fs.mkdirSync(path, { recursive: true }),
  writeFile: fs.writeFileSync,
  rename: fs.renameSync,
  chmod: fs.chmodSync,
  deletePath: (path) => fs.rmSync(path, { recursive: true, force: true })
};

const productionAdapters = createProductionAdapters();

const adapters = {
  filesystem,
  cwd: process.cwd(),
  runtime: {
    isRoot: () => process.getuid?.() === 0,
    isProxmoxHost: () => fs.existsSync("/usr/sbin/pct") || fs.existsSync("/usr/bin/pct")
  },
  ...productionAdapters,
  prompts: createClackPrompts(clack),
  interactive: {
    run: (context) => runInteractiveApp({
      ...context,
      runCommand: (argumentsList, commandAdapters) => runCli(argumentsList, commandAdapters)
    })
  }
};

const fromInteractiveMenu = process.argv.length <= 2;

try {
  const result = await runCli(process.argv.slice(2), adapters);
  if (result.stdout) {
    if (fromInteractiveMenu) {
      clack.log.success(result.stdout.trim());
    } else {
      process.stdout.write(result.stdout);
    }
  }
} catch (error) {
  clack.log.error(error.message);
  process.exitCode = 1;
}
