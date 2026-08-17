# Require explicit service upgrades

Service versions change only through `nomina service upgrade <name>`; background
tracking may report available upgrades but must not install them. Before an
upgrade, NominaConnect offers a Proxmox snapshot when supported and proceeds
only if the user confirms the snapshot choice. This keeps changes deliberate
while allowing a user to choose their rollback protection.
