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
rules**, **237 tests green**.

**Four measurement bugs found and fixed this week, three of them by the owner reading the screen.**
Bid ceilings carried a fee nobody could remove (MKT-10); completed sales carried no fee at all
(MKT-12); an instrument's gold came from whichever lot sorted first (MKT-13); and the offers panel
recommended lots that had already sold (UI-13). Every one of them was a number the tool stated
confidently and could not support.

**The tool now tracks two coins.** Morgan and Peace silver dollars sit alongside sovereigns, priced
against silver rather than gold, with their own pools, their own idea of an odd price, and their own
exclusions. Nothing about sovereigns moved: the golden fixture (OPS-04) held through every step, and
old and new code reclassified the same snapshot to byte-identical rows.

**Collection is not switched on.** The pack classifies Morgans correctly but no sweep looks for
them, so the store holds none. Turning it on is a config change and a call-budget decision.

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
| COL-08 | Price silver against silver | Done | M | | The upstream feed already carries Ag, Au, Pd and Pt - 1,004 ticks each - and `spot`'s primary key is already `(observed_at, metal)`, so there is no migration. Only the mirror is gold-only: four `'XAU'` literals and a `spotAt(whenIso)` with no metal parameter. A Morgan priced against gold reads &pound;2,544 instead of &pound;38 &mdash; a 66&times; error arriving disguised as the find of the year. `spotAt(when, metal)` defaults to gold and NEVER falls back: a metal with no ticks returns blank. Silver backfilled its own 1,011-tick history on the first run, because each metal resumes from its own high-water mark |
| COL-07 | Back the Pi database up off-site | Later | S | | Local backups only. The SD card is the likeliest thing here to die |

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
| CLS-08 | Screen listings by country, on by default | Rejected | — | | **Cost 1,268 genuine sovereigns in one pass**, 744 of them Australian — Sydney, Melbourne and Perth mint coins are British sovereigns and the scarcest part of the series. Now opt-in, with the cost of narrowing shown beside each country |
| CLS-10 | Series packs, so a second coin is not a mess | Done | L | OPS-04 | `GB.SOV` is a dotted literal at `instruments.js:62`, 8 of 13 exclusion rules carry sovereign text, and `exclusions.js:307-313` returns NOT_GOLD for any silver composition - one line that excludes every silver coin. **Extraction landed and proven a no-op**: old and new code reclassified the same 5,652 listings and produced byte-identical `instrument` (1,807), `listing_instrument` (8,513) and `review_queue` (3,834) rows. `displayName` no longer parses keys by position; exclusion rules are tagged with a series rather than moved, because `screen()` returns on first match and splitting the list would silently reorder it. **Morgan and Peace dollars are in.** Validated on 400 real eBay listings rather than invented ones, which found three defects nobody would have imagined: a 2021 `.999` centenary filing itself beside genuine Carson City dollars, sealed bulk bags filing as single coins, and the fix for that excluding "Reverse of 78" as a lot of 78 coins. Proven inert for sovereigns: old and new code reclassified one snapshot to byte-identical instrument, assignment and review rows |
| CLS-11 | Labels and rules scoped to a series | Done | M | CLS-10 | `learned.js` is binary, so it cannot say "this is a Britannia, not a sovereign". Worse, an unscoped rule on the word `britannia` would silently empty the Britannia pack the day it lands &mdash; accepted today for good reasons, discovered months later. Migration 009 rewrote **216 labels and 6 rules** exactly, none lost. Widening a rule to every coin is now a checkbox, never a default, and the rules page badges an unscoped rule in red. Uniqueness moved to `(phrase, kind, series)` so two series can rule on the same words without one silently re-scoping the other |
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
| UI-12 | Group the market page by series, and cap per series | Next | M | CLS-10 | `instruments(0,3)` is ordered by listing count and sliced to 40 GLOBALLY. 5,617 sovereign listings against a new Morgan corpus means Morgan falls off the bottom and never appears - not clutter, invisibility |

## OPS — repo, deploy, docs

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| OPS-01 | This board, generated from one source | Done | S | | `scripts/roadmap.py` reads `ROADMAP.md` and writes `ROADMAP.html`, so the board and the file cannot drift |
| OPS-02 | Every bulk write inside one transaction | Done | S | | Unwrapped, the Pi fsyncs per row: a label click took over two minutes and timed out. In a transaction the full rebuild is 3.9s and a single verdict is 56ms |
| OPS-04 | A golden fixture of every instrument key | Done | S | | The safety net the series work needed before it started. **1,807 keys, 682 real titles** stratified across every pool, denomination, review reason and known-dangerous phrasing, and **234 category paths** — 70ms. Six deliberate mutations (separator, pool threshold, negation reading, fine ounces, spaced mintmark, category screen) were each caught by the right test. Regenerate with `npm run golden <db>`; never hand-edit it |
| OPS-05 | Drop a series without losing anything | Next | S | CLS-10 | Deletes instruments and assignments; never touches listings, snapshots, outcomes or labels, which cost API calls that cannot be re-spent or human time. So a drop is reversible: re-add the pack, reclassify, and every lot comes back |
| OPS-03 | Never rank every snapshot to use one instrument's | Done | S | | `activeListings` cost 435ms per call, once per coin type — the market page took **19 seconds** and was getting worse with every sweep. Scoped first, it is 1.4s |
