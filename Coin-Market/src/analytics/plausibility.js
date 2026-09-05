'use strict'

const SERIES = require('../catalogue/series/index.js')

/*
    Is this price even possible for the coin it claims to be?

    Gold has a floor. A genuine sovereign is not offered for much less than
    the spot value of the gold in it - a scrap dealer pays under spot, so a
    seller who would take less than that would do better weighing it in. So a
    "gold sovereign" at GBP 107 against a spot value of GBP 775 is not a
    bargain - it is something else wearing the word: a book about sovereigns,
    a commemorative medal, an empty presentation box, a hundredth-ounce
    token, a pair of sunglasses called Sovereign.

    This is a far stronger test than any title rule, because it does not care
    what the seller called it. It is also the honest way to answer "is this
    flagged listing genuine?" - the review queue can show what the price
    implies rather than leaving a human to judge from the title alone.

    It is deliberately advisory. A price cannot prove a coin is real, only
    that it is not the coin claimed, so nothing here silently deletes a
    listing; it labels one.
*/

const VERDICTS = {
    /*
        THE LABEL USED TO SAY "not this coin", FLATLY, and that was too strong.

        Metal does sell under spot. A worn, damaged or simply unloved coin can
        clear below its own content, and a stacker hunting exactly those is
        one of the readers this tool is for - premium.js has said so all along
        ("negative means the coin sold below its gold content, which does
        happen on unloved ungraded lots and is a strong buy signal"), while
        this label told them it could not be the coin.

        Both readings are live below 0.85, and this now says both. The
        threshold is unchanged: what was wrong was the certainty, not the line.
    */
    IMPOSSIBLE: {
        code: 'IMPOSSIBLE',
        label: 'below its own metal',
        detail: 'Priced under the metal it contains. Usually something other than the coin ' +
            'the title claims - but a worn or unloved example really can sell here, so it ' +
            'is worth a look rather than a dismissal.'
    },
    BULLION: {
        code: 'BULLION',
        label: 'priced near spot',
        detail: 'Close to its metal content, as an ordinary example should be.'
    },
    PREMIUM: {
        code: 'PREMIUM',
        label: 'priced like a collector coin',
        detail: 'Well above its metal content - normal for a graded, scarce or proof piece.'
    },
    EXTREME: {
        code: 'EXTREME',
        label: 'far above spot - rarity or error',
        detail: 'Many times its metal content. Either a genuine rarity or a mis-priced listing.'
    },
    /*
        For a key date, a slabbed coin or a proof, the metal is not what sets
        the price - so there is no ratio high enough to be suspicious, and
        "priced near spot" would be absurd beside 5,984%. The pool says the
        question does not apply, and so does the label.
    */
    NUMISMATIC: {
        code: 'NUMISMATIC',
        label: 'priced on rarity, not metal',
        detail: 'For this kind of coin the metal content is not what sets the price, ' +
            'so its ratio to spot says nothing about whether the listing is sound.'
    },

    /*
        The same number, on a live auction, means something completely
        different. Sellers routinely open below the gold value to attract
        bids - it is the normal state of an auction that has not run yet,
        and calling it "not this coin" is a false alarm that teaches you to
        ignore the column.
    */
    OPENING: {
        code: 'AUCTION_UNDER_SPOT',
        label: 'auction still under spot',
        detail: 'Normal for a live auction - sellers open below gold value to attract bids. ' +
            'It says nothing about whether the coin is genuine.'
    }
}

exports.VERDICTS = VERDICTS

/*
    A little below 1.0 rather than exactly 1.0: a real coin can sit a shade
    under spot on a fast-moving day, or on a listing whose shipping is
    charged separately. Only a clear break from the metal price is treated
    as impossible.
*/
/*
    Defaults only. The real values come from the coin's own series, because
    what counts as an odd price is a property of the coin and not of the
    tool.

    These numbers are gold-shaped: a sovereign is bullion-adjacent, so 25%
    over its metal is already a premium and three times is extraordinary.
    Applied to silver they libel every genuine coin - a common Morgan trades
    at about twice its silver, which reads as PREMIUM, and an 1893-S at sixty
    times reads "far above spot - rarity or error". That badge appearing on
    real coins is exactly the failure that made this column ignorable once
    before, when a quarter-sovereign fallback put a wrong verdict on 1,346
    rows.
*/
const IMPOSSIBLE_BELOW = 0.85
const PREMIUM_ABOVE = 1.25
const EXTREME_ABOVE = 3

/*
    context.liveAuction - a running auction whose current bid is the number
    being tested. Below spot is then expected rather than impossible, so the
    lot is labelled instead of being called a fake or dropped from the
    opportunities panel.
*/
exports.assess = function (price, fineOz, spotGbpPerOz, context) {
    /*  context.series names the coin's series; absent, the defaults above
        apply, which is what every existing caller means. */
    /*
        Thresholds come from the coin's series AND its pool.

        Per series, because a sovereign is bullion-adjacent and a silver
        dollar is not. Per POOL, because within one series the question
        changes completely: for a common-date coin the metal is most of the
        price, so a wild ratio really does suggest a misclassification -
        which is what this column is FOR. For a key date or a slabbed coin
        the metal is irrelevant to the price, and an 1893-S at sixty times
        its silver is not an error, it is an 1893-S. Badging those "rarity or
        error" is how a column stops being read.

        Pass context.key and both are read off it; context.series still works
        for a caller that has no key.
    */
    let pack = context && context.series ? SERIES.get(context.series) : null
    let pool = context && context.pool ? context.pool : null
    if (context && typeof context.key === 'string') {
        const found = SERIES.forKey(context.key)
        if (found !== null) { pack = found.pack; pool = pool || found.rest[0] }
    }
    const base = (pack && pack.plausibility) || {}
    const byPool = (base.byPool && pool && base.byPool[pool]) || {}
    const limits = Object.assign({}, base, byPool)
    /*  isFinite would reject Infinity, which is exactly the value a pool
        uses to say "no ratio here is suspicious" - and rejecting it silently
        restored the gold defaults, so key dates went on being badged as
        errors while the config that was meant to stop it sat there looking
        correct. */
    const pick = (value, fallback) =>
        typeof value === 'number' && !Number.isNaN(value) ? value : fallback
    const impossibleBelow = pick(limits.impossibleBelow, IMPOSSIBLE_BELOW)
    const premiumAbove = pick(limits.premiumAbove, PREMIUM_ABOVE)
    const extremeAbove = pick(limits.extremeAbove, EXTREME_ABOVE)

    if (!Number.isFinite(price) || price <= 0) { return null }
    if (!Number.isFinite(fineOz) || fineOz <= 0) { return null }
    if (!Number.isFinite(spotGbpPerOz) || spotGbpPerOz <= 0) { return null }

    const spotValue = fineOz * spotGbpPerOz
    const ratio = price / spotValue

    const liveAuction = context !== undefined && context !== null && context.liveAuction === true

    let verdict = VERDICTS.BULLION
    if (ratio < impossibleBelow) {
        verdict = liveAuction ? VERDICTS.OPENING : VERDICTS.IMPOSSIBLE
    } else if (ratio >= extremeAbove) {
        verdict = VERDICTS.EXTREME
    } else if (ratio >= premiumAbove) {
        verdict = VERDICTS.PREMIUM
    } else if (premiumAbove === Infinity && ratio >= PREMIUM_ABOVE) {
        /*  The pool has told us the metal does not price this coin. Saying
            "near spot" at twenty times spot would be worse than saying
            nothing. */
        verdict = VERDICTS.NUMISMATIC
    }

    return {
        spotValue,
        ratio,
        percentOfSpot: ratio * 100,
        /*  The same number as a premium: what you pay OVER the metal, which
            is the figure the rest of the tool speaks in. "130% of spot" and
            "+30%" say the same thing, but only one of them sits beside a
            clearing premium of 9.6% without the reader having to convert. */
        premium: ratio - 1,
        verdict: verdict.code,
        label: verdict.label,
        detail: verdict.detail,
        /*  The one call sites actually branch on: an opportunity computed
            against a lot that cannot be the coin claimed is not an
            opportunity, it is a misclassification wearing a large number. */
        impossible: verdict.code === 'IMPOSSIBLE',
        /*  Under the metal price, whoever is asking and however it sells.

            Distinct from `impossible`, because a live auction under spot is
            normal rather than damning - and needed separately, because a
            caller that only trusts the downward direction has to know the
            price is under the floor without caring which of the two labels
            applies to it. */
        underSpot: ratio < impossibleBelow
    }
}
