# Manage only the declared inventory

NominaConnect will manage only the services and integrations explicitly placed
in its managed inventory. It will preserve unmanaged DNS, proxy, and other
provider configuration rather than silently discovering and adopting it. This
keeps initial reconciliation safe while leaving explicit adoption as a future
workflow that can handle conflicts, provenance, and rollback deliberately.
