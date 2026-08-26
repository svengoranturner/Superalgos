'use strict'

const STATS = require('./stats.js')

/*
    The closing-uplift curve.

    eBay auctions are decided in the last seconds. A lot sitting at 380 GBP
    with ten minutes left is not a 380 GBP lot - snipers have not arrived.
    Alerting on the current price therefore either fires constantly on lots
    that end up expensive, or fires too late to act.

    Because the collector snapshots every tracked auction on its way to
    close, it accumulates the one thing that fixes this: an empirical
    distribution of how much lots actually rise from any given point before
    the hammer. That distribution is not for sale anywhere; it is a
    by-product of running the collector, and it sharpens every week.

    The curve is expressed as multiplicative uplift (final / observed), and
    summarised by quantile so that projections carry a range, not a point.
*/

/* Buckets in seconds-to-end. Fine near the close where the action is. */
const BUCKETS = [
    { code: 'T_60S',   label: 'under 1 min',   maxSeconds: 60 },
    { code: 'T_5M',    label: '1-5 min',       maxSeconds: 300 },
    { code: 'T_15M',   label: '5-15 min',      maxSeconds: 900 },
    { code: 'T_1H',    label: '15-60 min',     maxSeconds: 3600 },
    { code: 'T_6H',    label: '1-6 hours',     maxSeconds: 21600 },
    { code: 'T_24H',   label: '6-24 hours',    maxSeconds: 86400 },
    { code: 'T_3D',    label: '1-3 days',      maxSeconds: 259200 },
    { code: 'T_LONG',  label: 'over 3 days',   maxSeconds: Infinity }
]

exports.BUCKETS = BUCKETS

exports.bucketFor = function (secondsToEnd) {
    for (const bucket of BUCKETS) {
        if (secondsToEnd <= bucket.maxSeconds) { return bucket.code }
    }
    return 'T_LONG'
}

/*
    samples: [{ secondsToEnd, price, finalPrice }]
    Only auctions that actually sold should be fed in - an unsold lot has
    no hammer price and would poison the ratios.
*/
exports.buildCurve = function (samples, options) {

    const config = Object.assign({ minSamples: 5 }, options || {})
    const byBucket = new Map()

    for (const sample of samples) {
        if (!Number.isFinite(sample.price) || sample.price <= 0) { continue }
        if (!Number.isFinite(sample.finalPrice) || sample.finalPrice <= 0) { continue }
        if (!Number.isFinite(sample.secondsToEnd) || sample.secondsToEnd < 0) { continue }

        const code = exports.bucketFor(sample.secondsToEnd)
        if (!byBucket.has(code)) { byBucket.set(code, []) }
        byBucket.get(code).push(sample.finalPrice / sample.price)
    }

    const curve = {}
    for (const bucket of BUCKETS) {
        const ratios = byBucket.get(bucket.code) || []
        curve[bucket.code] = ratios.length >= config.minSamples
            ? {
                sufficient: true,
                n: ratios.length,
                p25: STATS.quantile(ratios, 0.25),
                median: STATS.median(ratios),
                p75: STATS.quantile(ratios, 0.75),
                p90: STATS.quantile(ratios, 0.90)
            }
            : { sufficient: false, n: ratios.length, p25: null, median: null, p75: null, p90: null }
    }
    return curve
}

/*
    Projects where a live auction is likely to finish.

    Returns null when the curve has not learned that bucket yet - a cold
    start must say "I don't know" rather than assume an uplift of 1.0,
    which would systematically make every early-stage auction look like a
    bargain and fire a flood of false alerts in week one.
*/
exports.project = function (currentPrice, secondsToEnd, curve) {
    if (!Number.isFinite(currentPrice) || currentPrice <= 0) { return null }
    const code = exports.bucketFor(secondsToEnd)
    const entry = curve[code]
    if (entry === undefined || !entry.sufficient) { return null }

    return {
        bucket: code,
        basedOn: entry.n,
        expected: currentPrice * entry.median,
        optimistic: currentPrice * entry.p25,   /* if bidding stays quiet */
        pessimistic: currentPrice * entry.p75,  /* if it gets contested   */
        worstCase: currentPrice * entry.p90
    }
}
