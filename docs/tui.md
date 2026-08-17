# Interactive TUI design

NominaConnect is CLI-only (no web dashboard), but the **primary operator
experience is an interactive terminal UI (TUI)**. Operators run `nomina` with no
arguments, pick an action from a menu, and answer guided prompts. Command flags
remain available for scripts and tests.

## Operator flow

```text
nomina
  └─ intro + main menu
       ├─ Initialize a new project       → nomina init            → promptInitOptions
       ├─ Provision Technitium DNS         → service add technitium → promptTechnitiumOptions
       ├─ Provision Caddy reverse proxy  → service add caddy      → promptCaddyOptions
       ├─ Provision Traefik reverse proxy→ service add traefik    → promptTraefikOptions
       ├─ Publish a web exposure         → exposure publish       → promptExposureOptions
       └─ Exit
```

Subcommands such as `nomina init`, `nomina service add caddy`,
`nomina service add traefik`, or `nomina exposure publish` skip the main menu
but still use the same prompt functions whenever a value was not passed on the
command line.

## Project discovery

Operators do not choose a “project path”. NominaConnect finds `nomina.yaml` in
the current working directory or any parent directory. Initialization always
writes into the current working directory.

## Architecture

```text
bin/nomina.js
  ├─ filesystem / runtime / proxmox adapters
  ├─ createClackPrompts()  ──► prompts adapter (ask, select, confirm, info, warn)
  └─ runInteractiveApp()   ──► main menu when argv is empty

src/cli.js
  └─ runCli(argv, adapters)
       ├─ []                    → interactive.run()
       ├─ init                  → promptInitOptions → initializeProject
       ├─ service add [name]    → promptServiceName? → promptTechnitiumOptions / promptCaddyOptions / promptTraefikOptions
       └─ exposure publish      → promptExposureOptions → publishExposure

src/tui.js
  ├─ runInteractiveApp         main menu and routing
  ├─ buildMenuOptions          context-aware menu entries
  ├─ promptInitOptions         guided platform bootstrap
  ├─ promptTechnitiumOptions   guided DNS LXC setup
  ├─ promptCaddyOptions        guided Caddy reverse-proxy LXC setup
  ├─ promptTraefikOptions      guided Traefik reverse-proxy LXC setup
  ├─ promptExposureOptions     guided DNS + HTTPS exposure setup
  └─ promptServiceName         when service name omitted
```

Business logic stays in `cli.js`, `config.js`, and `provisioning.js`. The TUI
layer only collects input and routes to commands.

## Prompt adapter contract

All interactive input goes through an injectable `prompts` object so tests never
need a real terminal:

| Method | Purpose |
| --- | --- |
| `ask(question, fallback?)` | Free-text answer |
| `select({ message, options, initialValue? })` | Single choice from labeled options |
| `confirm({ message, initialValue? })` | Yes / no |
| `info(message)` | Non-blocking context (defaults, bridge, storage) |
| `warn(message)` | Validation feedback |

Production wiring lives in `src/prompts.js` (`createClackPrompts`). Tests inject
plain functions or omit `prompts` to use flag defaults.

## Menu rules

The main menu is built from project context:

- **No project found** — offer initialization and exit.
- **Project found, Technitium not yet provisioned** — offer Technitium provisioning,
  initialization (in another directory), and exit.
- **Technitium provisioned, reverse proxy (Caddy or Traefik) not yet provisioned** — offer Caddy / Traefik provisioning.
- **Technitium and reverse proxy provisioned** — offer web exposure publishing.
- **Action already completed** — hide that menu entry until another command applies.

## Adding a new interactive command

1. Implement the command handler in `src/cli.js` (same as today).
2. Add a `prompt…Options(project, existingOptions, prompts)` function in
   `src/tui.js` for any values the operator must supply.
3. Call that prompt function from the handler before validation / provisioning.
4. Add a menu entry in `buildMenuOptions` when the action should appear on the
   main menu.
5. Route the menu action in `runInteractiveApp`.
6. Test with injectable `prompts` — never assert on `@clack/prompts` internals.

## Flags and automation

Flags such as `--ip` or `--node` pre-fill prompt functions and skip the
corresponding question. This keeps one code path for interactive and automated
use. Tests should continue to pass explicit flags when they are not exercising
the prompt layer.
