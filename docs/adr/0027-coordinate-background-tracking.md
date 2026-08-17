# Coordinate background tracking safely

Foreground CLI commands and background tracking jobs commit configuration only
through one atomic write queue. Completed tracking jobs report concise change
notices on the next CLI invocation, with detail in `nomina changes`. Unavailable
providers use bounded backoff and become verification warnings rather than
blocking unrelated CLI work.
