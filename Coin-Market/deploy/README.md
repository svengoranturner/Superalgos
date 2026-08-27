# Deployment artefacts

For running Coin Market permanently on the Pi. Everything here is optional
until you want it running unattended — the tool works fine started by hand.

| File | What it is |
|---|---|
| `coin-market-collector.service` | The collector: discovery, snapshots, outcome resolution, spot mirroring |
| `coin-market-dashboard.service` | The dashboard, bound to loopback |
| `coin-market-notify.service` | eBay account-deletion endpoint (needed to activate production keys) |
| `cloudflared-ingress.md` | Publishing that one endpoint through your existing tunnel |

## Install

Edit **two lines** in each unit — `User=` and `WorkingDirectory=` — then:

```bash
sudo cp coin-market-*.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now coin-market-collector
sudo systemctl enable --now coin-market-dashboard
journalctl -u coin-market-collector -f
```

Enable `coin-market-notify` only when you are setting up production eBay keys.

Check the Node path matches your Pi first — the units assume `/usr/bin/node`,
which is where NodeSource installs it:

```bash
which node
```

## What was and was not verified

The unit files pass `systemd-analyze verify` with no syntax or directive errors.
They have **not** been run on real hardware, and the `ExecStart` paths are
placeholders until you edit them.

Verification caught one genuine bug worth knowing about, because it is invisible
at runtime: `StartLimitIntervalSec` was originally in `[Service]`, where systemd
**ignores it silently**. The collector would have kept systemd's default rate
limit and given up after repeated failures — the exact behaviour those lines
exist to prevent. It now sits in `[Unit]`.

`cloudflared-ingress.md` could not be verified at all: it was written without
access to your tunnel config or Cloudflare account. Read your existing
`config.yml` and merge rather than overwrite, and use
`cloudflared tunnel ingress rule <url>` to confirm the new path actually wins.

## Why the collector restarts forever but the dashboard does not

`Restart=always` with no start limit on the collector, `Restart=on-failure` on
the dashboard.

A lot can only be **discovered while it is live**. If the collector is down
overnight, every auction that closed in that window is lost permanently — the
outcome can never be backfilled, and with it goes the closing-uplift data that
teaches the projection curve. A dashboard that is down is an inconvenience you
notice immediately and restart by hand.
