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
    assert.ok(ceiling.allInValue > ceiling.meltValue)
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
