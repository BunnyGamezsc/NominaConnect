# Track changes in the background

When a NominaConnect CLI command runs, inspection and adoption of changes across
managed services and integrations happens asynchronously in the background. The
requested command must not wait for a full inspection before proceeding. This
keeps routine CLI use responsive while preserving automatic tracking. Each
tracking job continues after its initiating CLI command exits until its pass is
complete; NominaConnect does not require an always-running daemon.
