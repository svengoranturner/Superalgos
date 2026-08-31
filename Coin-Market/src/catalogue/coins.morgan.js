'use strict'

const TROY_OUNCE_GRAMS = 31.1034768

/*
    Morgan and Peace silver dollars.

    ONE series, not two. They are the same coin by every measure that
    matters to pricing - 26.73 g gross, 0.900 fine, 0.7734 troy oz of silver
    - struck by the same mints under the same Act, and 1921 was struck in
    both designs. That last fact is structurally identical to the Victoria
    1871-1885 overlap the sovereign pack already models with two portraits
    sharing a year range, so the machinery for it exists and is tested.

    Splitting them would mean two packs that agree on every physical
    constant and differ only in a design name, which is the shape of a bug
    waiting for someone to edit one of them.
*/

const FINENESS = 0.900
const GROSS_GRAMS = 26.73

function fineOunces (grossGrams, fineness) {
    return (grossGrams * fineness) / TROY_OUNCE_GRAMS
}

/*
    One denomination, which is the point of comparison with sovereigns: this
    series has no half or quarter, so the denomination segment of a key is
    always DOLLAR. It is kept rather than collapsed because the key shape is
    shared across series, and a ladder that changes shape per series is a
    ladder every reader has to special-case.
*/
const DENOMINATIONS = {
    DOLLAR: {
        label: 'Silver Dollar',
        grossGrams: GROSS_GRAMS,
        fineness: FINENESS,
        fineOz: fineOunces(GROSS_GRAMS, FINENESS)
    }
}

/*
    The two designs, held in the field the sovereign pack calls "portrait" so
    the key ladder is shared. 1921 belongs to both, and `ambiguous` marks it
    the same way the sovereign pack marks Victoria's overlapping portraits:
    a year that cannot decide the design on its own must go to review rather
    than pick one.
*/
const DESIGNS = [
    { code: 'MORGAN', label: 'Morgan', from: 1878, to: 1921 },
    { code: 'PEACE', label: 'Peace', from: 1921, to: 1935, ambiguous: true }
]

const DESIGN_BY_CODE = new Map(DESIGNS.map(d => [d.code, d]))

/*
    Mints. Philadelphia struck without a mark, exactly as London did for
    sovereigns, so an absent mintmark is a positive fact about the coin
    rather than a missing one - which is why PHI exists as a code at all.

    Carson City closed in 1893 and its dollars are the collected ones; that
    is a property of the mint, not of any particular date, and it is why the
    pool below treats every CC coin as scarce without needing a date list.
*/
const MINTS = {
    PHI: { label: 'Philadelphia', mark: '', from: 1878, to: 1935 },
    CC: { label: 'Carson City', mark: 'CC', from: 1878, to: 1893 },
    O: { label: 'New Orleans', mark: 'O', from: 1879, to: 1904 },
    S: { label: 'San Francisco', mark: 'S', from: 1878, to: 1935 },
    D: { label: 'Denver', mark: 'D', from: 1921, to: 1935 }
}

/*
    Key dates.

    Deliberately short and conservative. Every entry here is a coin whose
    scarcity is not in dispute among dealers; the long tail of semi-keys and
    VAM varieties is left out, because a pool is a claim about which coins
    are PRICE-COMPARABLE and a wrong claim there is worse than a coarse one.

    Carson City is handled by the mint rather than listed date by date - all
    of its dollars are collected, which is a fact about the mint.

    1895 is the famous one: the Philadelphia business strike is a ghost, and
    what trades under that date is the proof. It is listed so the pool is
    right; whether any given 1895 is genuine is not a question this tool can
    answer from a title.
*/
const KEY_DATES = new Set([
    'MORGAN:1893:S', 'MORGAN:1894:PHI', 'MORGAN:1895:PHI', 'MORGAN:1903:O',
    'MORGAN:1892:S', 'MORGAN:1901:PHI', 'MORGAN:1879:S',
    'PEACE:1928:PHI', 'PEACE:1934:S'
])

/*
    Pools: populations whose prices are not comparable.

    The same idea as the sovereign pack, but the fungible pool is COMMON
    rather than BULLION, because a circulated common-date Morgan is not
    bullion - it trades at one and a half to two times its silver. What it
    IS is the well-behaved population, which is the property the sovereign
    pool actually uses.

    CULL is the interesting one, and it has no sovereign equivalent: a
    holed, cleaned or polished dollar trades BELOW the common price. It is
    the first pool that sits under the fungible one, which is what proves
    these are populations rather than a ladder of specialness.
*/
const POOLS = {
    KEY_DATE: 'key date',
    GRADED: 'graded',
    PROOF: 'proof',
    CULL: 'cull',
    UNATTRIBUTED: 'unattributed',
    COMMON: 'common date'
}

/*
    Precedence is a judgement, stated here so it can be argued with.

    Rarity first: an 1889-CC is an 1889-CC whether or not anyone slabbed it,
    the same reasoning that puts EARLY first for sovereigns. Grade next,
    because it dominates what a common-date coin fetches. CULL before
    UNATTRIBUTED because damage is a fact about the coin while a missing
    date is a fact about the title.
*/
function poolFor (attrs) {
    const design = attrs.portrait
    const year = attrs.year
    const mint = attrs.mint

    if (design && year && mint && KEY_DATES.has(design + ':' + year + ':' + mint)) { return 'KEY_DATE' }
    if (mint === 'CC') { return 'KEY_DATE' }
    if (attrs.gradeBand && String(attrs.gradeBand).startsWith('SLAB_')) { return 'GRADED' }
    if (attrs.finish === 'PROOF') { return 'PROOF' }
    if (attrs.cull === true) { return 'CULL' }
    if (year === null || year === undefined) { return 'UNATTRIBUTED' }
    if (!mint) { return 'UNATTRIBUTED' }
    return 'COMMON'
}

exports.TROY_OUNCE_GRAMS = TROY_OUNCE_GRAMS
exports.DENOMINATIONS = DENOMINATIONS
exports.DESIGNS = DESIGNS
exports.DESIGN_BY_CODE = DESIGN_BY_CODE
exports.MINTS = MINTS
exports.KEY_DATES = KEY_DATES
exports.POOLS = POOLS
exports.poolFor = poolFor
exports.fineOunces = fineOunces

/* Designs whose year range contains the given year - 1921 returns both. */
exports.designsForYear = function (year) {
    if (year === null || year === undefined) { return [] }
    return DESIGNS.filter(d => year >= d.from && year <= d.to)
}
