'use strict'

/*
    Is this price even possible for the coin it claims to be?

    Gold has a floor. A genuine sovereign cannot be offered for less than the
    gold in it, because the metal alone is worth that to a scrap dealer. So a
    "gold sovereign" at GBP 107 against a melt value of GBP 775 is not a
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
        label: 'below melt - not this coin',
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
        label: 'far above melt - rarity or error',
        detail: 'Many times its gold content. Either a genuine rarity or a mis-priced listing.'
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

exports.assess = function (price, fineOz, spotGbpPerOz) {
    if (!Number.isFinite(price) || price <= 0) { return null }
    if (!Number.isFinite(fineOz) || fineOz <= 0) { return null }
    if (!Number.isFinite(spotGbpPerOz) || spotGbpPerOz <= 0) { return null }

    const melt = fineOz * spotGbpPerOz
    const ratio = price / melt

    let verdict = VERDICTS.BULLION
    if (ratio < IMPOSSIBLE_BELOW) { verdict = VERDICTS.IMPOSSIBLE } else if (ratio >= EXTREME_ABOVE) { verdict = VERDICTS.EXTREME } else if (ratio >= PREMIUM_ABOVE) { verdict = VERDICTS.PREMIUM }

    return {
        melt,
        ratio,
        percentOfMelt: ratio * 100,
        verdict: verdict.code,
        label: verdict.label,
        detail: verdict.detail,
        /*  The one call sites actually branch on: an opportunity computed
            against a lot that cannot be the coin claimed is not an
            opportunity, it is a misclassification wearing a large number. */
        impossible: verdict.code === 'IMPOSSIBLE'
    }
}
