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

test('an eighth or tenth sovereign is not a full sovereign', () => {
    for (const title of [
        '2025 King Charles III Classics Remastered 1/8 Sovereign 22ct Gold',
        'Tenth Sovereign gold coin'
    ]) {
        assert.strictEqual(classify({ title }).attributes.denomination, null, title)
    }
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
