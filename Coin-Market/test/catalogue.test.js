'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { classify } = require('../src/catalogue/classify.js')
const EXCLUSIONS = require('../src/catalogue/exclusions.js')
const INSTRUMENTS = require('../src/catalogue/instruments.js')
const COINS = require('../src/catalogue/coins.js')

/*
    Classification is the whole ballgame: every downstream statistic is
    computed over whatever these rules let through. A mounted pendant or a
    job lot in the sample does not add noise, it biases the clearing price
    in a specific direction and produces a confident wrong answer.
*/

test('coin specifications derive the published fine gold content', () => {
    /* The sovereign has been 7.98805 g at 22 carat since 1816; the
       universally quoted fine content is 0.2354 troy oz. If this drifts,
       every premium in the system is wrong. */
    assert.ok(Math.abs(COINS.DENOMINATIONS.FULL.fineOz - 0.2354) < 0.00005)
    assert.ok(Math.abs(COINS.DENOMINATIONS.HALF.fineOz - 0.1177) < 0.00005)
    /* Not an exact doubling: the Royal Mint publishes the half sovereign
       at 3.99402 g, a rounded figure, so it is a whisker under half of
       7.98805 g. Assert to the precision the published specs actually
       carry rather than to floating-point equality. */
    assert.ok(Math.abs(COINS.DENOMINATIONS.FULL.fineOz - 2 * COINS.DENOMINATIONS.HALF.fineOz) < 1e-5)
})

test('junk that would poison the sample is excluded', () => {
    const mustDrop = [
        '9ct Gold Sovereign Mount Pendant',
        'Sovereign Ring Mount 9ct',
        'COPY 1817 Gold Sovereign Replica',
        'Gold Plated Sovereign Coin',
        'Brass Sovereign Token Medal',
        'Gold Sovereign Coin Case Holder Empty',
        '5 x Gold Sovereigns Job Lot',
        'Three Gold Sovereigns Bundle',
        'Set of 3 Gold Sovereigns'
    ]
    for (const title of mustDrop) {
        assert.notStrictEqual(EXCLUSIONS.screen(title, null), null, 'should have dropped: ' + title)
    }
})

test('genuine listings survive the exclusion filters', () => {
    const mustKeep = [
        '1974 Gold Full Sovereign Elizabeth II',
        '2023 Charles III Gold Proof Sovereign Boxed',
        '1900 Victoria Old Head Gold Sovereign Melbourne',
        'Gold Sovereign NGC MS63 1957'
    ]
    for (const title of mustKeep) {
        assert.strictEqual(EXCLUSIONS.screen(title, null), null, 'should have kept: ' + title)
    }
})

test('a composition aspect overrides an optimistic title', () => {
    const dropped = EXCLUSIONS.screen('Sovereign Coin 1974', { Composition: 'Silver' })
    assert.strictEqual(dropped.code, 'NOT_GOLD')
})

test('year, denomination, mint and grade are extracted', () => {
    const result = classify({ title: '1900 Victoria Old Head Gold Sovereign Melbourne Mint' })
    assert.strictEqual(result.attributes.year, 1900)
    assert.strictEqual(result.attributes.denomination, 'FULL')
    assert.strictEqual(result.attributes.portrait, 'VIC_OLD')
    assert.strictEqual(result.attributes.mint, 'M')

    const half = classify({ title: 'Half Sovereign 1982 Gold Coin' })
    assert.strictEqual(half.attributes.denomination, 'HALF')

    const slab = classify({ title: 'Gold Sovereign NGC MS63 1957 Elizabeth II' })
    assert.strictEqual(slab.attributes.gradeBand, 'SLAB_MS63')
})

test('"half sovereign" is never classified as a full sovereign', () => {
    /* The word "sovereign" appears in both, and getting this wrong would
       silently halve every premium for half sovereigns. */
    for (const title of ['Half Sovereign 1982', '1/2 Sovereign Gold 1911', 'Gold Half-Sov 1914']) {
        assert.strictEqual(classify({ title }).attributes.denomination, 'HALF', title)
    }
})

test('a genuinely ambiguous year is sent to review rather than guessed', () => {
    /* Victoria shield-back and St George sovereigns were struck
       concurrently 1871-1885, so a bare date cannot separate them - and
       they do not trade at the same price. */
    const result = classify({ title: '1880 Gold Sovereign Victoria' })
    assert.strictEqual(result.attributes.portrait, null)
    assert.strictEqual(result.needsReview, true)
})

test('an impossible mint/year pairing is rejected, not recorded', () => {
    /* Perth did not strike sovereigns in 1850. */
    const result = classify({ title: '1850 Gold Sovereign Perth Mint' })
    assert.strictEqual(result.attributes.mint, null)
})

test('structured aspects beat the title parser', () => {
    const result = classify({
        title: 'Gold Sovereign nice coin',
        aspects: { Year: '1911', Certification: 'PCGS', Grade: 'MS64' }
    })
    assert.strictEqual(result.attributes.year, 1911)
    assert.strictEqual(result.attributes.gradeBand, 'SLAB_MS64')
})

test('instrument keys nest from general to specific', () => {
    const result = classify({ title: '1900 Victoria Old Head Gold Sovereign Melbourne Mint' })
    const keys = INSTRUMENTS.keysFor(result.attributes)
    /* Melbourne is a branch mint, so this coin is not in the bullion pool -
       the split shows up from the very first level. */
    assert.deepStrictEqual(keys.map(k => k.key), [
        'GB.SOV.COLLECTOR.FULL',
        'GB.SOV.COLLECTOR.FULL.VIC_OLD',
        'GB.SOV.COLLECTOR.FULL.VIC_OLD.1900',
        'GB.SOV.COLLECTOR.FULL.VIC_OLD.1900.M',
        'GB.SOV.COLLECTOR.FULL.VIC_OLD.1900.M.RAW_UNSPECIFIED'
    ])
})

test('an unknown attribute truncates the key chain instead of inventing a bucket', () => {
    /* An "unknown mint" bucket would merge London coins with branch mints
       that trade at multiples of the price. */
    const keys = INSTRUMENTS.keysFor({
        series: 'GB.SOV', denomination: 'FULL', portrait: 'GEORGE_V', year: 1912,
        mint: null, gradeBand: 'RAW_BU'
    })
    assert.strictEqual(keys.length, 3)
    assert.strictEqual(keys[keys.length - 1].key, 'GB.SOV.BULLION.FULL.GEORGE_V.1912')
})

test('the bullion pool excludes proofs, high slabs and branch mints', () => {
    const pool = (attrs) => COINS.isBullionPool(Object.assign(
        { finish: 'BULLION', gradeBand: 'RAW_UNSPECIFIED', year: 1974, mint: 'LON' }, attrs))
    assert.strictEqual(pool({}), true)
    assert.strictEqual(pool({ finish: 'PROOF' }), false)
    assert.strictEqual(pool({ gradeBand: 'SLAB_MS65_PLUS' }), false)
    assert.strictEqual(pool({ mint: 'M' }), false)
    assert.strictEqual(pool({ year: 1850 }), false)
})

/*
    Bullion and collector coins are separate instruments.

    Sellers split by format - bullion to auction, proofs and slabs and branch
    mints to buy-it-now at collector prices - so pooling them compared auction
    clearing against numismatic asks and invented an opportunity that was not
    there.
*/

test('a plain London bullion sovereign lands in the bullion pool', () => {
    const keys = INSTRUMENTS.keysFor({
        series: 'GB.SOV', denomination: 'FULL', portrait: 'GEORGE_V', year: 1912,
        mint: 'LON', gradeBand: 'RAW_UNSPECIFIED', bullionPool: true
    })
    assert.ok(keys[0].key.startsWith('GB.SOV.BULLION.'), keys[0].key)
})

test('a proof, a slab and a branch mint all land in the collector pool', () => {
    for (const attrs of [
        { finish: 'PROOF', mint: 'LON', year: 1980 },
        { gradeBand: 'SLAB_MS65_PLUS', mint: 'LON', year: 1980 },
        { mint: 'M', year: 1900 },
        { mint: 'LON', year: 1850 }
    ]) {
        const full = Object.assign({ series: 'GB.SOV', denomination: 'FULL' }, attrs)
        full.bullionPool = COINS.isBullionPool(full)
        assert.ok(INSTRUMENTS.keyAt(full, 0).startsWith('GB.SOV.COLLECTOR.'),
            JSON.stringify(attrs) + ' -> ' + INSTRUMENTS.keyAt(full, 0))
    }
})

/*  The two pools must never resolve to the same key at any depth, or the
    headline silently re-pools them. */
test('the pools stay separate at every level of the hierarchy', () => {
    const base = {
        series: 'GB.SOV', denomination: 'FULL', portrait: 'GEORGE_V', year: 1912,
        mint: 'LON', gradeBand: 'RAW_UNSPECIFIED'
    }
    const bullion = INSTRUMENTS.keysFor(Object.assign({}, base, { bullionPool: true })).map(k => k.key)
    const collector = INSTRUMENTS.keysFor(Object.assign({}, base, { bullionPool: false })).map(k => k.key)
    assert.strictEqual(bullion.length, collector.length)
    for (let i = 0; i < bullion.length; i++) {
        assert.notStrictEqual(bullion[i], collector[i])
    }
    assert.strictEqual(collector.filter(k => bullion.includes(k)).length, 0)
})

test('both pools are named, so no instrument reads as an unqualified sovereign', () => {
    assert.match(INSTRUMENTS.displayName('GB.SOV.BULLION.FULL'), /bullion/i)
    assert.match(INSTRUMENTS.displayName('GB.SOV.COLLECTOR.FULL'), /collector/i)
})

test('display names still resolve portrait, mint and grade past the pool segment', () => {
    const name = INSTRUMENTS.displayName('GB.SOV.COLLECTOR.FULL.VIC_OLD.1900.M.SLAB_MS63')
    assert.match(name, /1900/)
    assert.match(name, /MS63/)
    assert.ok(!name.includes('VIC_OLD'), 'portrait code should render as a label: ' + name)
    assert.ok(!name.includes('.M.'), name)
})

/*  Not knowing is not evidence of ordinariness. An unparsed year or mint used
    to fall through into the bullion pool, where a Tudor sovereign at GBP
    20,000 dragged the median ask to 41% over melt. */
test('an unparsed year or mint keeps a coin out of the bullion pool', () => {
    const base = { finish: 'BULLION', gradeBand: 'RAW_UNSPECIFIED', year: 1974, mint: 'LON' }
    assert.strictEqual(COINS.isBullionPool(base), true, 'a known London 1974 is bullion')
    assert.strictEqual(COINS.isBullionPool(Object.assign({}, base, { year: null })), false)
    assert.strictEqual(COINS.isBullionPool(Object.assign({}, base, { mint: null })), false)
    assert.strictEqual(COINS.isBullionPool(Object.assign({}, base, { year: undefined })), false)
})

/*  Three gaps found by reading the live bullion pool: things that are not
    coins, fractions the series does not mint, and Sheldon grades the parser
    walked straight past. */

test('publications and memorabilia are not coins', () => {
    for (const title of [
        '1982 Ipswich : The Golden Sovereign Speedway Programme',
        'The Gold Sovereign by Michael A. Marsh 1st Edition 1980',
        '1974 IPSWICH SPEEDWAY GOLDEN SOVEREIGN'
    ]) {
        const screened = EXCLUSIONS.screen(title, null)
        assert.ok(screened !== null, 'should be excluded: ' + title)
    }
})

test('a coin that merely commemorates the sovereign is not a sovereign', () => {
    assert.ok(EXCLUSIONS.screen('2009 UK £2 Two Pounds Coin - Anniversary of the Gold Sovereign', null) !== null)
})

/*  The Double Sovereign is a real coin described as "two pound sovereign",
    and must survive the rule above. */
test('the genuine Double Sovereign is not caught by the commemorative rule', () => {
    assert.strictEqual(EXCLUSIONS.screen('1887 Victoria Double Sovereign two pound sovereign', null), null)
})

/*  These were previously only refused a denomination, which parked 94 of
    them in the review queue permanently: the classifier could decline to
    price them but had no way to say why. The Royal Mint's smallest
    sovereign is the quarter, so they are excluded with a reason instead. */
test('an eighth or tenth sovereign is not a sovereign at all', () => {
    for (const title of [
        '2025 King Charles III Classics Remastered 1/8 Sovereign 22ct Gold',
        /*  Sellers write the ordinal as often as the bare fraction, and a
            word boundary after the digit does not match "8th". */
        'Hattons Of London 1/8th Gold Sovereign Coin 2022',
        'King Charles III Accession 1/8th Gold Sovereign',
        '2024 D-Day 80th Anniversary Gold Proof One-Eighth Sovereign',
        '1/10th Gold Proof Sovereign',
        'Tenth Sovereign gold coin'
    ]) {
        assert.strictEqual(classify({ title }).excluded.code, 'SUB_SOVEREIGN', title)
    }
})

/*  A limited-edition number is not a denomination. Bounding the fractions
    to the ones the series does not mint is what keeps "1/50" out. */
test('an edition number is not mistaken for a fraction of a sovereign', () => {
    const c = classify({ title: '2017 Gold Proof Sovereign Limited Edition 1/50 Royal Mint' })
    assert.strictEqual(c.excluded, null)
    assert.strictEqual(c.attributes.denomination, 'FULL')
})

test('a quarter and a half are still recognised', () => {
    assert.strictEqual(classify({ title: '1/4 Gold Sovereign 2015' }).attributes.denomination, 'QUARTER')
    assert.strictEqual(classify({ title: 'Half Sovereign 1982' }).attributes.denomination, 'HALF')
})

test('a bare Sheldon grade is read as a graded coin, not as ungraded', () => {
    const graded = classify({ title: 'Victoria 1874 shield Sovereign, London, die 33, AU50' })
    assert.ok(String(graded.attributes.gradeBand).startsWith('SLAB_'), graded.attributes.gradeBand)
    const plain = classify({ title: '1974 Gold Sovereign Elizabeth II London' })
    assert.strictEqual(plain.attributes.gradeBand, 'RAW_UNSPECIFIED')
})

test('a year is never mistaken for a Sheldon grade', () => {
    const r = classify({ title: '1912 George V Gold Sovereign London Mint' })
    assert.strictEqual(r.attributes.year, 1912)
    assert.strictEqual(r.attributes.gradeBand, 'RAW_UNSPECIFIED')
})

/*  Someone who has paid to have a coin graded is not selling it as metal.
    The low slab bands used to be allowed into bullion; once bare Sheldon
    numbers were read, that band filled with GBP 13,000 rarities. */
test('every slabbed band is a collector coin, including the low ones', () => {
    const base = { finish: 'BULLION', year: 1974, mint: 'LON' }
    for (const band of ['SLAB_PROOF', 'SLAB_MS65_PLUS', 'SLAB_MS64', 'SLAB_MS63', 'SLAB_MS62', 'SLAB_MS61_BELOW']) {
        assert.strictEqual(COINS.isBullionPool(Object.assign({}, base, { gradeBand: band })), false, band)
    }
    assert.strictEqual(COINS.isBullionPool(Object.assign({}, base, { gradeBand: 'RAW_UNSPECIFIED' })), true)
    assert.strictEqual(COINS.isBullionPool(Object.assign({}, base, { gradeBand: 'RAW_BU' })), true)
})

/*
    eBay's own category ancestry, which beats any title regex.

    The seller has already told eBay what they are listing, and every search
    result carries the whole ancestor chain. That is the only test that both
    keeps the Australian Sydney half-sovereigns - 2,491 of them, which every
    leaf allow-list threw away because world coins hang off a different root
    on EBAY_GB - and drops a Royal Doulton cup.
*/

test('a listing whose ancestry includes Coins is kept', () => {
    for (const path of [
        'Coins > Coins > British > Victoria (1837-1901) > Sovereign',
        'Coins > Bullion/Bars > Gold Bullion > Coins',
        'Coins > Coins > World Coins > Australia'
    ]) {
        assert.strictEqual(EXCLUSIONS.screenCategory(path), null, path)
    }
})

test('a listing with no coin anywhere in its ancestry is excluded', () => {
    for (const [path, what] of [
        ['Pottery, Porcelain & Glass > Porcelain & China > Royal Doulton', 'the coffee cup'],
        ['Jewellery & Watches > Watches, Parts & Accessories > Wristwatches', 'the Sovereign watch'],
        ['Sporting Goods > Fishing > Reels', 'the Hardy reel'],
        ['Jewellery & Watches > Fine Jewellery > Rings', 'the sovereign ring']
    ]) {
        const screened = EXCLUSIONS.screenCategory(path)
        assert.ok(screened !== null, what + ' should be excluded')
        /*  The path travels with the reason: a false positive here deletes a
            whole class of listing, and this is what makes it diagnosable. */
        assert.ok(screened.reason.includes(path), screened.reason)
    }
})

test('a missing ancestry is not treated as evidence of anything', () => {
    assert.strictEqual(EXCLUSIONS.screenCategory(null), null)
    assert.strictEqual(EXCLUSIONS.screenCategory(undefined), null)
    assert.strictEqual(EXCLUSIONS.screenCategory(''), null)
})

/*  "Bullion" alone is enough - the gold bullion subtree is where a great
    many sovereigns actually live. */
test('the bullion subtree counts as coins', () => {
    assert.strictEqual(EXCLUSIONS.screenCategory('Coins > Bullion/Bars > Gold Bullion > Bars & Rounds'), null)
})

/*
    Two parser gaps found by reading the dashboard's own review queue and
    opportunities panel against real listings.
*/

test('the mint letter glued to the year is read, not lost', () => {
    /*  A word boundary after the digits never matches "1887S", because S is
        a word character. This was most of the "Year not identified" queue. */
    for (const [title, year, mint] of [
        ['1887S J/Head Half Sovereign Shield T/A Close JEB', 1887, 'S'],
        ['1909P rated MS61/UNC Half Sovereign 44K Minted.', 1909, 'P'],
        ['1882M Half Sovereign rated NGEM/MS66 Type 4/3', 1882, 'M']
    ]) {
        const a = classify({ title }).attributes
        assert.strictEqual(a.year, year, title)
        assert.strictEqual(a.mint, mint, title)
    }
})

test('a plain year with no mint letter still reads, and invents no mint', () => {
    const a = classify({ title: '1911 George V Gold Full Sovereign' }).attributes
    assert.strictEqual(a.year, 1911)
})

/*  Pricing a quarter against a full sovereign's 7.99g of gold manufactures a
    75% discount that is not there, and those were live "opportunities". */
test('a hyphenated or spaced quarter is still a quarter', () => {
    for (const title of [
        'Charles III 2023 PF69 FDI Quarter-Sovereign Coronation',
        '2013 Gold Proof Limited Edition Quarter 2g Sovereign-Box & COA',
        /*  "Qtr" is the Royal Mint's own abbreviation on listing titles. */
        '2012 Royal Mint QE II Diamond Jubilee Gold Proof Qtr Sovereign AGW 1.83g Box COA'
    ]) {
        assert.strictEqual(classify({ title }).attributes.denomination, 'QUARTER', title)
    }
})

/*  Brackets and commas between the denomination word and "sovereign" broke
    the match, because the gap class was only word characters, spaces,
    hyphens and dots. A genuine 1980 half sovereign proof was priced against
    a full sovereign's gold and duly suppressed from the opportunities panel
    as "below melt - not this coin". */
test('punctuation between the denomination and the word does not lose it', () => {
    for (const [title, expected] of [
        ['1980 Gold Proof 1/2 (Half) Sovereign - Box & COA', 'HALF'],
        ['gold quarter new design ,sovereign coins gold', 'QUARTER'],
        ['2013 Gold Proof Quarter (1/4) Sovereign Royal Mint', 'QUARTER'],
        ["Victoria's Half (1/2) Sovereign 1887", 'HALF']
    ]) {
        assert.strictEqual(classify({ title }).attributes.denomination, expected, title)
    }
    /* and the gap is still bounded - this is two separate coins mentioned */
    assert.strictEqual(
        classify({ title: 'Half Crown 1946 and a nice boxed gold sovereign here' }).attributes.denomination,
        'FULL')
})

/*  Nine seller phrasings for the multi-weight sovereigns all fell through
    to the FULL catch-all, because the multiplier had to sit immediately
    before the word. 87 live lots were priced against a half or a fifth of
    the gold they actually contain, and a GBP 9,654 five-sovereign piece
    duly read 1146% over melt. */
test('a five-pound or two-pound sovereign is not a full sovereign', () => {
    for (const [title, expected] of [
        ['1989 Great Britain Gold 5 Sovereign NGC PF70 Ultra Cameo', 'QUINTUPLE'],
        /* the plural in POUNDS is what broke the old adjacency rule */
        ['2014 GOLD 375 MINTED GREAT BRITAIN 5 POUNDS SOVEREIGN NGC PF 70 UC', 'QUINTUPLE'],
        ['KING EDWARD VII 1902 £5 GOLD SOVEREIGN', 'QUINTUPLE'],
        ['1893 Great Britain Victoria Gold £2 Sovereign MS65 Graded By PCGS', 'DOUBLE'],
        ['UK - GREAT BRITAIN , GOLD 2 SOV. CORONATION 2023', 'DOUBLE'],
        ['1988 GOLD GREAT BRITAIN 2 POUNDS SOVEREIGN PROOF', 'DOUBLE'],
        /*  A piedfort is struck at double thickness, so it carries a double
            sovereign's gold - which is the quantity this tool measures. */
        ['2017 Piedfort Proof Full Gold Sovereign Only 3400 Issued', 'DOUBLE'],
        ['Great Britain 2018 Piefort Sovereign 0.47 Oz AGW Gold Proof Coin NGC PF70', 'DOUBLE']
    ]) {
        assert.strictEqual(classify({ title }).attributes.denomination, expected, title)
    }
})

/*  "Type 2" is a portrait variety of an ordinary full sovereign. Without the
    lookbehind the multi-weight rule eats it and doubles its melt. */
test('a portrait variety number is not a multiplier', () => {
    assert.strictEqual(classify({ title: 'Victoria 1893 Type 2 Sovereign Old Head' }).attributes.denomination, 'FULL')
    assert.strictEqual(classify({ title: '1974 Gold Sovereign Elizabeth II' }).attributes.denomination, 'FULL')
})

/*  The word after, not before. This was a genuine half sovereign priced
    against a full sovereign's gold, sitting in the live opportunities
    panel as a bargain. */
test('a denomination written after the word sovereign still counts', () => {
    for (const [title, expected] of [
        ['Royal Mint 2013 Gold Proof Sovereign Half with Original Box and Certificate', 'HALF'],
        ['2003 Gold Sovereign Half Proof Coin NGC PF70 Ultra Cameo Royal Mint', 'HALF'],
        ['2024 Gold Sovereign Quarter NGC MS69 Britain Royal Mint', 'QUARTER']
    ]) {
        assert.strictEqual(classify({ title }).attributes.denomination, expected, title)
    }
})

/*  There is no Edward VIII sovereign. He abdicated before any circulating
    coinage; every one on the market is a private fantasy strike, and NGC
    slabs those as readily as coins so the grade is no help. */
test('an Edward VIII sovereign is a fantasy piece', () => {
    for (const title of [
        '1984 STRAITS RARE 200 MINTED 1 SOVEREIGN EDWARD VIII NGC PROOF 69 CAMEO',
        '1984 (1936) GOLD GIBRALTAR 200 MINTED SOVEREIGN EDWARD VIII NGC PROOF 68 UC',
        'RARE House of Windsor Edward VIII 22ct Gold Quarter proof Sovereign'
    ]) {
        assert.strictEqual(classify({ title }).excluded.code, 'FANTASY_ISSUE', title)
    }
    /* Edward VII, one numeral shorter, is a real and common sovereign. */
    assert.strictEqual(classify({ title: '1907 Edward VII Gold Sovereign' }).excluded, null)
})

/*  A sovereign is 22ct by definition, so the fineness alone settles it -
    no keyword list required, and it catches bars, Britannias and foreign
    proofs that share nothing but the word "sovereign" in the title. */
test('fineness that is not 22ct means it is not a sovereign', () => {
    for (const title of [
        '5g 24k 24ct Gold Umicore Bar Bullion Sovereign Antique Vintage',
        '2023 Great Britain .9999 Gold 1/10 oz Gem BU Royal Coat of Arms',
        'GOLD COIN- Pitcarn Islands 10 Dollar 1999 HMS Bounty 0.999 fine gold 1.224g'
    ]) {
        assert.strictEqual(classify({ title }).excluded.code, 'NOT_A_SOVEREIGN', title)
    }
})

/*  A mintage figure is not a fineness. The loose "999" form would have
    deleted both of these, which are genuine sovereigns. */
test('a mintage of 999 is not a claim about purity', () => {
    for (const title of [
        '2022 St George & The Dragon Gold Matte Proof Sovereign. Mintage 999',
        '2026 queen elizabeth II centenary gold proof half sovereign (999 mintage)'
    ]) {
        assert.strictEqual(classify({ title }).excluded, null, title)
    }
})

/*  27 Hardy fly reels and 55 rings were being priced as coins. */
test('reels, rings and watches are not coins', () => {
    assert.strictEqual(classify({ title: 'HARDY GOLD SOVEREIGN 9/10 SALMON FLY FISHING REEL' }).excluded.code, 'NOT_A_COIN')
    assert.strictEqual(classify({ title: '2001 Queen Elizabeth II Half Sovereign Ring 9.64g Size W' }).excluded.code, 'JEWELLERY')
    assert.strictEqual(classify({ title: 'Sovereign Vintage Ladies Watch Swiss Made' }).excluded.code, 'JEWELLERY')
})

/*  Sellers spell the count out far more often than they use a digit. */
test('a spelled-out coin count is still a multi-coin set', () => {
    for (const title of [
        'Sovereign 2026 Three-Coin Gold Proof Set Limited Edition 650 Worldwide',
        '2007 UK Gold Proof Four-coin Sovereign Collection (Boxed)',
        'Gold Coins Sovereign Lot Perth Mint 125. Jubilee 2024 Australia'
    ]) {
        assert.strictEqual(classify({ title }).excluded.code, 'PROOF_SET_OR_BUNDLE', title)
    }
})

test('a hyphenated half is still a half', () => {
    assert.strictEqual(classify({ title: 'Half-Sovereign 1982' }).attributes.denomination, 'HALF')
})

test('a plain sovereign is still full, and a double still double', () => {
    assert.strictEqual(classify({ title: '1974 Gold Sovereign Elizabeth II' }).attributes.denomination, 'FULL')
    assert.strictEqual(classify({ title: '1887 Victoria Double Sovereign' }).attributes.denomination, 'DOUBLE')
})

/*  Sellers use the typographic fractions, and the plausibility verdict is
    what surfaced this: a genuine 2012 quarter sovereign was flagged "below
    melt" because the unicode quarter fell through to FULL and was measured
    against a full sovereign's gold content. */
test('typographic fractions are read as denominations', () => {
    assert.strictEqual(classify({ title: '2012 ¼ Sovereign Elizabeth II Diamond Jubilee BU' }).attributes.denomination, 'QUARTER')
    assert.strictEqual(classify({ title: '½ Sovereign 1982' }).attributes.denomination, 'HALF')
    assert.strictEqual(classify({ title: '⅛ Sovereign 2022 gold proof' }).excluded.code, 'SUB_SOVEREIGN')
})

/*  A lot in Cyprus is a different market from one in Birmingham - different
    postage, buyer pool and clearing price - and averaging the two describes
    neither. */
test('location screening does nothing unless a country list is chosen', () => {
    /*  The default that matters. Screening to GB alone removed 1,268 genuine
        sovereigns in one pass, 744 of them Australian - Sydney, Melbourne and
        Perth mint coins are British sovereigns and the scarcest part of the
        series. It is the same error migration 004 documents at the category
        level, where a leaf allow-list discarded 2,491 of them. */
    for (const country of ['CY', 'AU', 'US', 'GB']) {
        assert.strictEqual(EXCLUSIONS.screenLocation(country), null,
            country + ' must not be screened without an explicit allow-list')
        assert.strictEqual(EXCLUSIONS.screenLocation(country, []), null)
    }
    /* Opted into, it works. */
    const cy = EXCLUSIONS.screenLocation('CY', ['GB'])
    assert.strictEqual(cy.code, 'NOT_ALLOWED_COUNTRY')
    assert.match(cy.reason, /CY/)
    assert.strictEqual(EXCLUSIONS.screenLocation('gb', ['GB']), null)
})

/*  The load-bearing one. Every listing stored before the column existed has
    a NULL country until the next sweep re-sees it, so unknown must mean
    "not known yet" and never "foreign" - the other way round, one migration
    empties the entire market. */
test('an unknown location is never treated as foreign', () => {
    for (const unknown of [null, undefined, '']) {
        assert.strictEqual(EXCLUSIONS.screenLocation(unknown), null,
            'unknown location must fail open, got a screen for ' + JSON.stringify(unknown))
    }
})

test('the permitted country list can be widened without code changes', () => {
    assert.strictEqual(EXCLUSIONS.screenLocation('IE', ['GB', 'IE']), null)
    assert.strictEqual(EXCLUSIONS.screenLocation('US', ['GB', 'IE']).code, 'NOT_ALLOWED_COUNTRY')
})

/*  A title can trip a rule by saying the opposite of what the rule looks for,
    and it was costing the most valuable rows in the store - completed
    auctions with real hammer prices. Three sovereigns that sold for GBP 809,
    829 and 861 with 7, 15 and 28 bids were dropped on the word "mounted",
    in the phrase "Never Cleaned Or Mounted". */
test('a coin described as never mounted is not jewellery', () => {
    for (const title of [
        'Lustrous Uncirculated King Edward V11 Full Gold Sovereign. Never Cleaned/mounted',
        'Scarce 1918 I King George V Full Gold Sovereign - Never Cleaned Or Mounted',
        'Nice 1919 P King George V Full Gold Sovereign - Never Cleaned Or Mounted.',
        '1925 Gold Sovereign, unmounted, original patina'
    ]) {
        assert.strictEqual(classify({ title }).excluded, null, title)
    }
})

/*  A capsule is what the coin arrived in, not what is being sold. Two more
    completed sales, GBP 795 and GBP 405. */
test('a coin in a capsule is a coin, but a bag of capsules is not', () => {
    for (const title of [
        '1906 King Edward VII Full Sovereign Gold Coin, 22ct in Capsule',
        '1900 Queen Victoria Gold Half Sovereign In Capsule Nice Condition',
        '2013 Gold Proof Sovereign Boxed with Certificate'
    ]) {
        assert.strictEqual(classify({ title }).excluded, null, title)
    }
    /*  The plural is the trap: a trailing word boundary meant "Capsules"
        never matched "capsule", so a listing selling ten of them read as a
        coin. */
    for (const title of [
        '10 x Gold Coin Capsules for Sovereigns',
        'Gold Sovereign Coin Case Holder Empty',
        'Coin Holders for Half Sovereigns pack of 20'
    ]) {
        assert.strictEqual(classify({ title }).excluded.code, 'ACCESSORY', title)
    }
})

/*  The scrub must not become a way to smuggle jewellery back in. */
test('genuinely mounted coins are still dropped', () => {
    for (const title of [
        '1911 Gold Half Sovereign Mounted In 9ct Pendant',
        '9ct Gold FULL Sovereign Fancy Coin Mount Pendant 2.6 grams',
        'Gold Sovereign Ring Size T',
        'Sovereign Hallmarked Gold Mens 9 Carat Gold Quartz Dress Watch'
    ]) {
        assert.strictEqual(classify({ title }).excluded.code, 'JEWELLERY', title)
    }
})
