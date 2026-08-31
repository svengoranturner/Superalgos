'use strict'

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
    IMPOSSIBLE: {
        code: 'IMPOSSIBLE',
        label: 'below spot - not this coin',
        detail: 'Priced under its own gold content, so it cannot be the coin the title claims.'
    },
    BULLION: {
        code: 'BULLION',
        label: 'priced like bullion',
        detail: 'Close to gold content, as a bullion-grade coin should be.'
    },
    PREMIUM: {
        code: 'PREMIUM',
        label: 'priced like a collector coin',
        detail: 'Well above gold content - normal for a graded, scarce or proof piece.'
    },
    EXTREME: {
        code: 'EXTREME',
        label: 'far above spot - rarity or error',
        detail: 'Many times its gold content. Either a genuine rarity or a mis-priced listing.'
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
    if (!Number.isFinite(price) || price <= 0) { return null }
    if (!Number.isFinite(fineOz) || fineOz <= 0) { return null }
    if (!Number.isFinite(spotGbpPerOz) || spotGbpPerOz <= 0) { return null }

    const spotValue = fineOz * spotGbpPerOz
    const ratio = price / spotValue

    const liveAuction = context !== undefined && context !== null && context.liveAuction === true

    let verdict = VERDICTS.BULLION
    if (ratio < IMPOSSIBLE_BELOW) {
        verdict = liveAuction ? VERDICTS.OPENING : VERDICTS.IMPOSSIBLE
    } else if (ratio >= EXTREME_ABOVE) { verdict = VERDICTS.EXTREME } else if (ratio >= PREMIUM_ABOVE) { verdict = VERDICTS.PREMIUM }

    return {
        spotValue,
        ratio,
        percentOfSpot: ratio * 100,
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
        underSpot: ratio < IMPOSSIBLE_BELOW
    }
}
