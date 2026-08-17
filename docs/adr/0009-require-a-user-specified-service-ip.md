# Require a user-specified service IP

The native-LXC new-service workflow will ask the user for the static IP address
of every dedicated service LXC. NominaConnect records the supplied address but
does not allocate one automatically. This keeps address choice under explicit
user control and matches the project's guided, transparent setup approach.
