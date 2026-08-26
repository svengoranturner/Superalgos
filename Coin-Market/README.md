# Coin Market

Tracks eBay coin lots, groups them by catalogue reference, and measures two
things eBay will not tell you: **what a coin is actually worth**, and **how
liquid its market is**.

Built for British gold sovereigns first, with a generic engine underneath.

## The problem it solves

Buy-It-Now sellers ask far more than auctions actually clear at, and eBay gives
you no way to see the gap. On the synthetic demo market:

```
auctions clear at  6.6% over the coin's gold content
buy-it-now asks at 24.2% over the coin's gold content
=> paying the asking price costs about £83 more per coin
```

That number — the **ask-clearing spread** — is the headline. It tells you how
much room there is under a Buy-It-Now, and where to place a bid.

## The central idea: track premium, not price

A sovereign is 0.2354 troy oz of fine gold. When gold moves 3%, every sovereign
price moves with it, so raw price history is mostly noise. Every observation is
normalised to

```
premium = total_cost / (gold_price_per_oz × fine_oz) − 1
```

A £459 sale at £1,500/oz and a £551 sale at £1,800/oz look 20% apart in price
and are both a 30% premium. Premium is the stationary quantity worth learning.

## Try it now, with no eBay account

```bash
node bin/cli.js demo         # builds a synthetic market and analyses it
node bin/cli.js dashboard    # http://127.0.0.1:34260
node bin/cli.js html         # a self-contained report you can open on a phone
npm test
```

## How it gets sold prices

This is the part that constrains everything else. As of 2026:

| Route | Status |
|---|---|
| Finding API (`findCompletedItems`) | decommissioned Feb 2025 |
| Shopping API | decommissioned Feb 2025 |
| Marketplace Insights (90 days of sold data) | restricted, closed to new developers |
| Browse API | active listings only |
| **Trading API `GetItem`** | **works on ended listings for 90 days — the only route** |

So the tool **manufactures** its own price history: it discovers auctions while
they are live, snapshots them on the way to close, then resolves the final price
afterwards inside the 90-day window. That is why it wants to run continuously,
and why the dataset compounds — it improves every week and cannot be bought.

Three eBay behaviours are enforced in code because each silently produces a
plausible-but-wrong dataset:

1. **Browse search returns Buy-It-Now listings only** unless `buyingOptions` is
   set. `searchAll()` refuses to run without it — otherwise you would build the
   exact BIN-only bias the tool exists to measure.
2. **Result sets cap at 10,000 items**, so queries are partitioned and
   truncation is reported loudly rather than silently losing listings.
3. **Bulk item lookup is Limited Release**, so snapshotting re-runs searches
   (200 listings per call) instead of hydrating lots one at a time.

## What it deliberately refuses to do

Being honest about what cannot be known is most of the value here.

- **Accepted Best Offers are excluded**, not counted at list price. eBay never
  publishes what was actually paid; treating the list price as a sale would
  systematically overstate every clearing estimate.
- **Fair value is a distribution, not a number** — p25/p50/p75 with a sample
  size and a confidence band. Thin instruments render as a wide range rather
  than false precision.
- **A gap in the gold feed withholds the premium** rather than pricing against a
  stale figure.
- **A cold-start uplift bucket projects nothing** rather than assuming lots do
  not move — otherwise week one would flag every auction as a bargain.
- **Ambiguous coins go to a review queue.** 1871–1885 Victoria sovereigns cannot
  be told apart from the date alone, so they are not guessed at.
- **It never bids.** eBay's bidding API is Limited Release and its terms target
  automated buying agents. This watches and notifies; you bid.

## Gold price

Reads the metals.dev feed your portfolio app already collects on the same Pi,
rather than polling metals.dev again. Two pollers would drift, and the portfolio
and this tool would quote different premiums for the same metal on the same day.
Point `spot.path` at the portfolio store and adjust the column names.

## Setup for live data

**See [SETUP.md](SETUP.md)** for the full walkthrough. The short version:

```bash
cp config/settings.example.json config/settings.json   # then fill it in
node bin/cli.js notify-token      # account-deletion gate (blocks production keys)
node bin/cli.js notify-endpoint   # serve it behind your reverse proxy
node bin/cli.js doctor            # check credentials and the load-bearing assumptions
node bin/cli.js run               # the continuous collector
```

`doctor` is worth running first. Its third check — whether Trading `GetItem`
works on listings you do not own — is the one the whole outcome-resolution
design rests on. If it fails, the tool falls back to the last snapshot before
close, which is less exact but still works.

### eBay credentials

1. Register at `developer.ebay.com` (~1 business day) for sandbox and production
   keysets.
2. **Production is gated** on accepting the licence addendum *and* either
   subscribing to Marketplace Account Deletion notifications or explicitly
   opting out. Opting out is the right choice here — the tool stores no
   third-party personal data (seller ids are salted-hashed on the way in).
3. An **application token** alone gets you discovery, classification, snapshots
   and the uplift curve. A **user token** adds outcome resolution and the
   watch-list mirror.

## Architecture

```
config/coins.sovereign.json     what to search for, partitioned to dodge the 10k cap
src/catalogue/                  specs, classifier, exclusion rules, instrument keys
src/ebay/                       OAuth, Browse, Trading (XML), call-budget ledger
src/spot/                       adapters onto the portfolio app's metals.dev feed
src/analytics/                  premium, robust stats, fair value, liquidity, uplift
src/collect/                    discovery, snapshotting, outcome resolution, scheduler
src/web/ src/report/            dashboard and shareable report
```

Instrument keys nest, so every metric is computed at whichever level has enough
data:

```
GB.SOV.FULL                          every full sovereign
GB.SOV.FULL.VIC_OLD                  + portrait type
GB.SOV.FULL.VIC_OLD.1900             + year
GB.SOV.FULL.VIC_OLD.1900.M           + Melbourne mint
```

"What is a sovereign worth" is answered from hundreds of sales; "what is this
1874 Melbourne worth" from four — and the tool says which it is.

## Dependencies

None. `node:sqlite` and `node:test` are built into Node 22.5+, so there is no
native build step and it drops onto a Raspberry Pi without a compiler.

## Status

The analytics, classification, storage and interfaces are complete and tested
(45 tests, `npm test`). The eBay client is written against the documented API
but has not been exercised against live credentials — run `doctor` first.
