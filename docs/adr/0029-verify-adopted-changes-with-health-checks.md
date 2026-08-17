# Verify adopted changes with health checks

Every service plugin defines health checks for its service process, endpoint,
and applicable platform integrations. When tracking adopts an observed change,
NominaConnect runs the affected check before reporting a verified adoption.
Observed configuration alone is not treated as proof that a service works.
