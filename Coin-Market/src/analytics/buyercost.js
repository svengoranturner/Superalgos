'use strict'

/*
    What the buyer actually pays.

    eBay UK levies a Buyer Protection fee on top of the item price and
    postage, and it is not in any API response - the Browse and Trading
    payloads report the item price, and the fee appears only on the buyer's
    own order. So a lot recorded here as clearing at GBP 829.12 in fact cost
    its winner GBP 852.40, of which GBP 23.28 was fee.

    That matters because this tool exists to measure premium over gold
    content, and a premium computed on a number the buyer never pays is the
    wrong premium. It is the same money whether a dealer takes it as margin
    or eBay takes it as a fee: it is what the coin cost you. Excluding it
    understates every premium in the tool by roughly three points, and
    understates it MORE on cheap coins than dear ones, because the fixed
    component is a larger share of a small order.

    Being honest about the schedule: it is inferred from eBay's published
    terms and calibrated against a single observed order. The shape - a fixed
    fee plus a percentage that steps down above a threshold - is what eBay
    documents. The exact constants are not something this codebase can verify
    without more observed orders, so they are configurable and the error
    against every known example is asserted in the tests. Anyone who has a
    real order to hand should add it there.
*/

const DEFAULT_SCHEDULE = {
    fixed: 0.75,
    tiers: [
        { upTo: 300, rate: 0.04 },
        { upTo: Infinity, rate: 0.02 }
    ]
}

exports.DEFAULT_SCHEDULE = DEFAULT_SCHEDULE

/*
    The fee on an order of this size. Order total means item price plus
    postage - the fee is levied on what changes hands, not on the headline
    price, which is why a low price with high postage does not escape it.
*/
exports.buyerFee = function (orderTotal, schedule) {
    if (!Number.isFinite(orderTotal) || orderTotal <= 0) { return 0 }
    const rules = schedule || DEFAULT_SCHEDULE

    let fee = rules.fixed
    let remaining = orderTotal
    let floor = 0

    for (const tier of rules.tiers) {
        if (remaining <= 0) { break }
        const band = Math.min(remaining, tier.upTo - floor)
        fee += band * tier.rate
        remaining -= band
        floor = tier.upTo
    }

    /*  Money, so two decimals. Rounded at the end rather than per tier: a
        fee is one charge, not a sum of separately rounded charges. */
    return Math.round(fee * 100) / 100
}

/* What the order costs the buyer, all in. */
exports.buyerCost = function (orderTotal, schedule) {
    if (!Number.isFinite(orderTotal) || orderTotal <= 0) { return orderTotal }
    return Math.round((orderTotal + exports.buyerFee(orderTotal, schedule)) * 100) / 100
}

/*
    Observed orders, for calibration. Each is a real eBay UK purchase where
    the fee was visible on the order.

    These are the only evidence the schedule has. If the constants above ever
    need changing, change them here first and let the test say how well they
    fit - not the other way round.
*/
exports.OBSERVED = [
    /*  "Nice 1919 P King George V Full Gold Sovereign - Never Cleaned Or
        Mounted." Sold 2026-08-30 21:12. Item GBP 829.12, fee GBP 23.28,
        buyer paid GBP 852.40. */
    { orderTotal: 829.12, fee: 23.28, note: '1919 P sovereign, 30 Aug 2026' }
]
