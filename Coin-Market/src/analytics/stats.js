'use strict'

/*
    Robust statistics.

    Collectible sale prices are skewed and outlier-heavy: one shill-bid
    auction or one desperate buyer drags a mean somewhere useless. Every
    summary here is quantile- or median-based for that reason.
*/

/*
    Quantiles.

    There is exactly ONE quantile definition in this codebase: the weighted
    one below, of which the unweighted case is just equal weights. Keeping
    two implementations invited them to disagree - and a fair-value figure
    that shifts depending on whether recency weighting happens to be on is
    a bug that would be very hard to notice and very easy to trade on.

    Each observation sits at the midpoint of the weight it occupies
    (the "type 5" plotting position).
*/
exports.quantile = function (values, q) {
    if (values.length === 0) { return null }
    return exports.weightedQuantile(values.map(value => ({ value, weight: 1 })), q)
}

exports.median = function (values) { return exports.quantile(values, 0.5) }

/*
    Recency-weighted quantile. Observations decay with a half-life so that
    a sale from last week counts for more than one from three months ago,
    without discarding the older evidence entirely - which matters when a
    coin type only trades a handful of times a quarter.
*/
exports.weightedQuantile = function (points, q) {
    if (points.length === 0) { return null }
    const sorted = points.slice().sort((a, b) => a.value - b.value)
    const total = sorted.reduce((sum, p) => sum + p.weight, 0)
    if (total <= 0) { return null }

    /*
        Each observation is placed at the MIDPOINT of the weight it
        occupies, so that with equal weights this reduces exactly to the
        unweighted quantile above. Without the midpoint the two disagree,
        and fair-value estimates would shift the moment recency weighting
        was switched on.
    */
    const positions = []
    let cumulative = 0
    for (const point of sorted) {
        positions.push((cumulative + point.weight / 2) / total)
        cumulative += point.weight
    }

    if (q <= positions[0]) { return sorted[0].value }
    if (q >= positions[positions.length - 1]) { return sorted[sorted.length - 1].value }

    for (let i = 1; i < positions.length; i++) {
        if (q > positions[i]) { continue }
        const span = positions[i] - positions[i - 1]
        if (span === 0) { return sorted[i].value }
        const fraction = (q - positions[i - 1]) / span
        return sorted[i - 1].value + (sorted[i].value - sorted[i - 1].value) * fraction
    }
    return sorted[sorted.length - 1].value
}

exports.decayWeight = function (ageDays, halfLifeDays) {
    if (halfLifeDays <= 0) { return 1 }
    return Math.pow(0.5, ageDays / halfLifeDays)
}

/* Median absolute deviation, scaled to be comparable with a standard
   deviation for normally distributed data. */
exports.medianAbsoluteDeviation = function (values) {
    if (values.length === 0) { return null }
    const med = exports.median(values)
    const deviations = values.map(v => Math.abs(v - med))
    const mad = exports.median(deviations)
    return mad * 1.4826
}

/*
    A crude but honest uncertainty band for a median: the interquartile
    range scaled by sample size. With four observations it will be wide,
    which is the point - the dashboard renders that width rather than
    hiding it behind a single number.
*/
exports.medianConfidenceBand = function (values) {
    if (values.length === 0) { return null }
    if (values.length < 4) {
        return { low: Math.min(...values), high: Math.max(...values), n: values.length, wide: true }
    }
    const p25 = exports.quantile(values, 0.25)
    const p75 = exports.quantile(values, 0.75)
    const med = exports.median(values)
    /* 1.57 * IQR / sqrt(n) is the standard notched-boxplot interval. */
    const halfWidth = 1.57 * (p75 - p25) / Math.sqrt(values.length)
    return { low: med - halfWidth, high: med + halfWidth, n: values.length, wide: values.length < 10 }
}
