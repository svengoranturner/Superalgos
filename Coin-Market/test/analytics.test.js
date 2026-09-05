'use strict'

const test = require('node:test')
const assert = require('node:assert')

const STATS = require('../src/analytics/stats.js')
const PREMIUM = require('../src/analytics/premium.js')
const FAIRVALUE = require('../src/analytics/fairvalue.js')
const LIQUIDITY = require('../src/analytics/liquidity.js')
const UPLIFT = require('../src/analytics/uplift.js')
const COINS = require('../src/catalogue/coins.js')

const FULL_OZ = COINS.DENOMINATIONS.FULL.fineOz
const DAY_MS = 86400000

test('weighted and unweighted quantiles agree on equal weights', () => {
    /* They are one implementation now. If they ever diverge, fair value
       would shift depending on whether recency weighting is enabled -
       a bug that is hard to see and easy to trade on. */
    for (const n of [1, 2, 4, 5, 9, 20]) {
        const plain = Array.from({ length: n }, (_, i) => i + 1)
        const weighted = plain.map(value => ({ value, weight: 1 }))
        for (const q of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
            assert.ok(Math.abs(STATS.quantile(plain, q) - STATS.weightedQuantile(weighted, q)) < 1e-12,
                'n=' + n + ' q=' + q)
        }
    }
})

test('recency weighting pulls the estimate toward recent sales', () => {
    const now = Date.parse('2026-08-26T00:00:00Z')
    const observations = [
        ...Array.from({ length: 8 }, (_, i) => ({ premium: 0.20, soldAt: new Date(now - (120 + i) * DAY_MS).toISOString() })),
        ...Array.from({ length: 8 }, (_, i) => ({ premium: 0.05, soldAt: new Date(now - (1 + i) * DAY_MS).toISOString() }))
    ]
    const result = FAIRVALUE.fairValue(observations, { now, halfLifeDays: 30, windowDays: 365 })
    assert.ok(result.p50 < 0.10, 'recent cluster should dominate, got ' + result.p50)
})

test('premium is invariant to the gold price', () => {
    /* The entire reason the tool measures premium rather than price. */
    const a = PREMIUM.premium(FULL_OZ * 1500 * 1.3, FULL_OZ, 1500)
    const b = PREMIUM.premium(FULL_OZ * 1800 * 1.3, FULL_OZ, 1800)
    assert.ok(Math.abs(a - b) < 1e-12)
    assert.ok(Math.abs(a - 0.3) < 1e-12)
})

test('shipping is counted in the cost of a coin', () => {
    const withPostage = PREMIUM.premium(PREMIUM.totalCost(480, 12), FULL_OZ, 2000)
    const without = PREMIUM.premium(PREMIUM.totalCost(480, 0), FULL_OZ, 2000)
    assert.ok(withPostage > without)
})

test('premium is withheld rather than guessed when inputs are missing', () => {
    assert.strictEqual(PREMIUM.premium(500, FULL_OZ, null), null)
    assert.strictEqual(PREMIUM.premium(500, FULL_OZ, 0), null)
    assert.strictEqual(PREMIUM.premium(NaN, FULL_OZ, 2000), null)
})

test('censored Best Offers are excluded from clearing estimates', () => {
    /*
        eBay never publishes what an accepted Best Offer sold for. Counting
        the list price as a sale is the easiest way to build a tool that
        confidently overstates the market.
    */
    const now = Date.parse('2026-08-26T00:00:00Z')
    const real = Array.from({ length: 6 }, (_, i) =>
        ({ premium: 0.05, soldAt: new Date(now - (i + 1) * DAY_MS).toISOString() }))
    const withCensored = real.concat(
        Array.from({ length: 6 }, (_, i) =>
            ({ premium: 0.30, soldAt: new Date(now - (i + 1) * DAY_MS).toISOString(), censored: true })))

    const clean = FAIRVALUE.fairValue(real, { now })
    const polluted = FAIRVALUE.fairValue(withCensored, { now })

    assert.strictEqual(polluted.p50, clean.p50)
    assert.strictEqual(polluted.censored, 6)
})

test('a thin sample refuses to produce an estimate', () => {
    const now = Date.parse('2026-08-26T00:00:00Z')
    const result = FAIRVALUE.fairValue(
        [{ premium: 0.05, soldAt: new Date(now - DAY_MS).toISOString() }], { now })
    assert.strictEqual(result.sufficient, false)
    assert.strictEqual(result.p50, null)
})

test('a small sample reports a wide band rather than false precision', () => {
    const band = STATS.medianConfidenceBand([0.04, 0.09, 0.06])
    assert.strictEqual(band.wide, true)
    assert.ok(band.high - band.low > 0.03)
})

test('bid ceiling sits below the median when buying under the market', () => {
    const now = Date.parse('2026-08-26T00:00:00Z')
    const observations = Array.from({ length: 20 }, (_, i) =>
        ({ premium: 0.03 + i * 0.005, soldAt: new Date(now - (i + 1) * DAY_MS).toISOString() }))
    const fair = FAIRVALUE.fairValue(observations, { now })
    const ceiling = FAIRVALUE.bidCeiling(fair, { fineOz: FULL_OZ, spotGbpPerOz: 2000, shipping: 5, targetQuantile: 0.35 })

    assert.ok(ceiling.targetPremium < fair.p50)
    assert.ok(ceiling.maxBid < ceiling.allInValue)
    assert.ok(ceiling.allInValue > ceiling.goldValueAtSpot)
})

test('the ask-clearing spread measures seller optimism', () => {
    const now = Date.parse('2026-08-26T00:00:00Z')
    const outcomes = Array.from({ length: 10 }, (_, i) => ({
        endedAt: new Date(now - (i + 1) * DAY_MS).toISOString(),
        sold: true, saleType: 'AUCTION', clearingPremium: 0.06, bidCount: 12, censored: false
    }))
    const listings = Array.from({ length: 10 }, () =>
        ({ buyingOptions: 'FIXED_PRICE,BEST_OFFER', askPremium: 0.24 }))

    const metrics = LIQUIDITY.metrics(listings, outcomes, { now })
    assert.ok(Math.abs(metrics.askClearingSpread - 0.18) < 1e-9)
    assert.strictEqual(metrics.sellThroughRate, 1)
})

test('an unsold auction with bids is not counted as a sale', () => {
    const now = Date.parse('2026-08-26T00:00:00Z')
    const outcomes = [
        { endedAt: new Date(now - DAY_MS).toISOString(), sold: false, saleType: 'AUCTION', bidCount: 4, clearingPremium: 0.01 },
        { endedAt: new Date(now - DAY_MS).toISOString(), sold: true, saleType: 'AUCTION', bidCount: 9, clearingPremium: 0.06 }
    ]
    const metrics = LIQUIDITY.metrics([], outcomes, { now })
    assert.strictEqual(metrics.sellThroughRate, 0.5)
    assert.strictEqual(metrics.medianClearingPremium, 0.06)
})

test('relists are detected so sell-through is not flattered', () => {
    const now = Date.parse('2026-08-26T00:00:00Z')
    const outcomes = [1, 2, 3].map(i => ({
        endedAt: new Date(now - i * DAY_MS).toISOString(),
        sellerHash: 'abc', title: 'RARE!! 1974 Gold Sovereign free p&p', sold: i === 1
    }))
    assert.ok(LIQUIDITY.relistRate(outcomes) > 0.5)
})

test('the uplift curve recovers a known closing surge', () => {
    const samples = []
    for (let a = 0; a < 60; a++) {
        const final = 400
        for (const [seconds, fraction] of [[30, 0.98], [600, 0.85], [7200, 0.70]]) {
            samples.push({ secondsToEnd: seconds, price: final * fraction, finalPrice: final })
        }
    }
    const curve = UPLIFT.buildCurve(samples)
    assert.ok(Math.abs(curve.T_60S.median - 1 / 0.98) < 0.01)
    assert.ok(curve.T_15M.median > curve.T_60S.median)
    assert.ok(curve.T_6H.median > curve.T_15M.median)
})

test('an unlearned bucket projects nothing rather than assuming no uplift', () => {
    /*
        Assuming 1.0x during the cold-start weeks would mark every
        early-stage auction as a bargain and train the user to ignore
        alerts entirely.
    */
    assert.strictEqual(UPLIFT.project(380, 600, UPLIFT.buildCurve([])), null)
})

/*  A snapshot is not an independent observation of how auctions close - it is
    one more look at the same auction. Counting them individually made a curve
    built from 23 real auctions report n=1,418, one lot contributing 110 of
    them and so outweighing an auction seen 20 times by five to one. */
test('the uplift curve gives each auction one vote, not one per snapshot', () => {
    const samples = []
    /*  One noisy auction watched 100 times, closing flat, against four seen
        twice each that all closed 20% up. */
    for (let i = 0; i < 100; i++) {
        samples.push({ browseId: 'loud', secondsToEnd: 600, price: 100, finalPrice: 100 })
    }
    for (const id of ['a', 'b', 'c', 'd']) {
        samples.push({ browseId: id, secondsToEnd: 600, price: 100, finalPrice: 120 })
        samples.push({ browseId: id, secondsToEnd: 600, price: 100, finalPrice: 120 })
    }

    const curve = UPLIFT.buildCurve(samples)
    const bucket = curve[UPLIFT.bucketFor(600)]

    assert.strictEqual(bucket.n, 5, 'five auctions, not 108 snapshots')
    /*  Four of five auctions closed 20% up, so the median must follow them
        and not the one lot that was merely watched most. */
    assert.ok(Math.abs(bucket.median - 1.2) < 1e-9, 'median was ' + bucket.median)
})

/*  Samples without an id degrade to the old behaviour rather than silently
    merging unrelated lots under one key. */
test('uplift samples with no auction id each count once', () => {
    const samples = Array.from({ length: 6 }, () => ({ secondsToEnd: 600, price: 100, finalPrice: 110 }))
    const bucket = UPLIFT.buildCurve(samples)[UPLIFT.bucketFor(600)]
    assert.strictEqual(bucket.n, 6)
})

/*  eBay UK charges the buyer a protection fee on top of the item price, and
    it appears in no API response. A lot recorded as clearing at GBP 829.12
    in fact cost its winner GBP 852.40 - so a premium computed on the
    recorded number is a premium nobody paid. */
test('the buyer protection fee is part of what a coin costs', () => {
    const BUYER = require('../src/analytics/buyercost.js')
    const PREMIUM = require('../src/analytics/premium.js')

    /*  The schedule is calibrated on real observed orders. Fitted to one it
        was 5p over on BOTH, which read as rounding until the second order
        showed the offset was constant; at fixed 0.70 they reproduce exactly.
        So the tolerance is a penny, not ten - a fit that has drifted off by
        5p again is the signal, and a loose bound would have hidden it. */
    assert.ok(BUYER.OBSERVED.length >= 2, 'one order cannot separate a fit from an offset')
    for (const observed of BUYER.OBSERVED) {
        const computed = BUYER.buyerFee(observed.orderTotal)
        const error = Math.abs(computed - observed.fee)
        assert.ok(error <= 0.01,
            observed.note + ': computed £' + computed + ' against an actual £' + observed.fee)
    }

    /*  Proportionally heavier on cheap coins, because the fixed component is
        a bigger share of a small order - so it moves quarter sovereigns more
        than quintuples, and the two are not comparable without it. */
    assert.ok(BUYER.buyerFee(50) / 50 > BUYER.buyerFee(2000) / 2000)

    /* totalCost carries it; listedCost is the headline price. */
    assert.strictEqual(PREMIUM.listedCost(800, 5), 805)
    assert.ok(PREMIUM.totalCost(800, 5) > 805)
    assert.strictEqual(PREMIUM.totalCost(800, 5), BUYER.buyerCost(805))

    /* A premium measured with it is higher than one measured without. */
    const withFee = PREMIUM.premium(PREMIUM.totalCost(800, 0), 0.2354, 3292)
    const without = PREMIUM.premium(PREMIUM.listedCost(800, 0), 0.2354, 3292)
    assert.ok(withFee > without)
})

/*  The fee cuts both ways, and the tool only ever applied it in one
    direction. Fair value is fitted from totalCost, so a bid ceiling derived
    from it is an ALL-IN figure - but eBay adds the fee on top of what you
    bid, so bidding the ceiling less postage overshot it by the entire fee.
    Every max bid and every suggested offer the tool ever printed was 2.4%
    high on a GBP 2,000 lot and 5.6% high on a GBP 50 one. */
test('a bid ceiling is quoted without the fee eBay will add to it', () => {
    const BUYER = require('../src/analytics/buyercost.js')
    const FAIRVALUE = require('../src/analytics/fairvalue.js')

    /*  The round trip is exact, including either side of the GBP 300 tier
        boundary where the rate steps from 4% to 2%. */
    for (const price of [10, 49.99, 287.73, 287.74, 299.99, 300, 300.01, 312.75, 829.12, 5000]) {
        assert.strictEqual(BUYER.priceForCost(BUYER.buyerCost(price)), price,
            'round trip at £' + price)
    }

    /*  The promise is one-directional: acting on this number can never cost
        more than the ceiling it came from. Being a penny under is fine;
        being a penny over defeats the point of a ceiling. */
    for (let pence = 100; pence <= 400000; pence += 313) {
        const target = pence / 100
        assert.ok(BUYER.buyerCost(BUYER.priceForCost(target)) <= target,
            'ceiling honoured at £' + target)
    }

    /*  The regression itself, through the function that produces the number
        shown on the market page. A quarter sovereign at a 40% premium: bid
        maxBid, pay the fee, and the total must still fit inside allInValue. */
    const fair = { sufficient: true, p25: 0.30, p50: 0.40, p75: 0.55 }
    const ceiling = FAIRVALUE.bidCeiling(fair, {
        fineOz: 0.2354, spotGbpPerOz: 3292, shipping: 4.50, targetQuantile: 0.5
    })
    assert.ok(BUYER.buyerCost(ceiling.maxBid + 4.50) <= ceiling.allInValue,
        'maxBid £' + ceiling.maxBid + ' plus postage and fee must fit in £' + ceiling.allInValue)
    /*  And it is genuinely lower than the old arithmetic, not a no-op. */
    assert.ok(ceiling.maxBid < ceiling.allInValue - 4.50)
})

/*
    THE MEDIAN IS TRUE AND USELESS IN THE LAST FIFTEEN MINUTES.

    The uplift chart drew one bar per bucket at the median ratio, and in the
    final bucket that median is 1.00 - which reads as "the price does not move
    before the hammer". The owner did not believe it. Measured on the live
    store, of 422 lots seen inside that window 132 rose more than 5% and 52
    more than 20%: the median is correct and hides exactly the thing a bidder
    needs, which is the chance of being outbid late.
*/
test('the curve says how often a lot jumps, not only where the middle lands', () => {
    /*  Twenty auctions in one bucket. Fourteen barely move; six jump 30%. The
        median is 1.01 - "nothing happens" - while nearly a third jumped. */
    const samples = []
    for (let n = 0; n < 20; n++) {
        samples.push({
            browseId: 'lot' + n, secondsToEnd: 600, price: 100,
            finalPrice: n < 6 ? 130 : 101
        })
    }
    const bucket = UPLIFT.buildCurve(samples)[UPLIFT.bucketFor(600)]

    assert.ok(bucket.median < 1.05,
        'the fixture does not reproduce the flat median: ' + bucket.median)
    assert.ok(bucket.rose5 > 0.25 && bucket.rose5 < 0.35,
        'six of twenty rose more than 5%, reported ' + bucket.rose5)
    assert.strictEqual(bucket.rose20, bucket.rose5,
        'the same six rose more than 20%, so the two shares should agree here')

    /*  The point of the whole change, stated as an assertion: a reader
        looking only at the median would conclude nothing happens. */
    assert.ok(bucket.rose5 > (bucket.median - 1) * 4,
        'the share that jumps is not telling you more than the median is')
})

test('a share is null when the bucket has too little to say', () => {
    /*  Below the sample floor the curve reports nothing rather than a
        confident fraction of four auctions. */
    const bucket = UPLIFT.buildCurve([
        { browseId: 'a', secondsToEnd: 600, price: 100, finalPrice: 150 },
        { browseId: 'b', secondsToEnd: 600, price: 100, finalPrice: 150 }
    ])[UPLIFT.bucketFor(600)]

    assert.strictEqual(bucket.sufficient, false)
    assert.strictEqual(bucket.rose5, null, 'a two-auction bucket reported a share anyway')
    assert.strictEqual(bucket.n, 2, 'the count should still be reported, so thin reads as thin')
})

test('fair value carries the tails the chart used to hide', () => {
    /*  The chart drew p25 to p75 and nothing else, so the cheap quarter - the
        quarter somebody buying is hunting - was the part not drawn. */
    const now = Date.now()
    const observations = []
    for (let n = 0; n < 40; n++) {
        observations.push({
            premium: n / 100, soldAt: new Date(now - n * 3600000).toISOString(), censored: false
        })
    }
    const fair = FAIRVALUE.fairValue(observations, { now })

    assert.ok(fair.sufficient)
    for (const q of ['p10', 'p25', 'p50', 'p75', 'p90']) {
        assert.ok(Number.isFinite(fair[q]), q + ' is missing from fair value')
    }
    assert.ok(fair.p10 < fair.p25, 'p10 is not below p25')
    assert.ok(fair.p90 > fair.p75, 'p90 is not above p75')
})
