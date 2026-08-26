'use strict'

/*
    Premium over intrinsic gold value.

    This is the tool's unit of account. Raw prices cannot be compared
    across time because gold moves underneath them; premium can. A
    sovereign that fetched 340 GBP when gold was 1500 GBP/oz and one that
    fetched 400 GBP when gold was 1800 GBP/oz sold at almost identical
    premiums - the same coin, the same market, in prices that look 18%
    apart.

    Shipping is always included in the total cost. Excluding it flatters
    exactly the listings that look cheapest, because a low headline price
    with high postage is the oldest trick on the platform.
*/

exports.meltValue = function (fineOz, spotGbpPerOz) {
    return fineOz * spotGbpPerOz
}

/*
    Returns premium as a fraction: 0.05 means 5% over melt. Negative means
    the coin sold below its gold content, which does happen on unloved
    ungraded lots and is a strong buy signal.
*/
exports.premium = function (totalCostGbp, fineOz, spotGbpPerOz) {
    if (!Number.isFinite(totalCostGbp) || !Number.isFinite(fineOz) || !Number.isFinite(spotGbpPerOz)) { return null }
    if (fineOz <= 0 || spotGbpPerOz <= 0) { return null }
    const melt = exports.meltValue(fineOz, spotGbpPerOz)
    return (totalCostGbp / melt) - 1
}

exports.totalCost = function (price, shipping) {
    const p = Number.isFinite(price) ? price : 0
    const s = Number.isFinite(shipping) ? shipping : 0
    return p + s
}

/* The inverse: what a coin is worth at a given premium. Used to turn a
   target premium into a bid ceiling. */
exports.priceAtPremium = function (premium, fineOz, spotGbpPerOz) {
    return exports.meltValue(fineOz, spotGbpPerOz) * (1 + premium)
}
