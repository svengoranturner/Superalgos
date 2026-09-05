# ROADMAP — what is being built, and in what order

**This file is the status board. [HANDOVER.md](HANDOVER.md) is the archive of *why*.**

Every item has a stable code. Point at one and any session can find it:

```
grep -n 'COL-01' ROADMAP.md
```

- **IDs are permanent.** Never reused, never renumbered. A dropped item becomes `Rejected`, not a gap.
- **One line per item.** The reasoning, the measurements and the post-mortems stay in `HANDOVER.md`.
- **Status**: `Now` (this wave) · `Next` (the wave after) · `Later` (agreed, unscheduled) ·
  `Someday` (idea, undecided) · `Done` · `Rejected` (decided against — read the reason first).
- **Size**: `S` hours · `M` a day or two · `L` a week or more.
- **No item without a number.** If there is no measurement behind it, it is not on the list.

`scripts/roadmap.py` reads this file and writes `ROADMAP.html`, which is the published board. Edit
here, run the script, republish. The two cannot drift.

---

## Where things stand — 2026-08-31

Live on the Pi, collecting from production eBay UK. Counted from the store, not quoted from the
last edit: **5,652 listings**, **26 completed sales**, **216 coins judged by hand**, **6 learned
rules**, **246 tests green**.

**Four measurement bugs found and fixed this week, three of them by the owner reading the screen.**
Bid ceilings carried a fee nobody could remove (MKT-10); completed sales carried no fee at all
(MKT-12); an instrument's gold came from whichever lot sorted first (MKT-13); and the offers panel
recommended lots that had already sold (UI-13). Every one of them was a number the tool stated
confidently and could not support.

**The tool now tracks two coins.** Morgan and Peace silver dollars sit alongside sovereigns, priced
against silver rather than gold, with their own pools, their own idea of an odd price, and their own
exclusions. Nothing about sovereigns moved: the golden fixture (OPS-04) held through every step, and
old and new code reclassified the same snapshot to byte-identical rows.

**Both coins are being collected.** Morgan and Peace dollars have been sweeping since 31 Aug. The
review queue is filtered to one coin at a time with every group's count on its tabs, so the two piles
never mix.

**The country filter stays on.** Collection immediately showed what it costs a silver series — 822 UK
Morgans against 6,321 US ones the tool cannot price — and the owner has decided to keep it: no history
of buying from the US, no appetite for the import risk, and UK silver carries 20% VAT where gold
carries none. So the tool tracks the UK silver-dollar market, which is the one that can be bought
from. COL-09 records it.

**One dependency gates a disproportionate share of everything below: completed sales.** The tool
gains about one a day, and every clearing figure rests on them. Six of the ten coin types now show
no clearing price at all — correctly, because they have fewer than three sales each. That is not a
bug to fix, it is a wait.

**The second gate is Buy-It-Now outcomes, and it is structural.** 94% of the live market is
Buy-It-Now and not one of its outcomes has ever been observed, because a BIN listing carries no end
time and the resolution queue only accepts listings whose end time has passed. `COL-01` is the fix
and it is deliberately parked — see the row.

---

## COL — collector, eBay API, call budget

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| COL-01 | Resolve Buy-It-Now outcomes so sell-through is knowable | Next | L | COL-02, one clean week | **Would NOT give BIN clearing prices** — the tool refuses those by design (`market.js:92` filters `saleType === 'AUCTION'`). It gives BIN **sell-through**, currently unknown for 94% of the market. Gated trigger ~79–160 calls/day; the naive "absent from one sweep" trigger costs ~2,030/day and is right 25% of the time, because 73.6% of apparent departures are eBay rotating one dealer's identical variation listings |
| COL-02 | Find out eBay's real Trading GetItem allowance | Now | S | | One call. `smoke.js` already hits the rate-limit endpoint and throws away everything except the Browse entry. Until then COL-01 is costed against an assumption |
| COL-03 | Cap Trading spend | Done | S | | Nothing capped it: `browse.js:37` held the **only** `allows()` call in the codebase and every Trading site merely `record()`ed after the fact. Harmless at a few calls a day, not harmless for anything scaling with the corpus |
| COL-04 | Keep `itemCreationDate` as the listing start date | Done | S | | eBay sends it on every summary and it was discarded, so `start_time` was NULL on all 5,516 rows — which silently disabled `medianDaysToSale`. Backfills on the conflict path too, or only new listings would ever have got one |
| COL-05 | Capture item location, and filter at the query | Done | S | | `itemLocationCountry` on the search makes it genuinely cheaper — a Browse call returns 200 listings, so a third fewer results is a third fewer calls |
| COL-06 | Refresh cadence: sweep 60m, ending-soon 5m, resolve 30m | Done | S | | Measured: 10 new listings an hour, 5,163 of 5,509 refreshed within the hour, 286 closing lots watched every 5 minutes |
| COL-08 | Price silver against silver | Done | M | | The upstream feed already carries Ag, Au, Pd and Pt - 1,004 ticks each - and `spot`'s primary key is already `(observed_at, metal)`, so there is no migration. Only the mirror is gold-only: four `'XAU'` literals and a `spotAt(whenIso)` with no metal parameter. A Morgan priced against gold reads £2,544 instead of £38 — a 66× error arriving disguised as the find of the year. `spotAt(when, metal)` defaults to gold and NEVER falls back: a metal with no ticks returns blank. Silver backfilled its own 1,011-tick history on the first run, because each metal resumes from its own high-water mark |
| COL-10 | The country filter leaked on the five-minute poller | Done | S | | `endingSoon` built its own Browse filter and left the country restriction out, so the poller fetched lots the owner cannot buy every five minutes, for every series. Surfaced when Morgan collection pulled **3,664 US listings into a UK-only store within the hour**, but it had been leaking on the sovereign side all along — it is where the 993 Australian rows in the review queue came from. `allowedCountries` is also a function now: the comment promised it was re-read each sweep and the code snapshotted it at construction, so a country chosen on the dashboard sat unapplied until a restart |
| COL-07 | Back the Pi database up off-site | Later | S | | Local backups only. The SD card is the likeliest thing here to die |
| COL-10 | Ask eBay for watch counts | Blocked | S | eBay approval | **Only the owner can unblock this: it is an application to eBay, not a code change.** The owner is right that anyone can see the watcher count on a listing page - I said it could not be had, and that was wrong. `watchCount` EXISTS in the Browse API; it is a restricted field, and eBay's answer is "you must request an application growth check if you want to use restricted API or get the access for restricted field in Production", adding a note to the App Check ticket saying you want Watch Count data in the Browse API. This account does not have it today, proven rather than assumed: `smoke-shapes.json` records the 26 fields eBay actually returned on an ItemSummary on 30 Aug and no watch or view field is among them. What makes it worth asking for: it would ride along on the `item_summary/search` calls the sweep already makes, so it costs **nothing** against the 5,000/day budget - and because those sweeps are hourly it would arrive as a watcher count PER SNAPSHOT, which is watcher growth over time rather than one number. That is a far better answer to MKT-15's question than the opening price is, and it does not need MKT-14's backfill to become useful |

## MKT — what the numbers mean

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| MKT-01 | Charge eBay's buyer protection fee in every premium | Done | M | | The premium reported was one nobody paid: a sale recorded at £829.12 cost its winner £852.40. Sovereign (bullion) moved 6.6% → 9.6% clearing, 37.0% → 41.4% asking |
| MKT-02 | Calibrate the fee schedule on more than one order | Done | S | | Fitted to one order it was 5p over on that one **and 5p over on the second** - a constant offset, which one observation cannot tell from a good fit. At `fixed: 0.70` both reproduce exactly with a round 2%. Two orders £7 apart still cannot separate the fixed term from the rate; a cheap order would |
| MKT-12 | Charge the fee on completed sales too | Done | S | | The owner found it: a 1968 sovereign that cost its winner £845.40 was reported at £822.25 and **6.2%** over spot when the true figure is **9.1%**. The sold table did its own arithmetic and never went through `totalCost()` - MKT-01's error surviving in the one place that skipped the choke point MKT-01 created. It also priced every sale against TODAY'S gold rather than the gold when the lot closed |
| MKT-13 | One coin's gold, never one lot's | Done | S | | The instrument's fine ounces came from `active[0].fineOz`, which is `fine_oz × quantity` - a LOT's gold. A nine-coin set was due at the front of `GB.SOV.UNATTRIBUTED.HALF` on 03 Sep and would have multiplied that key's bid ceiling by nine. CLS-07 kept lot size off the shared instrument row for exactly this reason; the read path had to learn it too |
| MKT-03 | One vote per auction in the closing-uplift curve | Done | S | | `n` counted snapshots, not auctions: 1,418 "samples" from 23 auctions, one contributing 110. Buckets now read 17/19/21/20/10 auctions |
| MKT-04 | Split the collector pool by why a coin is not ordinary | Done | M | | One bucket held a £10,000 1832 William IV beside a modern proof and reported one median. Pre-1871 alone asks **215.6%**; the three ordinary pools now sit in a coherent 37–43% band |
| MKT-05 | Spread must use the clearing median the page prints | Done | S | | The table could show `Clears at: —` beside `Spread: 40.3%` — a spread against a number it had just declined to show, off a single sale |
| MKT-06 | Report how long a listing sits before it sells | Next | S | COL-04 backfill | `medianDaysToSale` has never worked. This is the Buy-It-Now question that costs no API calls, and it may make COL-01 unnecessary |
| MKT-07 | Warn when one seller sets a coin type's asking median | Later | S | | Half Sovereign · Victoria Young Head asks 133% and one seller holds 83 of its 165 listings. A real number, but not a market |
| MKT-08 | More completed sales | Later | L | time | 26 sales, about one a day. Not code — the note is here so the thinness stays visible |
| MKT-10 | Quote the bid ceiling without the fee eBay adds on top | Done | S | | Fair value is fitted from `totalCost`, which charges the buyer fee, so a ceiling built from one is an all-in figure - but eBay levies the fee ON TOP of a bid. Every "Bid up to", max bid and suggested offer was 2.4% high on a GBP 2,000 lot and 5.6% on a GBP 50 one. `priceForCost()` is the inverse; the three live ceilings each dropped about GBP 23 |
| MKT-11 | Buy-It-Now lots whose seller will take an offer | Done | S | MKT-10 | A Best Offer lot asks a median **33.0pp** over clearing against 31.8pp for a rigid one - the button signals willingness to haggle, not a keener price, so a rule waiting for the ask to fall below the ceiling never fires. Fires on the gap instead, capped at a quarter over. 87 in reach today, of 2,600 live Best Offer lots |
| MKT-14 | See an auction when it OPENS, not when it is ending | Done | S | | Prerequisite for MKT-15, and the tool currently cannot do it. Measured over 1,637 auctions: the median gap between a seller listing one and this tool first seeing it is **87.8 hours** — more than half of a 7-day auction — and only 5% are seen within an hour. Even for lots listed in the last two days it is 17.6h, because a fresh auction sits deep in search results and surfaces only as it nears its end. The fix is one partition sorted `newlyListed`, which `buildQueries` already supports; Fixed with one partition per series sorted `newlyListed`, unbanded and capped at a single page: **two extra calls an hour** for the 200 newest auctions, against roughly ten new sovereigns an hour. Live 31 Aug — it produces evidence only for auctions listed from now on, which is why it went in early |
| MKT-15 | Where to set a reserve: opening price against bids and final price | Next | M | MKT-14, MKT-08 | The owner's question, and the one that matters for SELLING: does opening low actually draw more bids and a higher hammer than opening near the expected price? 50 resolved auctions today, all with a first snapshot — but that snapshot is the price when we first SAW the lot, not what it opened at, and every open/final ratio sits between 0.94 and 1.03, which is the signature of already-bid-up lots rather than a finding. Needs MKT-14 before the question can be asked at all, then time for the auctions to run |
| MKT-09 | Auction alerts fire only inside the last 120 minutes | Later | S | MKT-08 | Which is why none has ever fired. Widening it needs the uplift curve to know the 3-day and long buckets, and both are at zero auctions |

## CLS — what counts as a sovereign

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| CLS-01 | Human labels, and rules learned from them | Done | L | | Every exclusion rule is a guess made from outside the market. 179 coins judged, 4 rules accepted. A rule that would remove priced coins goes behind a confirmation page naming them — `george` would have stopped pricing 414 lots from one click |
| CLS-02 | Strip punctuation before reading a denomination | Done | S | | Fixed three times by widening an allowed-character list — brackets, commas, then asterisks and hashes. `*HALF* SOVEREIGN` was priced against a full sovereign's gold and showed a 19% edge that did not exist |
| CLS-03 | Read negations and packaging as what they are | Done | S | | Of 23 completed sales only 14 were counted. Three that fetched £809, £829 and £861 said *"Never Cleaned Or Mounted"*; two more said *"in Capsule"* |
| CLS-04 | Read a spaced mintmark — `1919 P` as well as `1887S` | Done | S | | 52 listings had an unread mint for want of a space in the pattern. A coin whose mint goes unread lands in the wrong pool for the wrong reason |
| CLS-05 | The multi-weight sovereigns — £2, £5, piedfort | Done | S | | Nine seller phrasings fell through to FULL; 87 lots were priced against a half or a fifth of their actual gold, and a £9,654 five-sovereign piece read 1146% over spot |
| CLS-06 | Novelty copies and pick-your-coin listings | Done | S | | "Gold-Coloured Sovereign Style Coins (10pcs)" and "CHOOSE YOUR COIN" both reached the live opportunities panel. 20 variation listings caught |
| CLS-07 | Let a multi-coin lot be admitted at its own gold | Done | M | | The lot size rides on the assignment, not the instrument — writing it to the shared instrument row would have redefined the spot value for every coin filed under the same key |
| COL-09 | The country filter costs a gold series little and a silver one everything | Rejected | S | | **A decision, not a bug.** With the filter on `[GB]`, the store holds **822 UK Morgans (738 priced) against 6,321 US ones (0 priced)** — it excludes 88% of the market for an American coin. **Decided 31 Aug: keep it.** The owner has never bought from the US, does not want the import risk in the current climate, and UK gold coins are VAT-exempt where silver is not — so importing silver would carry 20% plus handling on top. The tool therefore tracks the UK silver-dollar market, which is the one that can actually be bought from. Recorded rather than left open so it is not re-argued; per-series country settings would be the reopening, not this row |
| CLS-08 | Screen listings by country, on by default | Rejected | — | | **Cost 1,268 genuine sovereigns in one pass**, 744 of them Australian — Sydney, Melbourne and Perth mint coins are British sovereigns and the scarcest part of the series. Now opt-in, with the cost of narrowing shown beside each country |
| CLS-10 | Series packs, so a second coin is not a mess | Done | L | OPS-04 | `GB.SOV` is a dotted literal at `instruments.js:62`, 8 of 13 exclusion rules carry sovereign text, and `exclusions.js:307-313` returns NOT_GOLD for any silver composition - one line that excludes every silver coin. **Extraction landed and proven a no-op**: old and new code reclassified the same 5,652 listings and produced byte-identical `instrument` (1,807), `listing_instrument` (8,513) and `review_queue` (3,834) rows. `displayName` no longer parses keys by position; exclusion rules are tagged with a series rather than moved, because `screen()` returns on first match and splitting the list would silently reorder it. **Morgan and Peace dollars are in.** Validated on 400 real eBay listings rather than invented ones, which found three defects nobody would have imagined: a 2021 `.999` centenary filing itself beside genuine Carson City dollars, sealed bulk bags filing as single coins, and the fix for that excluding "Reverse of 78" as a lot of 78 coins. Proven inert for sovereigns: old and new code reclassified one snapshot to byte-identical instrument, assignment and review rows |
| CLS-11 | Labels and rules scoped to a series | Done | M | CLS-10 | `learned.js` is binary, so it cannot say "this is a Britannia, not a sovereign". Worse, an unscoped rule on the word `britannia` would silently empty the Britannia pack the day it lands — accepted today for good reasons, discovered months later. Migration 009 rewrote **216 labels and 6 rules** exactly, none lost. Widening a rule to every coin is now a checkbox, never a default, and the rules page badges an unscoped rule in red. Uniqueness moved to `(phrase, kind, series)` so two series can rule on the same words without one silently re-scoping the other |
| CLS-12 | Item aspects are collected and never read | Next | S | | `EXCLUSIONS.screen(title, aspects)` has exactly one caller and is **always passed null** — neither `discover.js:113` nor `reclassify.js` passes aspects. So the `aspect` table (549 rows) is written and purged but never read, and every aspect-driven rule is dead code, including the composition check at `exclusions.js:306-313`. This corrects the premise of CLS-10: that line does **not** currently exclude every silver coin, because it never runs. Either wire aspects in or stop storing them |
| CLS-09 | Read the grade from the photograph | Someday | L | | The thumbnails are more instructive than the titles. Whether that is automatable here is an open question, not a plan |

## UI — the dashboard

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| UI-01 | Opportunities are live auctions at or near spot | Done | M | | The old definition needed a projected final price, a sufficient fair value and a bid ceiling, inside the last two hours — so **no auction alert ever fired**, while the panel filled with Buy-It-Now lots sitting under a contaminated median. 37 real auctions now qualify out of 217 checked |
| UI-02 | Exclude and learn from the opportunities panel | Done | S | | So a wrong listing is dismissed where it is noticed, not on another page |
| UI-03 | The picture on every page that lists a lot | Done | S | | Click to enlarge, opening below the row so it never covers the title. 546 rows load 22 thumbnails and one large image |
| UI-04 | Tick down the left, then one decision | Done | M | | A cull is one pass; a batch accept reads each row's own denomination and quantity |
| UI-05 | Filter by auction or Buy-It-Now | Done | S | | On the review queue and the drill-down. A live lot is judged on how it is offered, a completed one on how it actually sold |
| UI-06 | Show what the tracked market is made of | Done | S | | And show the hole: the Buy-It-Now outcome bar is hatched and labelled *not observed*, because a zero sell-through would be a lie |
| UI-07 | Reach the listings behind any market number | Done | M | | 2,740 of 3,447 live priced listings had no review-queue row — they classified confidently and wrongly, so this page is the only route to them |
| UI-08 | Every column carries its definition | Done | S | | Several are not what they look like: Asks is fixed-price only, Live counts auctions too, Bids excludes auctions that got none |
| UI-09 | Say "spot", never "melt" | Done | S | | Melt in the UK is scrap, and scrap pays **under** spot. The tool measures gold content at spot, so the word was wrong |
| UI-13 | Never send you to a lot that has gone | Done | M | | The offers panel's top suggestion had not been seen for 21.3 hours and had already sold. A Buy-It-Now lot has no end time and its outcome is never resolved (COL-01), so `last_seen` is the only evidence it exists - and nothing selected the column, so no surface could even see it. Two hours, measured from the **last sweep** not the clock: 88.6% of long gaps in this store begin at one collector outage, and a clock rule would have blanked the panels over that |
| UI-14 | Put the market page back in reach | Done | M | | Eight sections, 55 lot rows, and the two panels worth acting on were **67.7% of the page** - stacked, so the offers heading sat 4,855px down and was reached by text search. Capped to 10 and 8 with the rest folded inside the same form, evidence collapsed, sticky jump bar. Page 11,144px → 4,261px; offers 4,855px → 1,907px |
| UI-10 | A watchlist of coins you are hunting | Next | M | | The tool tells you what the market is doing; it does not yet know what you want. Ships as two kinds - a specific coin type, and a coin type under a price - because collection gaps need mintmark-level holdings and MetalHead does not record a mintmark |
| UI-11 | Live auctions ending soonest first | Done | S | | The % of spot badge already says what a lot is worth; the ordering should say how long you have to act. `liveAuctions` had no test at all, so the ordering it now guarantees was unpinned |
| UI-12 | Group the market page by series, and cap per series | Done | M | CLS-10 | `instruments(0,3)` is ordered by listing count and sliced to 40 GLOBALLY. Measured on a seeded two-series copy of 566 qualifying instruments, the old cap gave the second series **7 of its 40 rows** against the first's 33 — squeezed rather than invisible at 347 listings, and approaching invisible as a new series starts smaller. Each series now has its own block, cap, instrument table and composition chart, and states how many it left out. The headline metric names its own metal |
| UI-16 | Make the slow pages fast | Done | M | | `/review` **2.81s → 0.24s**, `/` 3.45s → 2.49s, `/listings` 0.36s → 0.19s, measured on the Pi against a copy of the live store and interleaved with the old build. Four queries asked for the newest snapshot per listing by ranking every snapshot with `ROW_NUMBER() OVER (PARTITION BY browse_id ORDER BY observed_at DESC)`; `reviewQueue` did it over 330,266 snapshots to answer a question about the 682 rows one tab shows. They seek to `MAX(observed_at)` instead — `listing_snapshot` is WITHOUT ROWID on PRIMARY KEY `(browse_id, observed_at)`, so that key IS the index and the same key makes a duplicate match impossible. Four things were measured and rejected: a dedicated index (22MB for 6ms — the primary key already serves it), a scope CTE (helped scoped, **hurt** unscoped), batching `activeListings` across keys (804ms per-key vs 1,497ms batched), and collapsing `marketComposition` (works, ~180ms on a 2,500ms page) |
| UI-17 | Cap the market page by sales | Rejected | M | | The remaining 1,230ms on `/` is `forInstrument` × 80, and only **8 of those 80 keys** have the ≥3 sales needed to say anything — so capping harder looks free. It is not, and the guard the plan proposed does not fix it. **The composition chart is the worst case**: its scope is chosen by `seriesBlocks.length` (`server.js:218`), so a cut that empties one of two blocks drops the length to 1 and renders the survivor with the **store-wide** composition — the other series' listings silently folded into a per-series figure. Block *order* is `entries.length` (`server.js:150`), which decides which key the headline lands on, so retaining every key with sales is not sufficient. `censored` and `spotGaps` (`server.js:449-450`) are summed over survivors and printed as facts, so a deeper cut understates them silently. "N of M tracked types" (`server.js:370`) and "Every tracked coin type" (`server.js:574`) would state a cap as a corpus. And the guard itself does not exist: `saleCountsForInstrument` counts **listings**, not sales, and `instruments()` orders by a lifetime listing count uncorrelated with having any. Worth doing only alongside fixing those six numbers |

## OPS — repo, deploy, docs

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| OPS-01 | This board, generated from one source | Done | S | | `scripts/roadmap.py` reads `ROADMAP.md` and writes `ROADMAP.html`, so the board and the file cannot drift |
| OPS-02 | Every bulk write inside one transaction | Done | S | | Unwrapped, the Pi fsyncs per row: a label click took over two minutes and timed out. In a transaction the full rebuild is 3.9s and a single verdict is 56ms |
| OPS-06 | Ask every page for itself, once | Done | S | | Nothing tested the pages, and two defects reached the owner because of it: an offers panel whose every row lost its checkbox and verdict buttons, and a market page that 500'd on every request after a rename. The suite now starts the real server on an ephemeral port and fetches each page. Both bugs were reintroduced to confirm each fails the test that describes it |
| OPS-04 | A golden fixture of every instrument key | Done | S | | The safety net the series work needed before it started. **1,807 keys, 682 real titles** stratified across every pool, denomination, review reason and known-dangerous phrasing, and **234 category paths** — 70ms. Six deliberate mutations (separator, pool threshold, negation reading, fine ounces, spaced mintmark, category screen) were each caught by the right test. Regenerate with `npm run golden <db>`; never hand-edit it |
| OPS-05 | Drop a series without losing anything | Next | S | CLS-10 | Deletes instruments and assignments; never touches listings, snapshots, outcomes or labels, which cost API calls that cannot be re-spent or human time. So a drop is reversible: re-add the pack, reclassify, and every lot comes back |
| OPS-03 | Never rank every snapshot to use one instrument's | Done | S | | `activeListings` cost 435ms per call, once per coin type — the market page took **19 seconds** and was getting worse with every sweep. Scoped first, it is 1.4s |
