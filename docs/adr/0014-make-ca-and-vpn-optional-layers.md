# Make certificate authority and VPN optional layers

Certificate authority and VPN are optional platform-bootstrap layers. When a
VPN is enabled, Tailscale and NetBird are selectable provider choices; when TLS
is enabled, the certificate-authority choices remain compatible with the chosen
reverse proxy. This preserves explicit software choice without making every
homelab install optional infrastructure it does not need.
