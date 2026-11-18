# Require explicit service upgrades

Service versions change through the explicit service upgrade flow. Background
tracking can report available upgrades. Run `nomina service upgrade <name>`
for a standalone upgrade, with a Proxmox snapshot offered when supported.
Encrypted DNS setup can include the same Technitium upgrade in its review
when the operator opts in. Approval of that combined review requests a
snapshot when supported and authorizes both the upgrade and DNS setup.
