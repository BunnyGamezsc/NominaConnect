# Keep device setup optional and platform-specific

Household clients need CA trust and DNS access even when the operator cannot
change DHCP. Device setup is an optional follow-up to successful CA setup,
available again later; it produces operator-selected Apple profiles or Windows
setup packages rather than requiring device management or changing every client
on the network. This preserves independent CA provisioning and unmanaged client
settings while accepting the cost of separate platform implementations and
explicit installation, replacement, and removal lifecycles.
