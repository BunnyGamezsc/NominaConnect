# Bootstrap the platform in dependency order

`nomina init` will guide the user through DNS, reverse proxy, certificate
authority, and optional VPN setup before applications. It asks for named
software choices at each step instead of presenting one opaque install flow.
This preserves the platform-before-applications boundary while providing a
clear guided first-run experience.
