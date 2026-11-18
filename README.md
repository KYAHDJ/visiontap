# VisionTap - Encodra

Read `CLAUDE.md` first (owner rules), then `docs/HANDBOOK.md` (history, measurements, procedures, troubleshooting).

| Path | What it is |
|---|---|
| `CLAUDE.md` | The owner's standing rules. Obey strictly. |
| `docs/HANDBOOK.md` | Full knowledge base from start to finish. |
| `slotbrowser/encodra-solver.js` | **Answerer.** Touches the page only when a Color Solving task is showing (connect, answer, disconnect); checks the points after every answer; writes `state/encodra_stats.json` and `state/encodra_answers.log`. |
| `slotbrowser/encodra-watchdog.js` | **Watchdog.** Never answers. Refreshes the page when the site blocks it (30, 25, 20, 15 s, then every 15 s), after 3 min stuck; restarts the browser when it is down, frozen, or its page grows past 1.5 GB; restarts the answerer if it goes silent. |
| `slotbrowser/encodra-dashboard.js` | Read-only dashboard (port 6260): wallet, points/min, earned today, tomorrow estimate, progress, date of the PHP 300 cashout, watchdog card. |
| `Start Encodra Solver.bat` | Windows launcher for the answerer (no Claude needed). |

Server layout (systemd): `encodra-brave` (Brave with `--remote-debugging-port=9222`), `encodra-solver`, `encodra-watchdog`,
`encodra-dashboard`. No page hiding of any kind. No passwords or tokens in this repo.
