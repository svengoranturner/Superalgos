# Handover

**Live on production eBay, fully authorised, and nothing is blocked.**
Steps 1-5 are done bar running the collector: deployed on the Pi, reading the
real gold feed, deletion endpoint validated, production keyset enabled, RuName
created and a user refresh token stored. `smoke` against production:
**9 pass, 0 fail, 1 unknown, 0 skip**.

**Both assumptions that could have forced a redesign survived.** `ItemSummary`
carries `bidCount` on 50/50 live auctions, so cheap snapshotting holds. And
`GetItem` returns final prices for listings the caller does not own, so the
outcome-resolution path — and every clearing premium built on it — stands.

The collector is **running under systemd and resolving outcomes**. One defect
found by running it is open and described under "Order of work" step 5.

This document was written for a Claude Code session on the user's laptop, which
— unlike the session that built this — is on the same LAN as the Pi. That
session has now happened; what it found is recorded below.

Read `README.md` for what the tool does and `SETUP.md` / `DEPLOY.md` for the
detailed procedures. This file is the state of play and the order of work.

`DEPLOY.md` §2a covers installing Claude Code itself, if you are reading this
before that has happened.

## Why the handover

The build happened in a cloud container with **no route to the LAN** (verified:
no interface, no default route, no path to `192.168.68.51:22`) and **an egress
policy blocking every `ebay.com` host**. So nothing had ever been run against
real eBay or real hardware. Anything still marked "unverified" is unverified for
that reason, not through carelessness.

The hardware half is settled, and eBay has now been called for real — but only
in **sandbox**, which returned zero coin listings. So all three assumptions below
still stand exactly where the build session left them. Only production can move
them.

## The user's setup

| | |
|---|---|
| Pi | `192.168.68.51`, always-on, on the LAN |
| Pi login | `stacker@192.168.68.51`, key `~/.ssh/id_metalpi`, host alias **`metalpi`** |
| Pi OS | Debian 13 (trixie), arm64, 49 GB free, Node v24.20.0 |
| Portfolio app | metalhead.gold — `metal-stack`, Docker Compose in `~/apps/metal-stack`, app + `postgres:16` |
| Public exposure | **cloudflared tunnel**, behind a Cloudflare gate |
| Gold price | paid metals.dev feed, in that Postgres, 20-minute cadence |
| Market | eBay UK (`EBAY_GB`), GBP throughout |
| eBay account | dev account approved; **sandbox** keyset live, production not yet created |
| Deletion endpoint | `https://metalhead.gold/ebay/account-deletion` — live, verified, Access-bypassed |
| User's workstation | **Windows**, PowerShell 5.1 (`&&` and `\` continuations are unavailable) |

You are most likely running on that Windows machine and driving the Pi over SSH
(`ssh metalpi` — the host entry already exists). Keep the two
straight: commands that run **on the Pi** are bash; commands on the workstation
are PowerShell unless the user is in WSL. Every code block in these docs that is
not explicitly marked `powershell` is bash, meant for the Pi.

## State

- Branch `claude/ebay-lot-tracking-pricing-2cxogj`.
- **91 tests pass**, on the workstation and on the Pi. `npm test` — no
  `npm install` needed, there are no dependencies (`node:sqlite` and `node:test`
  are built into Node 22.5+).
- **On the Pi**: Node **v24.20.0** installed under `/usr/local/lib/nodejs`
  (official arm64 tarball, checksum verified — apt only offers 20.19 and there
  was no Node at all). Sparse clone at `~/coin-market-repo/Coin-Market`, 2.0 MB.
  `npm test` and `demo` both pass there.
- The demo works end to end on the Pi: ~6.6% auction clearing vs ~24.2% BIN
  asks — a 17.6pp spread, which is the phenomenon the tool exists to measure.
- **The real gold feed is connected and mirrored.** 876 observations, 20-minute
  cadence, gold at GBP 3,372/oz. See below.
- **Production eBay is fully configured.** `config/settings.json` on the Pi
  holds the production keyset, the RuName
  `Rhys_Turner-RhysTurn-metalh-gxmycctz`, and a user refresh token good for
  ~18 months (mode 0600, gitignored), `environment: production`. `smoke`:
  **9 pass, 0 fail, 1 unknown, 0 skip**. No collector is running yet.
- **The watch list mirrors**: 200 watching, 0 bidding, 0 won, 3 lost. Those
  three lost auctions are what proved `GetItem` — ended, and not owned.
- **The call budget has real numbers at last.** Browse: **limit 5000, remaining
  5000, window 86400s**, resetting 07:00 UTC. Sandbox had only reported stub
  values (`apiName: "api name"`, a resource called `DELETE1`), so this is the
  first figure the collector's pacing can honestly be planned against.
- **`smoke-shapes.json` now holds a real ItemSummary field list** — 26 fields,
  including `bidCount`, `currentBidPrice`, `itemEndDate`, `legacyItemId`,
  `leafCategoryIds`, `seller` and `shippingOptions`, and notably **no
  `conditionDescriptors`**. That file carries no credentials and is safe to
  share.
- **Only the base OAuth scope is available.** `api_scope` is accepted;
  `buy.item.feed`, `buy.offer.auction` and `buy.item.bulk` are each refused
  with `invalid_scope` — all Limited Release, the same wall as `getItems`. The
  base scope is enough for both Trading calls, so nothing is lost. Beware how
  it fails: the **first** hop to `auth.ebay.com` redirects happily and only the
  **second** lands on `errorOauth?errorId=invalid_scope`.
- **The Pi's DNS is fixed** — see `DEPLOY.md` §1a. It was not the router: glibc's
  parallel A/AAAA queries were the cause, `getaddrinfo` failed 14/20, and
  `single-request-reopen` took it to 0/20. Persisted via netplan, survives reboot.

## Three assumptions the design rests on — one answered, two open

**Production smoke run, 2026-08-30: 7 pass, 0 fail, 1 unknown, 2 skip.** The
sandbox run before it answered nothing, as expected. Production answered
assumption 2 outright and gave real evidence on 3.

Settle these early; each has a fallback but two of them change the architecture.

1. **Does Trading `GetItem` return final prices for listings the caller does not
   own?** The entire outcome-resolution path depends on it, and therefore so does
   every clearing premium the tool reports. eBay documents it as a general
   single-item lookup, but this was never confirmed. *If it fails:* fall back to
   the last snapshot before close (already implemented behind the same
   interface in `src/collect/resolve.js`) — less exact, still usable.

   **ANSWERED — YES.** `GetItem` returned final prices for three ended
   auctions the user bid on and **lost**, so does not own:

   | item | result |
   |---|---|
   | 398300977598 | `sold=true final=64.43 bids=15 type=AUCTION` |
   | 188792465114 | `sold=true final=21.48` |
   | 257657114359 | `sold=true final=20.77` |

   The outcome-resolution path stands as designed. The
   last-snapshot-before-close fallback in `src/collect/resolve.js` stays as
   insurance, but is not needed. Every clearing premium the tool reports rests
   on this, and it holds.

2. **Does `ItemSummary` carry `bidCount` in search results?** Bulk item lookup
   (`getItems`) is Limited Release and unavailable, so snapshotting works by
   re-running searches — one call refreshes 200 listings instead of one. *If it
   fails:* snapshotting costs ~200× more and the call budget needs replanning
   from scratch.

   **ANSWERED — YES.** Production search returned **50/50 auctions carrying
   `bidCount`, and 50 carrying `currentBidPrice`**. The cheap snapshotting
   path holds and the call budget stands as designed. This was the assumption
   with the power to change the architecture; it survived.

3. **What shape do `conditionDescriptors` actually arrive in, and have they
   reached UK listings?** eBay's mandatory coin condition detail was announced
   with US dates. `src/catalogue/conditions.js` is deliberately tolerant of
   several field shapes *because this was unconfirmed* — tighten it to reality
   once seen, don't leave it guessing forever.

   **STILL UNKNOWN, but one of the two explanations is now ruled out.**
   `conditionDescriptors` were absent from **0 of 50 live search results** and
   also absent from **`getItem` on all three ended coin listings**. So it is
   not a case of search omitting what `getItem` carries — the field simply is
   not present on these UK coin listings at all.

   The likeliest remaining reading is that eBay's mandatory coin condition
   detail has not reached `EBAY_GB`. A narrower one survives too: that it
   applies only to particular categories or graded coins, none of which were
   in this sample of three ended Canadian silver pieces plus 50 live auctions.

   **Do not tighten `conditions.js`.** The tolerant reader is doing exactly the
   job it was written for, and there is still nothing real to tighten against.
   Re-check when the collector has seen a wider spread of listings.

`node bin/cli.js smoke` probes all three and reports **pass / fail / unknown /
skip** per capability. **UNKNOWN is a real verdict, not a soft pass** — sandbox
has no real coin listings, so it can prove the client is correctly built and
nothing whatsoever about the coin market. Do not report a green sandbox run as
validation of the market assumptions.

## Order of work

### 1. Deploy and prove it runs — **DONE**

Node v24.20.0 from the official arm64 tarball (apt offers 20.19; the Pi had none
at all), sparse clone at `~/coin-market-repo/Coin-Market`, tests green, `demo`
reproducing the ~17.6pp spread. `DEPLOY.md` §1 now carries the sequence that
actually worked, and §1a the DNS fault that made it need retries — since
diagnosed and fixed, so the retries should no longer be earning their keep.

### 2. Point it at the real gold feed — **DONE, and it changed the design**

The assumption was a SQLite file on disk. What is actually there:

**PostgreSQL 16, in a Docker container, in GBP per GRAM.** Database `metalstack`
in the `metal-stack` compose project at `~/apps/metal-stack`, written by
`metalstack.market.refresh` on `metalstack-spot.timer` every ~20 minutes. Three
tables:

| table | shape | span |
|---|---|---|
| `spot_price` | one live row per metal, updated in place | now |
| `spot_tick` | intraday stream, appended each refresh | **2026-08-05 →**, 875 gold rows |
| `spot_history` | one row per day, upserted for today | **1968-04-01 →**, 15,753 gold rows |

So `src/spot/spot.js` gained a **`postgres` source** alongside `sqlite`, `json`
and `http`. It shells out to `psql` through the app's own compose project rather
than adding a driver — that keeps the zero-dependency promise, and it is still a
**local** read: no HTTP, no domain, no Cloudflare, which was the whole reason
for putting this tool on the same Pi. The connection carries
`default_transaction_read_only=on`, so a bug here cannot corrupt the portfolio
app's data even though the role it connects as could. Grams are converted to
troy ounces on the way in.

`spot_tick` is what gets mirrored: it is the only series fine-grained enough to
price a lot against the moment it closed, and the 20-minute cadence sits inside
the 90-minute tolerance. `spot_history` is available behind `includeDaily`, for
the stretch *before* the ticks start — those rows are stamped at `dailyHourUtc`
and marked `metals.dev-daily`, so a premium priced off a daily close is visibly
coarser rather than passing for an intraday observation. It is **off** by
default, since eBay only reaches back 90 days anyway.

First mirror: **876 observations, 2026-08-05 → now, gold GBP 3,372/oz**,
matching the portfolio app's live figure exactly.

**How far back premium history can be reconstructed** is therefore not bounded
by spot at all — daily gold goes back to 1968. It is bounded by eBay: discovery
only sees live listings, and `GetItem` only reaches 90 days. In practice the
tool prices lots it watched close, so the series starts when the collector does.

### 3. eBay, application token only — **DONE for sandbox**

`node bin/cli.js init` — it asks for the three keys, and the Cert ID does not
echo — then `node bin/cli.js smoke`. This alone gives discovery,
classification, snapshots and the uplift curve. Sandbox first, then production.

**Never ask the user to paste keys into the chat, and never put them in the
command line for them.** Both have already gone wrong here: the original
sandbox keyset was pasted into a session transcript and had to be regenerated,
and an `init` line with placeholder text in it was then run verbatim twice,
writing a `settings.json` that looked complete. `init` prompts for exactly this
reason — the keys reach `settings.json` (gitignored, mode 0600) without passing
through a transcript, shell history, or `ps`. `config.looksUnfilled` refuses
placeholder text on either path.

The flags still exist for scripting. If you use them, you own the consequence.

### 4. The account-deletion endpoint — **DONE and verified end to end**

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

**Done on the Pi.** `coin-market-notify` is installed, enabled at boot and
listening on 127.0.0.1:34261. Its challenge response was checked against an
independently computed SHA-256 — not just against the tool's own function, which
would agree with itself even if the algorithm were wrong — and a synthetic
deletion POST returned 200 and logged `purged 0 listings`, correct for a seller
never seen. `endpointUrl` and a valid 43-character token are already in
`settings.json`.

**Done in Cloudflare too.** This tunnel is token-managed, so the route is a
dashboard entry, not a `config.yml` — `deploy/cloudflared-ingress.md` §1 now
carries the exact fields, including the two things that were not obvious: the
Path field is a **regex** (`^/ebay/account-deletion$`), and a new route is
appended **below** the `*` catch-all where it is dead until moved to position 1.

A second Access application carries a **Bypass / Everyone** policy for that one
path. The existing `MetalHead` application was not touched.

Verified from the Pi, through the public URL:

- `GET https://metalhead.gold/ebay/account-deletion` → **200**,
  `coin-market notification endpoint`
- the challenge hash matches a SHA-256 computed **independently in Python**, not
  merely the tool's own function agreeing with itself
- a deletion `POST` → **200**, logged `purged 0 listings`
- `https://metalhead.gold/` still → **302** to the Access login, so the live site
  remains gated

**Remaining, and only the user can do it — and the order is the opposite of
what you would guess.** Checked against the live portal and eBay's own guide:

1. **Create the Production keyset first**, at `developer.ebay.com/my/keys`.
   The subscription form does not exist until it does. On the **Sandbox**
   keyset's Alerts & Notifications page the Event Notification Delivery Method
   section offers only *Platform Notifications (push)* — there is no Marketplace
   Account Deletion radio at all — and with Production selected and no keyset,
   the page just says "select or create a keyset".
2. Then **Notifications** next to the production App ID →
   `developer.ebay.com/my/push?env=production` → select the **Marketplace
   Account Deletion** radio → alert email → *Save* → endpoint URL and
   verification token → *Save*, which fires the challenge immediately.

The keyset is inert until this is done. eBay: *"New third-party developers ...
must subscribe to or opt out ... before they make their first production API
call. Once the new developer's application is subscribed ... the keyset/App ID
is activated."* So the endpoint being ready first, as it now is, is the right
way round — there is simply no form to put it in until the keyset exists.

Everything eBay's guide requires, this endpoint already does, verified:
`challengeCode + verificationToken + endpoint` in that order, `application/json`,
an https URL with no localhost, and a 43-character token from their allowed
alphabet. Their guide also warns that hand-built response strings often carry a
BOM and fail — `newHandler` uses `JSON.stringify`, so that cannot happen here.

### 5. Collector running — **one open defect**

`coin-market-collector` is installed, enabled at boot and resolving outcomes.
First full loop observed: discover -> snapshot -> close -> `resolve 1/1
outcomes resolved`, recording an unsold lot at its list price with `sold=0`.

After the first hours: 2,643 listings, 4,735 snapshots, 1 outcome, 1,084
queued for review. The review queue is the exclusion rules working, not a
fault - 242 mounted or sold as jewellery, 126 year not identified, 89 portrait
ambiguous, 44 base metal or plated, 25 cased. Exactly the bias those rules
exist to keep out of clearing prices.

**Fixed: `UNIQUE constraint failed: listing.legacy_id`.** Worth reading before
touching identity in this schema again.

`legacy_id` was declared `UNIQUE`, and eBay does not guarantee that. A Browse
id is `v1|<legacyItemId>|<variationId>`, so a multi-variation listing returns
one row per variation, each with its own browse id, all sharing one legacy item
number. Confirmed live before changing anything:

    legacyItemId 327041911935 -> v1|327041911935|515924774139
                              -> v1|327041911935|515924774151

`upsertListing` only handles `ON CONFLICT(browse_id)`, so the second variation
violated a constraint the upsert could not absorb, threw, and `discover.js`
abandoned the rest of that partition.

**The cost was never the duplicate - it was everything after it in that
partition**, and the scale only became visible once fixed:

| sweep | classified | to review | errors |
|---|---|---|---|
| before | 344 | 81 | 10 |
| after | **4,992** | 1,561 | none |

Migration `003-legacy-id-is-not-unique` rebuilds the table without the
constraint; `browse_id` stays the identity and `legacy_id` keeps its index.
The live database was checkpointed and backed up first - note that a plain
copy of the `.db` is **not** a backup while a WAL file exists, which it did, at
4 MB. Row counts came through the rebuild unchanged and `integrity_check`
passed. 23 legacy ids now legitimately hold more than one browse id.

**Dropping the constraint alone would have traded one bug for a worse one.**
`pendingOutcomes` returned a row per browse id, so a multi-variation listing
would have spent a Trading call per variation and written an outcome row per
variation for a single physical sale - and every one of those would then be
counted again in the clearing statistics. It now returns one row per legacy id,
with a `NOT EXISTS` over siblings so that once any variation is resolved none
of its siblings are offered again. One sale, one outcome.

### 5a. User token — done

**`deploy/` already contains what you need** — do not write your own. Three
systemd units (verified with `systemd-analyze verify`) and
`deploy/cloudflared-ingress.md`, which covers the tunnel ingress rule, the
Access **bypass** that eBay's unauthenticated challenge requires, and the two
things that silently break validation: ingress rules match in order, and the
endpoint URL is part of the challenge hash.

The tunnel config is the one artefact written blind — merge it into the existing
`config.yml`, do not overwrite.


**A RuName is the prerequisite, and it is not yet set** — `ebay.ruName` is
still `YOUR-RUNAME`, which `auth-url` now refuses rather than printing a consent
URL eBay would reject.

Create it at **developer.ebay.com → User Tokens (eBay Sign-In)**, production
keyset, **OAuth (new security)** selected → *Get a Token from eBay via Your
Application* → **+ Add eBay Redirect URL**. eBay asks for a legal address first.

**Use `https://metalhead.gold/ebay/oauth-return` as the redirect URL.** That
route is already live and Access-bypassed (`deploy/cloudflared-ingress.md` §1a).
Do not point it at `https://metalhead.gold/`: that is Access-gated, and the
authorization code can be lost in the login bounce.

Then `node bin/cli.js init --runame=<the RuName> --force=`. Do it before any listings
are collected: `init` regenerates the seller salt, which is harmless while the
store is empty and orphans every seller hash once it is not.

`auth-url` → approve → `auth-code` gives a refresh token good for ~18 months,
which unlocks final sale prices and the watch-list mirror. This is what clears
the two SKIPs in `smoke`. Then `run` under
systemd, with `dashboard` reachable over an SSH tunnel — it binds to loopback
deliberately, since it holds the user's buying intentions.

## The bullion / collector split, and what it has not fixed yet

Done on 2026-08-30. Bullion and collector coins are now separate instruments:
`GB.SOV.BULLION.FULL` and `GB.SOV.COLLECTOR.FULL`, divided at every level, both
labelled in display names so no instrument reads as an unqualified "Sovereign".

`COINS.isBullionPool` already drew the line and nothing used it - `grep` found
one reference, the line computing it. Note the graded/slabbed columns from
migration 002 could **not** have been the mechanism: all five are empty on the
live store, because `EBAY_GB` does not supply `conditionDescriptors`. The pool
test runs off title-derived attributes, which are populated.

`reclassify` rebuilds every assignment from stored titles, so a rule change
does not leave old keys beside new ones counting the same coin twice. It
clears only derived tables; listings, snapshots and outcomes are untouched.

Two rounds of measurement, median ask over melt (melt = GBP 775):

| | bullion | collector |
|---|---|---|
| pooled, before | 62.8% (one number for both) | |
| after the split | 41.3% | 87.4% |
| after unknown-disqualifies | **37.2%** | 73.1% |

The second round: `isBullionPool` treated an unparsed year or mint as bullion,
so 621 of 1,134 bullion asks had no mint and 287 no year. A Tudor Edward VI
sovereign whose "1551-1553" never parsed sat there at GBP 20,000. Not knowing
is not evidence of ordinariness, so an unparsed attribute now disqualifies -
the rule `keyAt` already follows when it refuses an "unknown mint" bucket.

### Filtering on eBay's category ancestry, not on titles

The live-opportunities panel was offering a Royal Doulton coffee cup at a GBP
833 max bid on 99.4% edge, next to Sovereign-brand wristwatches, a sovereign
ring, an empty presentation box, a Hardy fishing reel and two copies of a book
about sovereigns. Chasing those with title regexes is chasing the last thing
that went wrong.

There is much better evidence and it arrives free on every search result: eBay
sends the whole category ancestry with names, and `normaliseSummary` was
keeping `categories[0].categoryId` and discarding the rest.

**Two allow-lists were built and measured before being applied, and both were
wrong.** The 22 sovereign-named leaves would have dropped **6,314 of 14,359
assignments**, including 2,491 genuine Australian Sydney half-sovereigns.
Widening to the whole Coins subtree still dropped them, because world coins
hang off a different root on `EBAY_GB`. Leaf ids vary by country and issue, so
no allow-list is both safe and useful - and worse, `categoryIds` also narrows
the Browse *search*, so a bad list there would have stopped those coins being
discovered at all rather than merely mislabelled. `categoryIds` stays empty
and the `categories` command was removed rather than fixed.

The ancestry has no such problem. Every real coin carries `Coins` or `Bullion`
somewhere in its chain; the cup carries Pottery, the reel Sporting Goods, the
watch Watches. Migration 004 stores the path so `reclassify` applies the same
test to rows already held, and the path travels with the exclusion reason,
because a false positive here would delete a whole class of listing and that
is what makes it diagnosable from the review queue.

Result: **1,118 listings excluded as off-category.** Books, watches,
jewellery, fishing reels and the pendant all gone.

### What is still not right

**The bullion median is 37.2% over melt and has not moved through any of this**
- which is the point. An earlier note here called that contamination on the
grounds that bullion sovereigns run 10-15%. That was the wrong comparison:
10-15% is what dealers charge, and this is what optimistic eBay sellers *ask*.
The band breakdown reads as an ordered ladder - RAW_UNSPECIFIED 35%, RAW_BU
46%, RAW_EF 51% - which is what a real market looks like. Contamination looks
like noise, not a gradient.

Three known survivors, all in genuine coin categories where ancestry cannot
help:

1. A "1937 Specimen 4 GOLD COIN Proof Sovereign" Royal Mint set, listed under
   `Supplies/Equipment > Coins > Coins`. Possibly the box rather than the coins.
2. A "Commorative Gold Sovereign" for the Battle of the Somme, in Gold Bullion.
   A medal sold as a sovereign; excluding it generically would also exclude
   legitimate commemorative sovereigns.
3. Genuine rare dates - Victoria 1874 London shields at GBP 10,000-16,000, a
   1917 London at GBP 15,087 - which satisfy every attribute rule there is.
   Rare *dates* need either a price-outlier test or real numismatic data.

Item 3 is the reason a median may be the wrong summary at all. The honest
alternative is to report the distribution, so a bimodal market looks bimodal
rather than averaging into a figure describing neither half.

**The clearing side is still empty.** Only two auctions have resolved, so the
dashboard correctly says no instrument has enough sales yet. The ask figure
only means something beside what auctions actually clear at, and that arrives
as watched lots close.

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

The user is tracking this conversationally, not by reading diffs. Still useful,
once step 3 has happened:

- the full `smoke` output, plus `smoke-shapes.json` — the actual eBay response
  field names, which is what lets the tolerant readers be tightened. That file
  contains no credentials.
- which of the three assumptions above survived contact with production

Already answered: Node on the Pi (there was none; v24.20.0 now), whether step 1
worked (yes), and the portfolio app's spot store and its depth (see step 2).
