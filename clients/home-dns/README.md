# Home DNS addon

This optional macOS and Linux helper keeps Tailscale connected and changes only
the client device's Tailscale DNS preference. Every 30 seconds it checks the
default router's IP and hardware address, then asks Technitium directly for a
managed hostname. It uses local DNS only when both checks match the home
network recorded during setup. Away from home, it turns Tailscale DNS back on.

The addon uses a per-user launchd agent on macOS and a systemd user timer on
Linux. On Linux, the logged-in user must be allowed to run tailscale set.
Grant that permission once with:

    sudo tailscale set --operator="$(id -un)"

Install Tailscale's CLI and dig first. On Debian or Ubuntu, dig is in dnsutils.
Download [nomina-home-dns.sh](https://raw.githubusercontent.com/BunnyGamezsc/NominaConnect/main/clients/home-dns/nomina-home-dns.sh),
then run:

    chmod 700 nomina-home-dns.sh
    ./nomina-home-dns.sh ui

The native menu asks for the LAN IPv4 address of Technitium and one managed
hostname such as stats.bunny.internal. It records that hostname's current A
answer and the home router identity. Linux needs zenity for the graphical
menu. Without it, run ./nomina-home-dns.sh setup in a terminal.

Use ./nomina-home-dns.sh status to check the saved home network and
./nomina-home-dns.sh uninstall to remove the timer or agent and restore
Tailscale DNS on this device.

The check runs every 30 seconds, so DNS can take up to that long to switch
after a network change. Local DNS must resolve the probe hostname to the same
LAN proxy address that Technitium returned during setup. The helper does not
support Windows, iOS, or Android.
