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
    assert.deepStrictEqual(keys.map(k => k.key), [
        'GB.SOV.FULL',
        'GB.SOV.FULL.VIC_OLD',
        'GB.SOV.FULL.VIC_OLD.1900',
        'GB.SOV.FULL.VIC_OLD.1900.M',
        'GB.SOV.FULL.VIC_OLD.1900.M.RAW_UNSPECIFIED'
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
    assert.strictEqual(keys[keys.length - 1].key, 'GB.SOV.FULL.GEORGE_V.1912')
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
