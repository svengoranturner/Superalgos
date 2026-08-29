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

**On this Pi the four values are known**, because `coin-market-notify` is now
installed and running with them:

| Directive | Value here |
|---|---|
| `User=` / `Group=` | `stacker` |
| `WorkingDirectory=` | `/home/stacker/coin-market-repo/Coin-Market` |
| `ExecStart=` | `/usr/local/bin/node bin/cli.js ...` |

Node is **not** at `/usr/bin/node` — it was installed from the official arm64
tarball under `/usr/local/lib/nodejs`, with `/usr/local/bin/node` symlinked to it.

## What was and was not verified

The unit files pass `systemd-analyze verify` with no syntax or directive errors.

`coin-market-notify` has now **been run on the real Pi**: installed, enabled,
listening on 127.0.0.1:34261, and answering both a challenge GET and a deletion
POST correctly. The collector and dashboard units are still unrun, and their
`ExecStart` paths are still placeholders until you edit them.

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
