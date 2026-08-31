'use strict'

const BUYER = require('./buyercost.js')

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

exports.goldValueAtSpot = function (fineOz, spotGbpPerOz) {
    return fineOz * spotGbpPerOz
}

/*
    Returns premium as a fraction: 0.05 means 5% over spot. Negative means
    the coin sold below its gold content, which does happen on unloved
    ungraded lots and is a strong buy signal.
*/
exports.premium = function (totalCostGbp, fineOz, spotGbpPerOz) {
    if (!Number.isFinite(totalCostGbp) || !Number.isFinite(fineOz) || !Number.isFinite(spotGbpPerOz)) { return null }
    if (fineOz <= 0 || spotGbpPerOz <= 0) { return null }
    const spotValue = exports.goldValueAtSpot(fineOz, spotGbpPerOz)
    return (totalCostGbp / spotValue) - 1
}

/*
    What the coin costs you, all in: price, postage, and eBay's Buyer
    Protection fee.

    The fee is the reason this is not simply price + postage. eBay UK charges
    it to the buyer on top, and reports it in no API response - a lot recorded
    as clearing at GBP 829.12 in fact cost its winner GBP 852.40. Leaving it
    out understates every premium in this tool, and understates it more on
    cheap coins than dear ones because the fixed component is a bigger share
    of a small order: about +5.5% on a GBP 50 lot against +2.3% on a GBP 2,000
    one.

    It is the same money whether a dealer takes it as margin or eBay takes it
    as a fee. Charging it on one side of a comparison and not the other is how
    you get a premium that is right about nothing.

    Applied here, at the single point every premium passes through, so asks
    and clearing prices are always measured on the same basis.
*/
exports.totalCost = function (price, shipping) {
    const p = Number.isFinite(price) ? price : 0
    const s = Number.isFinite(shipping) ? shipping : 0
    return BUYER.buyerCost(p + s)
}

/* The same sum without the fee, for anywhere that needs the headline price. */
exports.listedCost = function (price, shipping) {
    const p = Number.isFinite(price) ? price : 0
    const s = Number.isFinite(shipping) ? shipping : 0
    return p + s
}

/* The inverse: what a coin is worth at a given premium. Used to turn a
   target premium into a bid ceiling. */
exports.priceAtPremium = function (premium, fineOz, spotGbpPerOz) {
    return exports.goldValueAtSpot(fineOz, spotGbpPerOz) * (1 + premium)
}
