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
last edit: **5,617 listings**, **26 completed sales**, **179 coins judged by hand**, **4 learned
rules**, **201 tests green**. Browse spend 732 of 5,000 today; Trading 6.

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
| COL-07 | Back the Pi database up off-site | Later | S | | Local backups only. The SD card is the likeliest thing here to die |

## MKT — what the numbers mean

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| MKT-01 | Charge eBay's buyer protection fee in every premium | Done | M | | The premium reported was one nobody paid: a sale recorded at £829.12 cost its winner £852.40. Sovereign (bullion) moved 6.6% → 9.6% clearing, 37.0% → 41.4% asking |
| MKT-02 | Calibrate the fee schedule on more than one order | Now | S | | Fitted to exactly one real order; reproduces it to 5p on £829. Add orders to `OBSERVED` in `buyercost.js` and the test reports the fit |
| MKT-03 | One vote per auction in the closing-uplift curve | Done | S | | `n` counted snapshots, not auctions: 1,418 "samples" from 23 auctions, one contributing 110. Buckets now read 17/19/21/20/10 auctions |
| MKT-04 | Split the collector pool by why a coin is not ordinary | Done | M | | One bucket held a £10,000 1832 William IV beside a modern proof and reported one median. Pre-1871 alone asks **215.6%**; the three ordinary pools now sit in a coherent 37–43% band |
| MKT-05 | Spread must use the clearing median the page prints | Done | S | | The table could show `Clears at: —` beside `Spread: 40.3%` — a spread against a number it had just declined to show, off a single sale |
| MKT-06 | Report how long a listing sits before it sells | Next | S | COL-04 backfill | `medianDaysToSale` has never worked. This is the Buy-It-Now question that costs no API calls, and it may make COL-01 unnecessary |
| MKT-07 | Warn when one seller sets a coin type's asking median | Later | S | | Half Sovereign · Victoria Young Head asks 133% and one seller holds 83 of its 165 listings. A real number, but not a market |
| MKT-08 | More completed sales | Later | L | time | 26 sales, about one a day. Not code — the note is here so the thinness stays visible |
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
| UI-10 | A watchlist of coins you are hunting | Someday | M | | The tool tells you what the market is doing; it does not yet know what you want |

## OPS — repo, deploy, docs

| ID | Item | Status | Size | Blocked by | Why / evidence |
| --- | --- | --- | --- | --- | --- |
| OPS-01 | This board, generated from one source | Done | S | | `scripts/roadmap.py` reads `ROADMAP.md` and writes `ROADMAP.html`, so the board and the file cannot drift |
| OPS-02 | Every bulk write inside one transaction | Done | S | | Unwrapped, the Pi fsyncs per row: a label click took over two minutes and timed out. In a transaction the full rebuild is 3.9s and a single verdict is 56ms |
| OPS-03 | Never rank every snapshot to use one instrument's | Done | S | | `activeListings` cost 435ms per call, once per coin type — the market page took **19 seconds** and was getting worse with every sweep. Scoped first, it is 1.4s |
