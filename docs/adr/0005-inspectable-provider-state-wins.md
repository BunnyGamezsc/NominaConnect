# Inspectable provider state wins

When NominaConnect can inspect a managed provider resource, its currently
observed configuration takes precedence over a conflicting NominaConnect
configuration value. NominaConnect adopts the provider value and records the
change in history rather than requiring the user to resolve a conflict. This
matches the project's direct-provider-UI workflow while retaining a record of
the overwritten NominaConnect value.
