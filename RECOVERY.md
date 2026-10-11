# Browser recovery

Browser error pages are checked every two seconds. Failed pages reopen the known
task URL with ten-second retry spacing and an eight-second navigation timeout.
Unexpected non-task pages get twenty seconds to settle. Login expiry reuses the
existing login flow. Paused slots, real verification challenges and active payouts
remain protected.

Repeated browser failures restart that account after at least six attempts and
sixty seconds. The external watchdog checks every ten seconds and also detects
ninety-second stale heartbeats or three minutes without observed point/balance
progress. Status updates and reloads do not count as confirmed progress. Restart
attempts are capped at eight per service per ten-minute window.

The watchdog runs as opc and uses existing exact sudo permissions for VisionTap
service restarts, including the `.service` suffix. The supplementary
`visiontap-recovery.sudoers` permits only the dedicated PayMath scanner restart;
validate with `visudo -cf` before installation. It grants no general root shell.

Run recovery regression tests from slotbrowser with:

    node --test browser-recovery.test.js

An external website outage can still interrupt earnings. Recovery status is shown
on the dashboard; no uptime or earnings guarantee is implied.
