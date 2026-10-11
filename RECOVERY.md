# Browser recovery

Browser errors reopen the task page with ten-second retry spacing. An unexpected
page gets twenty seconds to settle. Repeated errors restart only the affected
browser after at least six attempts and sixty seconds. Paused slots, verification
challenges and active payouts remain protected; expired logins use the existing
login flow.

The watchdog checks every ten seconds. It detects ninety-second stale heartbeats
and three minutes without confirmed point/balance progress; fresh status messages
and reloads do not count as earning progress. Restarts are capped at eight per
service in a ten-minute window. The existing root watchdog service is unchanged.

Run from slotbrowser:

    node --test browser-recovery.test.js

External website outages remain possible. Dashboards show recovery errors while
the workers attempt to reconnect.
