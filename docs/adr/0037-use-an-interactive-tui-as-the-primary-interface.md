# Use an interactive TUI as the primary interface

NominaConnect remains CLI-only (ADR-0018): no web dashboard. Within that
constraint, the default operator experience is an interactive terminal UI
started by running `nomina` with no arguments.

Guided prompts collect platform and service choices. Command flags pre-fill those
prompts for scripts and tests. Project configuration is discovered from
`nomina.yaml` in the working directory or a parent folder; operators are not
asked for a project path.

See `docs/tui.md` for the prompt adapter contract and extension pattern.
