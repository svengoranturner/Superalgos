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

## Parser gaps found by reading the dashboard against real listings

The review queue and the opportunities panel are the tool's own diagnostics,
and reading them turned up two faults worth more than any amount of staring at
the code.

**The mint letter glued to the year.** The year pattern ended in a word
boundary and "1887S" has none, because S is a word character. Every listing in
that dealer form lost its year *and* its mintmark - most of the "Year
identified" failures, and also why branch-mint coins were failing the bullion
test for the wrong reason. The mintmark is now read from the same match, so a
letter counts as a mint only when attached to a plausible year, and is still
rejected if that mint was not striking then. "Year not identified" fell to 88.

**The hyphenated quarter, which was the expensive one.** The denomination
patterns required "quarter" and "sovereign" to be adjacent, so
"Quarter-Sovereign" and "Quarter 2g Sovereign" fell through to FULL - pricing a
quarter against a full sovereign's 7.99g of gold and manufacturing a 75%
discount out of nothing. Those were live entries in the opportunities panel.
100 assignments now sit on QUARTER keys; two remain mis-keyed and both titles
genuinely say both words.

### What the review queue says now

| reason | n |
|---|---|
| Portrait type ambiguous for that year | 459 |
| Denomination not identified | 244 |
| Low confidence | 148 |
| Year not identified | 88 |

The top entry is honest ambiguity rather than a bug: between 1871 and 1885 a
title alone cannot separate shield from St George, and those trade
differently. Most of "denomination not identified" is the eighths and tenths
being correctly refused.

## Does the price make sense? - the melt-floor verdict

`src/analytics/plausibility.js`, shown on the review page and used to filter
the opportunities panel.

Gold has a floor. A genuine sovereign cannot be offered for less than the gold
in it, because the metal alone is worth that to a scrap dealer. So a "gold
sovereign" at GBP 107 against GBP 775 of melt is not a bargain - it is
something else wearing the word, and the test does not care what the seller
called it. That makes it stronger than any title rule, and it is the honest
answer to "is this flagged listing genuine?"

Four verdicts, with the percentage of melt beside them: **below melt - not
this coin**, **priced like bullion**, **priced like a collector coin**, **far
above melt**. Where the classifier managed a best guess its denomination sets
the melt; where it did not, the quarter is used - the smallest sovereign
struck - so an "impossible" verdict is the conservative call.

**The opportunities panel drops the impossible ones and says how many.** An
edge computed against a lot that cannot be the coin claimed is arithmetic on a
category error, and it is exactly the listing that floats to the top of an
edge-ranked list, because the bigger the mismatch the better the bargain
looks. A book about sovereigns showed an 87% edge. Eight to nine lots are
hidden at any time, linked to the review page so a wrong call is findable.

**It also works as a detector of the classifier's own mistakes.** A genuine
2012 quarter sovereign came up "below melt", which is only possible if it was
measured against the wrong coin - the typographic fraction was unread and it
had fallen through to FULL. Nothing in the code review found that; the verdict
did, because a mis-denominated coin and a fake are indistinguishable from the
price side.

## Title rules for what the category ancestry cannot reach

The Marsh reference work, the Sovereign-brand sunglasses, the "*No Coins*"
empty box and the "Without Gold Sovereign's" set are all listed in genuine
coin categories, so ancestry could not touch them. Two of those slipped rules
written in the singular - "coin" not matching "Coins" - which is a cheap
mistake to keep making, and there are tests pinning the plurals now.

The fraction test refuses any 1/N below a quarter rather than a hand-listed
set, and reads the typographic forms, so 1/100 oz tokens stop being priced as
full sovereigns.

## Telling the tool what a sovereign is

The owner's own conclusion, and the right one: chasing titles has no ceiling.
They could tell at a glance that the four lots on the opportunities panel were
not sovereigns and that several coins in the review queue were genuine, and
there was nowhere to put that. Every rule in `exclusions.js` is a guess made
from outside the market by somebody who cannot do that.

So there is now a label store (`listing_label`) and a rule store
(`learned_rule`), migration 005.

- A verdict is keyed on `legacy_id`, so it survives a relist, and it outranks
  the whole pipeline **in both directions**. Confirming a coin rescues it from
  a rule that dropped it - that direction matters more, because a rule quietly
  eating genuine coins is the failure mode with no other alarm on it.
- Confirming does not mean guessing the rest. A coin marked genuine with no
  denomination stays in the queue, because melt against the wrong denomination
  is exactly how a real quarter sovereign came to read "below melt".
- Marking something *not a sovereign* then offers the rules that would
  generalise it. Phrases are stored as literal text and escaped at match time,
  never stored as patterns.
- Labels and rules are exempt from retention. Raw eBay rows roll off at 180
  days; a judgement about them is kept, or the training set evaporates on a
  cycle. `purgeExpired` names its tables and does not name these two.
- Every write reclassifies. A decision that needs a command run afterwards to
  take effect is a decision most people stop making.

**Ranking proposals by reach was wrong and shipped briefly.** The first version
offered to drop everything containing `london` - 233 matches, 97 of them
sovereigns then in the market statistics - because support was all it ranked
on, and `of`, `with` and `set` scored just as well. Support cannot separate a
good rule from a destructive one: `hardy` reaches 35 listings and breaks
nothing, because they are all fly reels. So `titleCorpus` now carries whether
each listing is currently priced, and a proposal reports how many of those it
would stop. That number is the one the person accepting it needs.

The honest limit: this generalises decisions, it does not infer taste. The
agreement figure on `/rules` is flattered, because a rule accepted from a label
will always reproduce that label - it only means something when it starts
covering calls it was not built from. The labels are the durable asset; a model
can be trained on them later without judging anything twice.

## Title rules the corpus justified

Measured against 5,359 live listings before being written, not guessed. Between
them these took the classified set from 4,216 to 3,919.

- **Fineness settles it without a keyword list.** A sovereign is 22ct, so 24ct
  or `.999` in a title is describing something else - 22 matches, all bars,
  Britannias or foreign proofs. The loose `999` form is deliberately absent: it
  matches mintage figures ("Mintage 999") and would have deleted two genuine
  sovereigns.
- **There is no Edward VIII sovereign.** He abdicated before any circulating
  coinage; the 1937 patterns are seven-figure museum pieces. All three live
  matches were private fantasy strikes, two of them NGC-slabbed - NGC grades
  fantasy issues as readily as coins, so the slab is no evidence at all.
- Rings, watches and bezels (55), Hardy fly reels (27), spelled-out coin counts
  (28), sub-quarter fractions (94 - previously stuck in the queue forever with
  no denomination and no reason given).
- **"Sovereign Half"** was priced against a full sovereign's gold. Same defect
  as the quarter, one word order along. `Qtr` too, which is the Royal Mint's own
  abbreviation on its listing titles.

Two of my own regexes were wrong and the corpus caught both: `` before `\.`
never matches after a space, so `.9999` was silently missed while `0.999`
worked; and an unbounded `1/N` read "Limited Edition 1/50" as a denomination.

A **weight rule was measured and rejected.** Sellers quote AGW - fine gold
weight, 7.32g for a full sovereign - as often as gross, and a rule that knew
only gross would have deleted genuine Royal Mint proofs. Corrected for both
conventions it still leaves genuine coins with sloppy weights ("George V 1912
10g gold"), so a stated weight that matches no sovereign is worth surfacing but
not excluding on.

## Working the queue: layout, preview, and reaching a bad number

The owner was scrolling sideways to read the review queue, could not preview a
listing without opening a tab, and could see wrong listings on the market page
with no way to dismiss them.

**The queue is a list, not a table.** Titles run to 84 characters and the
*reasons* to 170 - the reasons were the bigger driver - and the global
`table { min-width:720px }` / `td { white-space:nowrap }` are right for the
market statistics and wrong for a queue. Scoped `.q-*` classes, so the wide
statistics table keeps the horizontal scroll it needs. Verified zero document
overflow from 1440px down to 360px, with the verdict buttons at one constant x.

**No iframe preview is possible.** eBay item pages send
`X-Frame-Options: SAMEORIGIN` and no CSP at all - measured, not assumed. So the
preview is composed locally: the stored thumbnail inline, and a 340px card on
hover or keyboard focus. Swapping the `s-l225` suffix to `s-l500` works (all of
500/960/1600 do; a bogus size clamps rather than 404s).

The large image is named **only inside a delayed keyframe**, which is what
gates the download. A `transition-delay` postpones only the fade - the
background-image still applies the instant the pointer arrives, so an eye swept
down the list downloaded every image it passed. Naming it in an animation with
a 260ms delay means it is not part of the element's style until the animation
starts. Measured: sweeping past thumbnails fetches nothing, one deliberate
dwell fetches one. 550 rows load 22 thumbnails.

`<img loading="lazy">` was rejected for the preview - it never fires on a
keyboard tab-through, where a CSS background does. The trigger is the photo
rather than the whole row, which is both the gesture the page describes and a
much smaller target to cross by accident; keyboard focus anywhere in the row
still opens it.

**A market number now drills down** to the listings behind it at
`/listings?key=`, carrying the same verdict controls, with `back` so a decision
returns you where you made it rather than to the review queue. This matters
more than it sounds: **2,740 of 3,447 live priced listings have no review-queue
row at all** - they classified confidently and wrongly, so the review queue
could not reach them from any direction.

The queue itself now leads with the listings that are *making a number wrong*
- flagged as uncertain and still counted - because newest-first buried those
among 1,536 already-dropped rows shown for auditability.

## Two performance bugs, both the same shape

**A full reclassify was not in a transaction.** Every insert was its own
transaction: ~20,000 fsyncs on an SD card. A label click took over two minutes
and the HTTP request timed out. Wrapped in one transaction it is **3.9s**, and
a single verdict now calls `reclassify.one()`, which touches only that coin's
listings - **56ms**. A rule still rebuilds everything, because a rule can reach
anything.

**`activeListings` ranked every snapshot to use one instrument's.** 435ms per
call, once per coin type, so the market page took **19 seconds** and was getting
worse with every sweep. Restricting the window to the instrument's own listings
first: **1.4s**. Pre-existing, not introduced. `reviewQueue` had the same shape
and got the same fix.

## What is actually still wrong on the market page

Measured, not guessed: **318 of 3,459 live listings (9.2%)**, and it is a mix.
167 are genuine sovereigns in the wrong denomination; 151 are not a single
British sovereign at all.

The dominant single cause was `extractDenomination` requiring the multiplier
immediately before the word, so nine seller phrasings fell through to FULL -
`5 POUNDS SOVEREIGN` (the plural breaks adjacency), `GBP 5 GOLD SOVEREIGN`,
bare `5 Sovereign`, `2 SOV.`, and every piedfort. **87 lots were priced against
a half or a fifth of their actual gold**, and a GBP 9,654 five-sovereign piece
duly read 1146% over melt. Fixed; DOUBLE went 54 -> 98 live and QUINTUPLE
11 -> 36. A piedfort maps to DOUBLE deliberately: it is struck at double
thickness, so it carries a double sovereign's gold, and gold content is the
quantity this tool measures. `Type 2 Sovereign` is guarded with a lookbehind -
it is a portrait variety, not a multiplier.

**Two premiums that look wrong are not.** Sovereign / William IV asks 371% over
melt across 35 live listings, and they are genuine 1832 sovereigns at GBP 10,000.
Half Sovereign / Victoria Young Head (Shield) asks 133% - one dealer holds 83 of
its 165 listings and the median sits inside their genuine Sydney Mint stock.
Removing every judged-junk row moves it by zero. The real weakness there is that
one seller can set an instrument's median single-handedly; a seller-diversity
warning on the Asks column would say more than any data fix.

Per-instrument junk rates are wildly uneven and worth knowing before spending
effort: the HALF buckets are essentially clean (0-4%), while the modern FULL
buckets are 13-36%. That is causal - the Royal Mint only strikes the GBP 2 /
GBP 5 / piedfort variants of the *full* sovereign, and only in modern proof
ranges.

## Four things found by the owner actually using it

**A live auction opening under melt is not a fake.** Sellers routinely open
below the gold value to attract bids, and the melt floor was calling that
"below melt - not this coin". Worse, the opportunities panel tested an
auction's *current bid* against melt - the number that is low by design - so
it could suppress a genuine lot for behaving like an auction. A running
auction now has its own verdict, and the panel tests the projected final price
the alert has already computed. 45 review rows were affected.

**The melt verdict only speaks when it knows the denomination.** The quarter
fallback is a floor and a floor only works downwards: nothing under a
quarter's gold can be any sovereign. Read upwards it is nonsense - an ordinary
full sovereign measured against a quarter reads 400% and was labelled "far
above melt - rarity or error". That badge was on **1,346 of 2,674 rows**, which
is how a column stops being read. It now says "denomination unknown" instead.

**Brackets and commas broke denomination matching.** The gap class between the
word and "sovereign" was word characters, spaces, hyphens and dots - so
`1/2 (Half) Sovereign` and `quarter new design ,sovereign` fell through to
FULL and were priced against 7.99g of gold. A genuine 1980 half sovereign
proof was duly suppressed from the opportunities panel as "below melt - not
this coin": the melt floor was right, the denomination underneath it was wrong.
Found by reading what the panel was suppressing instead of trusting it.

**A stray click could have excluded 414 sovereigns.** The owner's words: "a bit
of a worry someone could exclude all sovereigns with George in the title with
an accidental click". Measured on the live corpus, `george` would indeed have
stopped pricing 414 lots, from one click.

## How a rule is accepted now

Proposals are split by what they would actually break, not merely ranked by it.

- A rule that removes **nothing** from the statistics keeps its one-click
  button.
- Anything that would stop pricing real coins goes behind a `<details>`
  disclosure *and* a confirmation page that **names the listings** rather than
  counting them. "Would stop pricing 97" is a number people click past;
  "would stop pricing 1911 Gold Sovereign George V London" is not.
- Accepting any rule lands on a banner saying what it did, with an undo button.

Measured on a plain `1911 Gold Sovereign George V London`: **zero** one-click
offers, six behind the confirmation step.

**And when the reason is not in the title, nothing is offered.** The case that
prompted this was a genuine sovereign photographed in a pendant, with no
"pendant" in the words - so every phrase on offer described the coin rather
than the fault. The page now says "nothing here generalises safely" and
explains why, instead of offering six ways to break the market.

## Item location

eBay sends `itemLocation.country` on every search summary and it was being
thrown away, so a lot in Cyprus looked exactly like one in Birmingham -
different postage, different buyer pool, different clearing price. Migration
006 adds `listing.item_country`; `screenLocation()` drops anything known to be
outside GB, and the permitted list is a parameter.

**It fails open, and that is the design.** Every row stored before the column
existed is NULL until the next sweep re-sees it, so unknown means "not known
yet" and never "foreign" - the other way round, one migration empties the
market. There is a test pinning exactly that. Costs no extra API calls; the
field was already in the response.

Rows also show how long a lot has sat unsold, which is the evidence for
"priced badly" rather than "rare".

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
