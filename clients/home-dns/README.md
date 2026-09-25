# Home DNS addon

This optional client helper switches Tailscale DNS off at home and back on when
you leave. It checks the default router's IP and MAC address, then asks
Technitium directly for a managed hostname. It changes DNS only when both checks
match the home network saved during setup.

At home, local DNS must return the same address that Technitium returned during
setup. If it does not, the helper turns Tailscale DNS back on. The check runs
every 30 seconds on macOS and Linux, and every minute on Windows. A network
change can take that long to update.

## Windows

Download [nomina-home-dns.ps1](https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/clients/home-dns/nomina-home-dns.ps1),
open Windows PowerShell, then run:

```powershell
powershell.exe -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File .\nomina-home-dns.ps1 ui
```

The optional Windows Forms menu can install or edit the helper, show its status,
or uninstall it. After setup, it adds a Start menu shortcut and a per-user
Scheduled Task. The task checks once a minute and starts again when you sign in.
The GUI uses Windows PowerShell 5.1 and Windows' built-in Forms library. You do
not need Bun, Python, or a separate app runtime.

You can also use the script from PowerShell:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\nomina-home-dns.ps1 setup 192.168.1.2 stats.bunny.internal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\nomina-home-dns.ps1 status
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\nomina-home-dns.ps1 uninstall
```

Replace the sample address and hostname with your Technitium LAN address and a
managed hostname. The task runs as your signed-in user. If Tailscale refuses the
DNS preference change, setup or the log file will report the error. Logs are
saved under `%APPDATA%\NominaConnect\home-dns.log`.

## macOS and Linux

Download [nomina-home-dns.sh](https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/clients/home-dns/nomina-home-dns.sh),
then run:

```sh
chmod 700 nomina-home-dns.sh
./nomina-home-dns.sh ui
```

The native menu can install or edit settings, show status, or uninstall the
helper. macOS uses a per-user launchd agent and AppleScript dialogs. Linux uses
a systemd user timer and needs `zenity` for the graphical menu. Without zenity,
run `setup`, `status`, or `uninstall` in a terminal. On Linux, allow your user
to run `tailscale set` once:

```sh
sudo tailscale set --operator="$(id -un)"
```

The Linux setup also needs `dig`. On Debian or Ubuntu, install `dnsutils`.

Reopening the GUI and choosing **Install or edit** uses your saved DNS server
and hostname as the prompt defaults. Editing records the current router and DNS
answer as the new home network. Choose **Uninstall** to remove the scheduled
helper and enable Tailscale DNS on this device.

## Limits

The addon changes only this device's Tailscale DNS preference. It does not
change tailnet-wide DNS settings, route LAN subnets, or make opted-out exposures
available from other networks. DNS may take one check interval to switch after
you move. If Tailscale or the local DNS server is unavailable, the helper cannot
confirm the local answer; it keeps or restores Tailscale DNS when it can.
