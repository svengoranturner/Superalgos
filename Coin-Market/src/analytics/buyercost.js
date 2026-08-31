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
    /*  0.70 rather than 0.75: fitted to one order, the schedule was 5p over
        on it and 5p over on the second order too - a constant offset, not
        noise, which one observation could not distinguish from a good fit.
        At 0.70 both orders reproduce to the penny with a round 2% rate.

        Honestly: two orders GBP 7 apart cannot separate the fixed term from
        the rate. A rate of 1.99% with the old 0.75 fits them just as well.
        0.70 + a round 2% is the likelier published schedule, but a single
        CHEAP order would settle it, because the fixed term dominates there. */
    fixed: 0.70,
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
    The inverse: the most you can let an order total reach without the
    all-in cost exceeding a target.

    This exists because a fair value in this tool is fee-inclusive - every
    premium is fitted from PREMIUM.totalCost(), which runs buyerCost() - so
    a bid ceiling derived from it is an all-in figure. The number you type
    into eBay is not: eBay takes the fee on top of what you bid. Subtracting
    only the postage, as the tool did until now, left the fee in the bid and
    made every ceiling and every suggested offer 2-4% too high.

    Defined as the LARGEST whole-penny order total whose buyerCost does not
    exceed the target, so the promise is one-directional and the safe way
    round: acting on this number cannot cost more than the ceiling it came
    from. That matters more than being within a penny of it.

    Solved in closed form band by band - the schedule is piecewise linear -
    then nudged, because buyerFee rounds to the penny and a rounded function
    has no exact algebraic inverse.
*/
exports.priceForCost = function (target, schedule) {
    if (!Number.isFinite(target) || target <= 0) { return target }
    const rules = schedule || DEFAULT_SCHEDULE

    let feeAtFloor = rules.fixed
    let floor = 0
    let candidate = null

    for (const tier of rules.tiers) {
        const feeAtCeiling = feeAtFloor + (tier.upTo - floor) * tier.rate
        /*  What the buyer pays if the order total sits exactly at the top of
            this band. Beyond that the next band's rate applies. */
        if (target <= tier.upTo + feeAtCeiling) {
            /*  target = x + feeAtFloor + (x - floor) * rate  =>  solve for x */
            candidate = (target - feeAtFloor + floor * tier.rate) / (1 + tier.rate)
            break
        }
        feeAtFloor = feeAtCeiling
        floor = tier.upTo
    }

    /*  The last tier is unbounded, so this only fires on a malformed
        schedule. Refusing is better than returning the target unchanged,
        which would read as a ceiling with no fee in it at all. */
    if (candidate === null) { return null }

    let pence = Math.round(candidate * 100)
    /*  At most a penny or two either way: step down while the rounded fee
        pushes us over, then up while there is room to spare. */
    while (pence > 0 && exports.buyerCost(pence / 100, rules) > target) { pence -= 1 }
    while (exports.buyerCost((pence + 1) / 100, rules) <= target) { pence += 1 }

    return pence / 100
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
    { orderTotal: 829.12, fee: 23.28, note: '1919 P sovereign, 30 Aug 2026' },
    /*  "1968 UK FULL GOLD SOVEREIGN COIN." Sold 2026-08-30 17:32. Item
        GBP 822.25, fee GBP 23.15, buyer paid GBP 845.40. The order that
        showed the 5p offset was constant rather than rounding. */
    { orderTotal: 822.25, fee: 23.15, note: '1968 sovereign, 30 Aug 2026' }
]
