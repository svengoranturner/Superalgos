# Handover

**You are picking up a project that has been designed, built and tested, but
never deployed.** This document is written for a Claude Code session running on
the user's laptop — which, unlike the session that built this, is on the same LAN
as the Pi and can actually reach it.

Read `README.md` for what the tool does and `SETUP.md` / `DEPLOY.md` for the
detailed procedures. This file is the state of play and the order of work.

`DEPLOY.md` §2a covers installing Claude Code itself, if you are reading this
before that has happened.

## Why the handover

The build happened in a cloud container with **no route to the LAN** (verified:
no interface, no default route, no path to `192.168.68.51:22`) and **an egress
policy blocking every `ebay.com` host**. So nothing has ever been run against
real eBay or real hardware. Everything below marked "unverified" is unverified
for that reason, not through carelessness.

## The user's setup

| | |
|---|---|
| Pi | `192.168.68.51`, always-on, on the LAN |
| Portfolio app | metalhead.gold, runs on the same Pi |
| Public exposure | **cloudflared tunnel**, behind a Cloudflare gate |
| Gold price | paid metals.dev feed, stored on the Pi, ~20-minute cadence |
| Market | eBay UK (`EBAY_GB`), GBP throughout |
| eBay account | dev account approved; **sandbox** keyset exists, production not yet created |
| User's workstation | **Windows**, PowerShell 5.1 (`&&` and `\` continuations are unavailable) |

You are most likely running on that Windows machine and driving the Pi over SSH
(`ssh pi@192.168.68.51` — Windows 10/11 ships an OpenSSH client). Keep the two
straight: commands that run **on the Pi** are bash; commands on the workstation
are PowerShell unless the user is in WSL. Every code block in these docs that is
not explicitly marked `powershell` is bash, meant for the Pi.

## State

- Branch `claude/ebay-lot-tracking-pricing-2cxogj`, latest commit adds this file.
- **72 tests pass.** `npm test` — no `npm install` needed, there are no
  dependencies (`node:sqlite` and `node:test` are built into Node 22.5+).
- **Nothing is deployed and nothing is running**, anywhere.
- The demo works end to end: `node bin/cli.js demo` builds a synthetic market and
  reports ~6.6% auction clearing vs ~24% BIN asks — a ~17pp spread, which is the
  phenomenon the tool exists to measure.

## Three assumptions the design rests on, none yet verified

Settle these early; each has a fallback but two of them change the architecture.

1. **Does Trading `GetItem` return final prices for listings the caller does not
   own?** The entire outcome-resolution path depends on it, and therefore so does
   every clearing premium the tool reports. eBay documents it as a general
   single-item lookup, but this was never confirmed. *If it fails:* fall back to
   the last snapshot before close (already implemented behind the same
   interface in `src/collect/resolve.js`) — less exact, still usable.

2. **Does `ItemSummary` carry `bidCount` in search results?** Bulk item lookup
   (`getItems`) is Limited Release and unavailable, so snapshotting works by
   re-running searches — one call refreshes 200 listings instead of one. *If it
   fails:* snapshotting costs ~200× more and the call budget needs replanning
   from scratch.

3. **What shape do `conditionDescriptors` actually arrive in, and have they
   reached UK listings?** eBay's mandatory coin condition detail was announced
   with US dates. `src/catalogue/conditions.js` is deliberately tolerant of
   several field shapes *because this was unconfirmed* — tighten it to reality
   once seen, don't leave it guessing forever.

`node bin/cli.js smoke` probes all three and reports **pass / fail / unknown /
skip** per capability. **UNKNOWN is a real verdict, not a soft pass** — sandbox
has no real coin listings, so it can prove the client is correctly built and
nothing whatsoever about the coin market. Do not report a green sandbox run as
validation of the market assumptions.

## Order of work

### 1. Deploy and prove it runs (no eBay, no Cloudflare)

Follow `DEPLOY.md`. Check `node --version` **first** — the tool needs 22.5+ and
Raspberry Pi OS ships 18 or 20 via apt; the CLI refuses to start with install
instructions rather than a cryptic missing-module error. Sparse-clone just this
folder (2 MB, against the repo's ~630 MB). Then `npm test` and
`node bin/cli.js demo`.

### 2. Point it at the real gold feed

The one genuinely unknown local detail: **where the portfolio app stores its
metals.dev data, and in what schema.** Go and look — it is on the same Pi. Then
set `spot.path`, `spot.table` and `spot.columns` in `config/settings.json` and
run `node bin/cli.js spot` to mirror it.

This reads the file **off local disk**. No HTTP, no domain, no Cloudflare. That
is precisely why running on the same Pi was chosen, and it is worth not
re-litigating: two independent metals.dev pollers would drift, and the portfolio
and the coin tracker would then quote different premiums for the same metal on
the same day.

Also worth reporting back: how far the stored series goes back, since that bounds
how much premium history can be reconstructed.

### 3. eBay, application token only

`node bin/cli.js init --app-id=... --cert-id=... --dev-id=... --env=sandbox`
then `node bin/cli.js smoke`. This alone gives discovery, classification,
snapshots and the uplift curve. Sandbox first, then production.

**The sandbox keys were pasted into the previous session's chat transcript.
Regenerate them.** Production keys must never travel that way — they go straight
into `settings.json` on the Pi, which is gitignored and written at mode 0600.

### 4. The account-deletion endpoint — the only Cloudflare-facing piece

A production keyset **stays inert** until eBay's Marketplace Account Deletion
notification is either subscribed or exempted. We subscribe, and honour it for
real: seller ids are stored as salted hashes, so the hash can be recomputed from
the username or immutable id eBay sends and the matching rows genuinely purged.

With a cloudflared tunnel this is an ingress rule sending one path to
`http://localhost:34261`, plus an **Access bypass for that path** — eBay's
challenge arrives unauthenticated and Access would otherwise eat it.

Two things break validation and eBay's error message names neither: the endpoint
URL is **part of the challenge hash**, so it must match byte for byte between
`settings.json` and eBay's form (a trailing slash is enough); and the path must
not be gated. `node bin/cli.js notify-check` tests both and names the likely
cause.

### 5. User token, then run it continuously

**`deploy/` already contains what you need** — do not write your own. Three
systemd units (verified with `systemd-analyze verify`) and
`deploy/cloudflared-ingress.md`, which covers the tunnel ingress rule, the
Access **bypass** that eBay's unauthenticated challenge requires, and the two
things that silently break validation: ingress rules match in order, and the
endpoint URL is part of the challenge hash.

The tunnel config is the one artefact written blind — merge it into the existing
`config.yml`, do not overwrite.


`auth-url` → approve → `auth-code` gives a refresh token good for ~18 months,
which unlocks final sale prices and the watch-list mirror. Then `run` under
systemd, with `dashboard` reachable over an SSH tunnel — it binds to loopback
deliberately, since it holds the user's buying intentions.

## Decisions not to undo

Each of these looks like an oversight until you know why. The reasoning is in the
code comments too.

- **Premium, not price.** Every observation is normalised to premium over fine
  gold content, so a sale six months ago is comparable to today's and a half
  sovereign to a full one. Raw price history is mostly the gold price moving.
- **Accepted Best Offers are excluded as censored, not counted at list price.**
  eBay never publishes what was actually paid. Counting the list price as a sale
  is the easiest way to build a tool that confidently overstates the market.
- **Fair value is a distribution with a sample size, never a point estimate.**
  Common bullion sovereigns have hundreds of observations; a scarce branch-mint
  date has four a year. The tool says which.
- **An unlearned uplift bucket projects nothing rather than 1.0×.** Assuming no
  uplift during cold start would flag every early auction as a bargain and train
  the user to ignore alerts.
- **Unrecognised eBay condition bands go to the review queue, never a default.**
  A silent re-binning would move every grade-level premium with nothing visibly
  wrong.
- **Exclusion rules are as important as matching rules.** Mounts, copies, cases
  and multi-coin lots in the sample do not add noise — they bias clearing prices
  in a specific direction and produce confident wrong answers.
- **It never bids.** eBay's bidding API is Limited Release and their 2026 terms
  target automated buying agents. Watch-and-notify by design and necessity.

## What to report back

The user is tracking this conversationally, not by reading diffs. Useful:

- `node --version` on the Pi, and whether step 1 worked
- the portfolio app's spot store path/schema, and how far back it goes
- the full `smoke` output, plus `smoke-shapes.json` — the actual eBay response
  field names, which is what lets the tolerant readers be tightened. That file
  contains no credentials.
- which of the three assumptions above survived contact with production
