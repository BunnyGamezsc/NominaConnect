# Use a visible project configuration

Each homelab is declared in a visible, human-editable root `nomina.yaml`.
Secrets, provider references, tracking-job records, and change history remain
outside it in secure or local operational state. This gives users a portable
configuration without embedding sensitive or volatile data in it.
