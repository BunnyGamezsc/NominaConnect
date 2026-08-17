# Persist adopted provider changes

When provider inspection finds a change to a managed resource, NominaConnect
will automatically update its durable configuration to the observed value and
record the adoption in reversible change history. The configuration therefore
remains the persistent connected-inventory record while direct provider UI
edits remain supported.
