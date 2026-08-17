# Retain service data on removal

`nomina service remove` removes managed platform integrations but retains the
stopped dedicated LXC and its data by default. Destruction is a separate,
explicitly confirmed operation. This makes routine service removal recoverable
and avoids treating application data as disposable infrastructure.
