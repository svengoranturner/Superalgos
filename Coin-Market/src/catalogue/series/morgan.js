'use strict'

const MORGAN = require('../coins.morgan.js')

/*
    Morgan and Peace silver dollars.

    The second series, and the one that proves the first extraction was
    worth doing: everything here is data, and none of it required editing
    the classifier, the key builder or the exclusion rules.
*/

module.exports = {
    id: 'US.MORGAN',
    label: 'Morgan & Peace Dollars',
    metal: 'XAG',

    denominations: MORGAN.DENOMINATIONS,
    /*  Held under the sovereign pack's field names so the key ladder and
        displayName are shared. A design IS this series' portrait. */
    portraits: MORGAN.DESIGNS,
    portraitByCode: MORGAN.DESIGN_BY_CODE,
    portraitsForYear: MORGAN.designsForYear,
    mints: MORGAN.MINTS,
    pools: MORGAN.POOLS,
    poolFor: MORGAN.poolFor,

    levelFields: [
        [],                                                  /* L0: series + pool + denomination */
        ['portrait'],
        ['portrait', 'year'],
        ['portrait', 'year', 'mint'],
        ['portrait', 'year', 'mint', 'gradeBand']
    ],

    /*  'Design', not 'Portrait'. Both coins carry a personification of
        Liberty rather than a monarch, and a collector calls the difference
        the design. */
    fieldLabels: { portrait: 'Design', year: 'Year', mint: 'Mint', gradeBand: 'Grade' },

    /*  1878 is the first Morgan, 1935 the last Peace. Bounded tightly on
        purpose: a title reading "1965 Peace Dollar" is describing something
        that does not exist, and a year outside the range is better read as
        no year than as a date. */
    yearRange: { from: 1878, to: 1935 },
    /*  Philadelphia struck without a mark, so it is absent here for the same
        reason London is absent from the sovereign list. CC before C would
        matter if C existed; it does not, but the alternation is length-
        sorted anyway so adding one later cannot break it. */
    mintMarks: ['CC', 'O', 'S', 'D'],

    /*
        What counts as an odd price for this series.

        The sovereign thresholds are gold-shaped and would libel every
        genuine key date here: a common Morgan trades at about twice its
        silver, which the sovereign rule calls a PREMIUM, and an 1893-S at
        sixty times would read as "far above spot - rarity or error". That
        badge appearing on real coins is exactly the failure that made the
        column ignorable once before.
    */
    plausibility: {
        impossibleBelow: 0.9,
        premiumAbove: 2.5,
        extremeAbove: 25
    },

    vocabulary: {
        one: 'silver dollar',
        notOne: 'Not a silver dollar',
        plural: 'silver dollars'
    },

    /*
        Does this title describe one of ours?

        Returns a confidence and the reason for it, or null for "no claim".
        The registry, not the pack, decides what to do when two packs both
        claim a title - a pack is never told about another pack.

        "Morgan" alone is a surname and "peace" is an ordinary word, so
        neither is ever strong on its own. What makes a claim strong is the
        pairing with "dollar", which is how these coins are actually written
        by every seller.
    */
    recognise (title) {
        const t = ' ' + String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' '

        if (/\b(morgan|peace)\s+(silver\s+)?dollars?\b/.test(t)) {
            return { confidence: 0.95, reasons: ['names the design and the denomination'] }
        }
        /*  "1889 CC Morgan" - the design plus a date this series was struck
            in. Strong, because no other coin is written that way. */
        if (/\bmorgan\b/.test(t) && /\b(187[89]|18[89]\d|190[0-4]|1921)\b/.test(t)) {
            return { confidence: 0.9, reasons: ['Morgan with a year the series was struck'] }
        }
        if (/\bpeace\b/.test(t) && /\b(192[1-8]|193[45])\b/.test(t)) {
            return { confidence: 0.9, reasons: ['Peace with a year the series was struck'] }
        }
        /*  A bare "1921 silver dollar" is genuinely one of these - no other
            US dollar was struck in silver that year - but the title has not
            said which design, so it is a weak claim that lands in review. */
        if (/\bsilver\s+dollars?\b/.test(t) && /\b(18[789]\d|190[0-4]|192[1-8]|193[45])\b/.test(t)) {
            return { confidence: 0.5, reasons: ['a silver dollar of the right era, design unstated'] }
        }
        return null
    }
}
