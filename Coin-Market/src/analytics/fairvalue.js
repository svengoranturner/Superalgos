'use strict'

const STATS = require('./stats.js')
const PREMIUM = require('./premium.js')
const BUYER = require('./buyercost.js')

const DAY_MS = 24 * 60 * 60 * 1000

/*
    Fair value for an instrument, expressed as a distribution of clearing
    premiums rather than a single number.

    A point estimate would be a lie for most instruments in this market.
    Common bullion sovereigns trade often enough to pin down tightly;
    a scarce branch-mint date might have four sales in a year, and the
    honest answer there is a wide band plus the sample size, so you can
    see for yourself how much to trust it.
*/

const DEFAULTS = {
    halfLifeDays: 45,
    windowDays: 180,
    minObservations: 3
}

/*
    observations: [{ premium, soldAt, censored }]

    A censored observation is one whose price is a CEILING rather than a
    figure somebody paid - a Buy-It-Now lot whose seller allowed offers (eBay
    never says whether one was taken), or an outcome reconstructed from our
    own last snapshot after the 90-day window closed.

    By default they are excluded and counted separately, because the headline
    fair value feeds the bid ceiling and must not drift upward on prices
    nobody paid.

    With `includeCensored` they are kept, and the result comes back marked
    `bound: 'upper'` or `'mixed'`. That is for the per-channel view, where the
    question is not "what is this coin worth" but "what did lots in THIS
    channel go for", and a ceiling answers it honestly: a coin that sold at or
    below +12% did not sell at +40%. Discarding those rows was throwing away
    45% of the Buy-It-Now market to avoid saying the word "at most".
*/
exports.fairValue = function (observations, options) {

    const config = Object.assign({}, DEFAULTS, options || {})
    const now = config.now !== undefined ? new Date(config.now).getTime() : Date.now()
    const cutoff = now - config.windowDays * DAY_MS

    const usable = []
    let censoredCount = 0
    let censoredUsed = 0

    for (const observation of observations) {
        if (observation.premium === null || observation.premium === undefined) { continue }
        if (!Number.isFinite(observation.premium)) { continue }
        const soldAt = new Date(observation.soldAt).getTime()
        if (!Number.isFinite(soldAt) || soldAt < cutoff) { continue }
        if (observation.censored) {
            censoredCount++
            if (!config.includeCensored) { continue }
            censoredUsed++
        }

        const ageDays = (now - soldAt) / DAY_MS
        usable.push({
            value: observation.premium,
            weight: STATS.decayWeight(ageDays, config.halfLifeDays)
        })
    }

    /*  Read off what actually went in, never off the caller's intent: asking
        for censored rows and receiving none must still say 'exact'. */
    const bound = censoredUsed === 0
        ? 'exact'
        : (censoredUsed === usable.length ? 'upper' : 'mixed')

    if (usable.length < config.minObservations) {
        return {
            sufficient: false,
            n: usable.length,
            censored: censoredCount,
            bound,
            p25: null, p50: null, p75: null, band: null, dispersion: null
        }
    }

    const values = usable.map(p => p.value)

    return {
        sufficient: true,
        n: usable.length,
        censored: censoredCount,
        bound,
        /*  p10 and p90 exist for the chart, which drew only the middle half
            and hid the tails. The owner's objection was exactly right for
            somebody buying: "why wouldn't I be interested in anything above
            or below those thresholds?" - the cheap quarter is the quarter
            they are hunting, and it was the part not drawn. */
        p10: STATS.weightedQuantile(usable, 0.10),
        p25: STATS.weightedQuantile(usable, 0.25),
        p50: STATS.weightedQuantile(usable, 0.50),
        p75: STATS.weightedQuantile(usable, 0.75),
        p90: STATS.weightedQuantile(usable, 0.90),
        band: STATS.medianConfidenceBand(values),
        dispersion: STATS.medianAbsoluteDeviation(values),
        effectiveWeight: usable.reduce((sum, p) => sum + p.weight, 0)
    }
}

/*
    The number you act on: the most you should pay, all-in, for a coin of
    this type if you want to buy at or below the chosen quantile of where
    the market actually clears.

    targetQuantile is a policy choice, not a statistic. p50 means "pay the
    going rate and win about half the time"; p35 means "always buy below
    market, win less often".
*/
exports.bidCeiling = function (fairValueResult, options) {

    const { fineOz, spotGbpPerOz, shipping, targetQuantile } = options
    if (!fairValueResult.sufficient) { return null }

    const q = targetQuantile === undefined ? 0.35 : targetQuantile
    const points = [
        { value: fairValueResult.p25, weight: 1 },
        { value: fairValueResult.p50, weight: 1 },
        { value: fairValueResult.p75, weight: 1 }
    ]
    /* Interpolate the target premium off the three summary quantiles. */
    let targetPremium
    if (q <= 0.25) { targetPremium = fairValueResult.p25 }
    else if (q >= 0.75) { targetPremium = fairValueResult.p75 }
    else if (q <= 0.5) {
        const f = (q - 0.25) / 0.25
        targetPremium = fairValueResult.p25 + (fairValueResult.p50 - fairValueResult.p25) * f
    } else {
        const f = (q - 0.5) / 0.25
        targetPremium = fairValueResult.p50 + (fairValueResult.p75 - fairValueResult.p50) * f
    }

    const allInValue = PREMIUM.priceAtPremium(targetPremium, fineOz, spotGbpPerOz)
    const postage = Number.isFinite(shipping) ? shipping : 0

    return {
        targetPremium,
        allInValue,
        /*
            What to actually type into eBay.

            allInValue is fee-inclusive - it comes from priceAtPremium() on a
            premium fitted from PREMIUM.totalCost(), which charges the buyer
            protection fee. eBay adds that fee ON TOP of the bid, so a bid
            equal to allInValue less postage overshoots the ceiling by the
            whole fee: 2.4% on a GBP 2,000 lot, 5.6% on a GBP 50 one.
            priceForCost() takes it back out.
        */
        maxBid: BUYER.priceForCost(allInValue) - postage,
        goldValueAtSpot: PREMIUM.goldValueAtSpot(fineOz, spotGbpPerOz)
    }
}

exports.DEFAULTS = DEFAULTS
