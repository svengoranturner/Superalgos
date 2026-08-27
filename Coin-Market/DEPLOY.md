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
Raspberry Pi OS still ships 18 or 20 through `apt`, so this often fails.

```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

If you skip this, the CLI stops with these instructions rather than a cryptic
missing-module error.

## 2. Clone just this folder

The Superalgos repo is ~630 MB of history and 6,600 files; Coin Market is 47 of
them. A sparse shallow clone gets you **2 MB**:

```bash
git clone --depth 1 --filter=blob:none --sparse \
  --branch claude/ebay-lot-tracking-pricing-2cxogj \
  https://github.com/svengoranturner/Superalgos.git ~/coin-market-repo

cd ~/coin-market-repo
git sparse-checkout set Coin-Market
cd Coin-Market
```

To pick up later changes: `git pull` from `~/coin-market-repo`.

## 3. Run it — there is nothing to install

```bash
npm test          # 72 tests, no npm install needed
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
ssh -L 34260:127.0.0.1:34260 pi@<your-pi>
```

Then open `http://127.0.0.1:34260` in your browser. Nothing is exposed publicly
and Cloudflare is not involved.

## What comes after this

Roughly in order of how much they unlock:

1. **Point it at your real gold feed** — `spot.path` at the portfolio app's
   database. Coin Market reads that file **off local disk**; no HTTP, no domain,
   no Cloudflare. It is why running on the same Pi was the right call.
2. **eBay application keys** — discovery, classification, snapshots and the
   uplift curve all work with the application token alone. See `SETUP.md`.
3. **The account-deletion endpoint** — the only piece that must be publicly
   reachable, and therefore the only one that touches Cloudflare. With a
   cloudflared tunnel it is an ingress rule plus an Access bypass for that one
   path, because eBay's challenge arrives unauthenticated.
4. **User token** — final sale prices and the watch-list mirror.
5. **Run it continuously** — `node bin/cli.js run`, under systemd.

Steps 1–2 give you a working tool. Steps 3–4 are what make clearing premiums
possible.
