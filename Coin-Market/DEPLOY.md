# Getting Coin Market onto the Pi

Right now the tool lives only in this git branch. Nothing is installed or
running on your Pi. This is step one: get it there and prove it runs, with **no
eBay account, no Cloudflare, and no configuration**.

## 1. Check Node first — this is what usually bites

```bash
node --version
```

You need **22.5 or newer**. The tool uses `node:sqlite`, which landed in Node
22.5 — that is why it has no dependencies and needs no compiler on a Pi.

On the Pi as found, there was **no Node at all**, and `apt` offers 20.19
(Debian 13 trixie) — too old. What was actually installed, and what these
instructions are now verified against, is the official arm64 build unpacked
under `/usr/local`, checksum verified:

```bash
V=v24.20.0
cd /tmp
curl -fsSL --retry 5 --retry-all-errors -O https://nodejs.org/dist/$V/node-$V-linux-arm64.tar.xz
curl -fsSL --retry 5 --retry-all-errors https://nodejs.org/dist/$V/SHASUMS256.txt -o SHASUMS256.txt
grep "node-$V-linux-arm64.tar.xz" SHASUMS256.txt | sha256sum -c -
sudo mkdir -p /usr/local/lib/nodejs
sudo tar -xJf node-$V-linux-arm64.tar.xz -C /usr/local/lib/nodejs
sudo ln -sfn /usr/local/lib/nodejs/node-$V-linux-arm64 /usr/local/lib/nodejs/current
sudo ln -sfn /usr/local/lib/nodejs/current/bin/node /usr/local/bin/node
sudo ln -sfn /usr/local/lib/nodejs/current/bin/npm /usr/local/bin/npm
sudo ln -sfn /usr/local/lib/nodejs/current/bin/npx /usr/local/bin/npx
node --version
```

The `current` symlink is the point of the layout: upgrading later is unpacking
the next version beside it and repointing one link, and backing out is
repointing it again. `apt` never gets an opinion about Node.

The `--retry` flags are not decoration. The Pi resolves DNS through the router
alone, and `nodejs.org` and `github.com` intermittently fail to resolve — every
long-running fetch on this box wants retries (see *DNS* below).

If you skip Node entirely, the CLI stops with install instructions rather than a
cryptic missing-module error.

## 1a. DNS

Worth knowing before anything blames the network on your behalf. `/etc/resolv.conf`
lists one nameserver — the router, `192.168.68.1` — and lookups to it fail
intermittently: a `git clone` and a `curl` both died on *Could not resolve host*
mid-run, then the same name resolved 10/10 times a second later.

Nothing here was changed, because it is your network. But the collector talks to
eBay every hour, and a name that fails to resolve looks exactly like an API
outage in the logs. Adding a second resolver on the Pi is a one-line fix if it
gets annoying:

```bash
sudo nmcli connection modify "Wired connection 1" ipv4.dns "192.168.68.1 1.1.1.1"
sudo nmcli connection up "Wired connection 1"
```

## 2. Clone just this folder

The Superalgos repo is ~630 MB of history and 6,600 files; Coin Market is 47 of
them. A sparse shallow clone gets you **2 MB**.

**A note on shells.** Commands that run *on the Pi* are bash, always. Commands
you run on your own machine depend on what you use. Both are given below —
mixing them up is a real trap, because `\` line continuations and `&&` are bash
constructs that Windows PowerShell 5.1 rejects outright.

### macOS / Linux / WSL (bash)

```bash
git clone --depth 1 --filter=blob:none --sparse \
  --branch claude/ebay-lot-tracking-pricing-2cxogj \
  https://github.com/svengoranturner/Superalgos.git ~/coin-market-repo

cd ~/coin-market-repo
git sparse-checkout set Coin-Market
cd Coin-Market
```

### Windows PowerShell

No line continuations, no `&&` — one command per line. You do **not** need an
elevated prompt, and do not do this inside `C:\WINDOWS\system32`.

```powershell
cd $HOME
git clone --depth 1 --filter=blob:none --sparse --branch claude/ebay-lot-tracking-pricing-2cxogj https://github.com/svengoranturner/Superalgos.git coin-market-repo
cd coin-market-repo
git sparse-checkout set Coin-Market
cd Coin-Market
```

If you have WSL, using it instead means every bash snippet in these docs works
verbatim, and it is a closer fit for driving a Linux Pi.

To pick up later changes: `git pull` from the repo root.

## 2a. Claude Code, if you want a session driving this

Optional, but this is how the deployment is meant to be worked through — a
session on a machine that can actually reach the Pi. It is not needed to run the
tool itself.

**Windows PowerShell** (no Administrator prompt required):

```powershell
irm https://claude.ai/install.ps1 | iex
```

**macOS / Linux / WSL:**

```bash
curl -fsSL https://claude.ai/install.sh | bash
```

Reopen the terminal afterwards, then `claude --version` to confirm. Requires a
Pro, Max, Team or Enterprise account; first run opens a browser to log in.

On native Windows, having **Git for Windows** installed also gives Claude Code
the Bash tool via Git Bash instead of PowerShell only — worth having, since it
makes every bash snippet in these docs usable directly.

Then, from the `Coin-Market` directory, start it and say:
*"Read HANDOVER.md and pick this up."*

## 3. Run it — there is nothing to install

```bash
npm test          # 85 tests, no npm install needed
node bin/cli.js demo
```

`demo` builds a synthetic market and prints the analysis. If the numbers look
like the ones you saw in chat (~6.6% clearing, ~24% asks, ~17pp spread), the tool
works on your hardware.

**None of this touches the network.** The market is generated locally from a
seeded random number generator.

## 4. Look at the dashboard

The dashboard deliberately binds to `127.0.0.1` — it holds your buying
intentions and has no business being reachable from anywhere else.

On the Pi:

```bash
node bin/cli.js dashboard
```

From your laptop, tunnel to it over SSH:

```bash
ssh -L 34260:127.0.0.1:34260 stacker@192.168.68.51
```

There is already a `metalpi` host entry in the workstation's `~/.ssh/config`, so
`ssh -L 34260:127.0.0.1:34260 metalpi` does the same thing.

Then open `http://127.0.0.1:34260` in your browser. Nothing is exposed publicly
and Cloudflare is not involved.

## What comes after this

Roughly in order of how much they unlock:

1. **Point it at your real gold feed** — done, and see `SETUP.md` §7 for what
   was found. The portfolio app keeps spot in **PostgreSQL inside Docker, in GBP
   per gram**, not the SQLite file this originally assumed. Coin Market reads it
   with `psql` through the app's own compose project: still a **local** read, no
   HTTP, no domain, no Cloudflare, and the connection is opened read-only. It is
   why running on the same Pi was the right call.
2. **eBay application keys** — discovery, classification, snapshots and the
   uplift curve all work with the application token alone. See `SETUP.md`.
3. **The account-deletion endpoint** — the only piece that must be publicly
   reachable, and therefore the only one that touches Cloudflare. With a
   cloudflared tunnel it is an ingress rule plus an Access bypass for that one
   path, because eBay's challenge arrives unauthenticated.
4. **User token** — final sale prices and the watch-list mirror.
5. **Run it continuously** — systemd units and the Cloudflare tunnel recipe are
   in **[`deploy/`](deploy/README.md)**, ready to install. The units pass
   `systemd-analyze verify`; the tunnel config needs merging into your existing
   `config.yml` rather than copying blind.

Steps 1–2 give you a working tool. Steps 3–4 are what make clearing premiums
possible.
