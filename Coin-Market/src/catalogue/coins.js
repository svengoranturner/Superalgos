'use strict'

/*
    Physical specifications and the sovereign type taxonomy.

    Fine gold content is DERIVED from gross weight and statutory fineness
    rather than hardcoded, so the numbers are auditable. The sovereign has
    been 22 carat (11/12 fine) at 7.98805 g since the Coinage Act 1816 and
    the Royal Mint still strikes to that spec today.
*/

const TROY_OUNCE_GRAMS = 31.1034768
const SOVEREIGN_FINENESS = 11 / 12          /* 22 carat, exactly */

function fineOunces (grossGrams, fineness) {
    return (grossGrams * fineness) / TROY_OUNCE_GRAMS
}

/* Gross weights are exact multiples/fractions of the full sovereign,
   except the quarter, which the Royal Mint strikes at 1.997 g. */
const DENOMINATIONS = {
    QUARTER:   { label: 'Quarter Sovereign',   grossGrams: 1.99700 },
    HALF:      { label: 'Half Sovereign',      grossGrams: 3.99402 },
    FULL:      { label: 'Sovereign',           grossGrams: 7.98805 },
    DOUBLE:    { label: 'Double Sovereign',    grossGrams: 15.97610 },
    QUINTUPLE: { label: 'Quintuple Sovereign', grossGrams: 39.94025 }
}

for (const code of Object.keys(DENOMINATIONS)) {
    const d = DENOMINATIONS[code]
    d.code = code
    d.fineness = SOVEREIGN_FINENESS
    d.fineOz = fineOunces(d.grossGrams, SOVEREIGN_FINENESS)
}

/*
    Portrait types. Year ranges let us infer the portrait when a listing
    names only a date - which is the common case, since most sellers write
    "1974 gold sovereign" and nothing else.

    Victoria overlaps deliberately: the Young Head shield-back and the
    Young Head St George reverse were struck concurrently 1871-1885, so a
    bare year in that window cannot determine the type from the date alone.
*/
const PORTRAITS = [
    { code: 'GEORGE_III',        label: 'George III',                    from: 1817, to: 1820 },
    { code: 'GEORGE_IV',         label: 'George IV',                     from: 1821, to: 1830 },
    { code: 'WILLIAM_IV',        label: 'William IV',                    from: 1831, to: 1837 },
    { code: 'VIC_YOUNG_SHIELD',  label: 'Victoria Young Head (Shield)',  from: 1838, to: 1887, ambiguous: true },
    { code: 'VIC_YOUNG_GEORGE',  label: 'Victoria Young Head (St George)', from: 1871, to: 1885, ambiguous: true },
    { code: 'VIC_JUBILEE',       label: 'Victoria Jubilee Head',         from: 1887, to: 1893 },
    { code: 'VIC_OLD',           label: 'Victoria Old (Veiled) Head',    from: 1893, to: 1901 },
    { code: 'EDWARD_VII',        label: 'Edward VII',                    from: 1902, to: 1910 },
    { code: 'GEORGE_V',          label: 'George V',                      from: 1911, to: 1932 },
    { code: 'GEORGE_VI',         label: 'George VI',                     from: 1937, to: 1937 },
    { code: 'EII_YOUNG',         label: 'Elizabeth II Young Head',       from: 1957, to: 1968 },
    { code: 'EII_DECIMAL',       label: 'Elizabeth II Decimal Portrait', from: 1974, to: 1984 },
    { code: 'EII_THIRD',         label: 'Elizabeth II Third Portrait',   from: 1985, to: 1997 },
    { code: 'EII_FOURTH',        label: 'Elizabeth II Fourth Portrait',  from: 1998, to: 2015 },
    { code: 'EII_FIFTH',         label: 'Elizabeth II Fifth Portrait',   from: 2016, to: 2022 },
    { code: 'CHARLES_III',       label: 'Charles III',                   from: 2022, to: 2100 }
]

const PORTRAIT_BY_CODE = new Map(PORTRAITS.map(p => [p.code, p]))

/* Branch mints. London carries no mint mark, which is why absence of a
   mark is meaningful rather than merely unknown. */
const MINTS = {
    LON: { code: 'LON', label: 'London',   mark: '' },
    S:   { code: 'S',   label: 'Sydney',   mark: 'S',  from: 1871, to: 1926 },
    M:   { code: 'M',   label: 'Melbourne', mark: 'M', from: 1872, to: 1931 },
    P:   { code: 'P',   label: 'Perth',    mark: 'P',  from: 1899, to: 1931 },
    C:   { code: 'C',   label: 'Ottawa',   mark: 'C',  from: 1908, to: 1919 },
    I:   { code: 'I',   label: 'Bombay',   mark: 'I',  from: 1918, to: 1918 },
    SA:  { code: 'SA',  label: 'Pretoria', mark: 'SA', from: 1923, to: 1932 }
}

/*
    Grade bands. Deliberately coarse: eBay grade descriptions on raw coins
    are seller opinion, and pretending to distinguish "EF" from "GEF" would
    give the statistics a precision the underlying data does not support.
    Third-party slabs are the exception - those are worth banding finely,
    because the market prices them finely.
*/
const GRADE_BANDS = [
    'SLAB_PROOF', 'SLAB_MS65_PLUS', 'SLAB_MS64', 'SLAB_MS63', 'SLAB_MS62', 'SLAB_MS61_BELOW',
    'RAW_PROOF', 'RAW_BU', 'RAW_EF', 'RAW_VF', 'RAW_FINE_BELOW', 'RAW_UNSPECIFIED'
]

/*
    The bullion pool: the fungible mass of ordinary sovereigns that trade
    on gold content plus a thin premium. This is the deep, statistically
    well-behaved population - the one that can answer "what is a sovereign
    worth today" with a tight band.

    Excluded from the pool: proofs (numismatic product), high-grade slabs
    (graded rarity), and the pre-Victorian and branch-mint scarcities that
    trade on rarity rather than metal.
*/
/*
    Is this a bullion-grade coin, priced off its gold content?

    The bullion pool is the one whose premium should be small and stable, so
    it has to be the pool we are SURE about. An unknown year or mint used to
    fall through to bullion, which inverted that: on the live store 621 of
    1,134 supposedly-bullion asks had no mint parsed and 287 no year, and
    they dragged the median ask to 41% over melt where bullion runs nearer
    10-15%. A Tudor Edward VI sovereign whose "1551-1553" never parsed as a
    year sat in the bullion pool at GBP 20,000.

    So an unparsed attribute now disqualifies rather than defaults. It is the
    same rule keyAt already follows by refusing to invent an "unknown mint"
    bucket, applied one level up: not knowing is not evidence of ordinariness.

    The cost is one-sided on purpose. A plain sovereign whose mint went
    unread is merely absent from the bullion median, which loses a little
    sample. A rare branch-mint coin admitted by default corrupts it.
*/
function isBullionPool (attrs) {
    if (attrs.finish === 'PROOF') { return false }
    if (attrs.gradeBand && attrs.gradeBand.startsWith('SLAB_') &&
        attrs.gradeBand !== 'SLAB_MS61_BELOW' && attrs.gradeBand !== 'SLAB_MS62') { return false }
    if (attrs.year === null || attrs.year === undefined) { return false }
    if (attrs.year < 1871) { return false }
    if (!attrs.mint) { return false }
    if (attrs.mint !== 'LON') { return false }
    return true
}

exports.TROY_OUNCE_GRAMS = TROY_OUNCE_GRAMS
exports.SOVEREIGN_FINENESS = SOVEREIGN_FINENESS
exports.DENOMINATIONS = DENOMINATIONS
exports.PORTRAITS = PORTRAITS
exports.PORTRAIT_BY_CODE = PORTRAIT_BY_CODE
exports.MINTS = MINTS
exports.GRADE_BANDS = GRADE_BANDS
exports.fineOunces = fineOunces
exports.isBullionPool = isBullionPool

/* Portraits whose year range contains the given year. */
exports.portraitsForYear = function (year) {
    if (year === null || year === undefined) { return [] }
    return PORTRAITS.filter(p => year >= p.from && year <= p.to)
}
