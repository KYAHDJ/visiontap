# Dashboard

The dashboard listens on port `6260` and polls `/api/stats`. It displays five Chrome workers, scanner health, balances, points, rates, payout state, and per-account controls.

Pause, resume, refresh, and restart commands target Chrome state files only. A verification hold produces a full-card blurred overlay for the affected account and never blocks the rest of the dashboard.

The dashboard contains no Electron process checks or command queues.
