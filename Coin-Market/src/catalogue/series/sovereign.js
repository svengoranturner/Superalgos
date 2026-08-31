'use strict'

const COINS = require('../coins.js')

/*
    British gold sovereigns.

    The tool's original and, for now, only series. This pack does not
    redefine anything - it points at the tables in coins.js that have always
    held them - so extracting it changes no behaviour. What it changes is
    WHERE the answer to "which coin is this?" comes from: a pack, rather than
    a literal spread across the catalogue.

    Everything here is a property of sovereigns specifically. Anything true
    of coins in general - how a slab grade is read, how a lot size is
    counted, whether a listing is jewellery - stays outside, because a second
    series would want it unchanged.
*/

module.exports = {
    id: 'GB.SOV',
    label: 'British Gold Sovereigns',
    metal: 'XAU',

    /*  Referenced, never copied. Two tables that must agree is a bug
        waiting for someone to edit one of them. */
    denominations: COINS.DENOMINATIONS,
    portraits: COINS.PORTRAITS,
    portraitByCode: COINS.PORTRAIT_BY_CODE,
    mints: COINS.MINTS,
    gradeBands: COINS.GRADE_BANDS,
    pools: COINS.POOLS,
    poolFor: COINS.poolFor,
    portraitsForYear: COINS.portraitsForYear,

    /*
        The key ladder: what each level of specificity adds.

        Level 0 is series + pool + denomination; every level after it appends
        one more attribute. A series with no portraits, or with a mintmark
        that means something different, declares its own ladder rather than
        bending this one.
    */
    levelFields: [
        [],                                                  /* L0: series + pool + denomination */
        ['portrait'],
        ['portrait', 'year'],
        ['portrait', 'year', 'mint'],
        ['portrait', 'year', 'mint', 'gradeBand']
    ],

    /*
        The monarchs, as sellers write them. Moved here from classify.js
        unchanged: the algorithm that combines a keyword with a year is
        universal, but which keywords exist is entirely a property of this
        series - no other coin has a Jubilee Head.
    */
    portraitKeywords: [
    { code: 'VIC_JUBILEE',      test: /\bjubilee\s*head\b|\bjubilee\b/i },
    { code: 'VIC_OLD',          test: /\b(old|veiled|widow)\s*head\b/i },
    { code: 'VIC_YOUNG_SHIELD', test: /\b(shield|shield[-\s]?back|shieldback)\b/i },
    { code: 'VIC_YOUNG_GEORGE', test: /\byoung\s*head\b/i },
    { code: 'GEORGE_III',       test: /\bgeorge\s*(iii|3rd|3)\b/i },
    { code: 'GEORGE_IV',        test: /\bgeorge\s*(iv|4th|4)\b/i },
    { code: 'WILLIAM_IV',       test: /\bwilliam\s*(iv|4th|4)\b/i },
    { code: 'EDWARD_VII',       test: /\bedward\s*(vii|7th|7)\b/i },
    { code: 'GEORGE_V',         test: /\bgeorge\s*(v|5th|5)\b(?!i)/i },
    { code: 'GEORGE_VI',        test: /\bgeorge\s*(vi|6th|6)\b/i },
    { code: 'CHARLES_III',      test: /\bcharles\s*(iii|3rd|3)\b/i }
    ],

    mintKeywords: [
    { code: 'S',  test: /\bsydney\b/i },
    { code: 'M',  test: /\bmelbourne\b/i },
    { code: 'P',  test: /\bperth\b/i },
    { code: 'C',  test: /\bottawa\b|\bcanada\b/i },
    { code: 'I',  test: /\bbombay\b|\bmumbai\b/i },
    { code: 'SA', test: /\bpretoria\b|\bsouth\s*africa\b/i }
    ],

    /*  The mint that strikes no mark, and the years in which its branches
        were running. Inside that window an absent mark is no evidence at
        all; outside it, it is weak evidence of London. */
    unmarkedMint: { code: 'LON', names: /\blondon\b|\bno\s*mint\s*mark\b/i },
    branchMintYears: { from: 1871, to: 1932 },

    /*  Denomination parsing stays in classify.js, where its scar tissue
        lives: three separate bug fixes about punctuation, one about word
        order, one about nine ways of writing a multi-weight sovereign. The
        logic is irreducibly about half, quarter, double and quintuple
        SOVEREIGNS, so there is nothing in it to generalise - only somewhere
        for it to be owned. Required lazily because classify.js requires the
        registry, and a top-level require here would close the loop. */
    denominationFrom (title) {
        return require('../classify.js').extractDenomination(title)
    },

    /*  What each ladder field is called on screen. 'Portrait' is a
        sovereign's word; a Morgan dollar would say 'Design'. */
    fieldLabels: { portrait: 'Portrait', year: 'Year', mint: 'Mint', gradeBand: 'Grade' },

    /*
        What the year parser will accept.

        Bounded at 1817, the first modern sovereign, so that "22ct", "9ct",
        weights and postcodes cannot be mistaken for dates. The mintmarks are
        the letters dealers glue to the year - "1887S", "1919 P", "1927 SA" -
        and SA leads the alternation because a regex alternation is ordered
        and "S" would otherwise match first and leave the A behind.
    */
    yearRange: { from: 1817, to: 2049 },
    mintMarks: ['SA', 'S', 'M', 'P', 'C', 'I', 'A'],

    /*
        What counts as an odd price for a sovereign. These are the values
        that were hard-coded in plausibility.js, moved here unchanged: a
        sovereign is bullion-adjacent, so anything past 25% over its gold is
        already a premium and three times is extraordinary. A silver series
        needs entirely different numbers, which is why they are a property
        of the series rather than of the tool.
    */
    plausibility: {
        impossibleBelow: 0.85,
        premiumAbove: 1.25,
        extremeAbove: 3
    },

    /*  How this series talks about itself, for buttons and review copy that
        would otherwise hard-code the word "sovereign". */
    vocabulary: {
        one: 'sovereign',
        notOne: 'Not a sovereign',
        plural: 'sovereigns'
    },

    /*
        Does this title describe one of ours?

        The word does the work: nothing else on eBay is called a sovereign,
        and the things that borrow the name - sovereign rings, sovereign
        cases, Hattons' "1/10 sovereign" - are caught by the exclusion rules
        rather than by pretending they are not sovereign-shaped.

        Deliberately NOT keyed on "gold": a title reading "22ct full
        sovereign" says nothing about gold and is still obviously one.
    */
    recognise (title) {
        const t = ' ' + String(title || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ') + ' '
        if (/\bsovereigns?\b/.test(t)) {
            return { confidence: 0.95, reasons: ['names the sovereign'] }
        }
        if (/\bsov\b/.test(t)) {
            return { confidence: 0.7, reasons: ['abbreviated as sov'] }
        }
        return null
    }
}
