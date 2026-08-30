'use strict'

const test = require('node:test')
const assert = require('node:assert')

const PLAUSIBILITY = require('../src/analytics/plausibility.js')

/*
    Gold has a floor, and that floor is the strongest single signal in the
    tool. Every listing below is one that actually reached the live
    opportunities panel with a large "edge" attached.
*/

const SPOT = 3292.21          /* GBP per troy ounce, the carried Friday close */
const FULL = 0.23541995686690137
const MELT = FULL * SPOT      /* about GBP 775 */

const assess = (price, fineOz) => PLAUSIBILITY.assess(price, fineOz === undefined ? FULL : fineOz, SPOT)

test('a listing priced below its own gold content cannot be that coin', () => {
    for (const [price, what] of [
        [107.64, 'the Marsh book'],
        [107.75, 'the Somme commemorative'],
        [119.15, 'the empty presentation box'],
        [120.65, 'the 1/100 oz token'],
        [285.92, 'the sunglasses']
    ]) {
        const verdict = assess(price)
        assert.strictEqual(verdict.impossible, true, what + ' at GBP ' + price)
        assert.strictEqual(verdict.verdict, 'IMPOSSIBLE')
    }
})

test('a bullion sovereign reads as bullion', () => {
    const verdict = assess(MELT * 1.08)
    assert.strictEqual(verdict.verdict, 'BULLION')
    assert.strictEqual(verdict.impossible, false)
})

test('a collector coin reads as a collector coin, not as impossible', () => {
    assert.strictEqual(assess(MELT * 1.8).verdict, 'PREMIUM')
})

test('a rarity reads as extreme rather than being called a bargain', () => {
    assert.strictEqual(assess(13358).verdict, 'EXTREME')
})

/*  A real coin can sit a shade under spot on a fast day, or where shipping
    is charged separately. Only a clear break from the metal price counts. */
test('a coin just under melt is not called impossible', () => {
    assert.strictEqual(assess(MELT * 0.95).impossible, false)
    assert.strictEqual(assess(MELT * 0.5).impossible, true)
})

/*  The melt scales with the denomination, so a quarter priced like a quarter
    is fine - it is only "impossible" when measured against the wrong coin.
    This is what made the mis-keyed quarters look like 75% discounts. */
test('a quarter priced like a quarter is plausible against a quarter', () => {
    const quarterOz = FULL / 4
    assert.strictEqual(assess(230, quarterOz).impossible, false)
    assert.strictEqual(assess(230, FULL).impossible, true)
})

test('missing inputs yield no verdict rather than a wrong one', () => {
    assert.strictEqual(PLAUSIBILITY.assess(null, FULL, SPOT), null)
    assert.strictEqual(PLAUSIBILITY.assess(100, null, SPOT), null)
    assert.strictEqual(PLAUSIBILITY.assess(100, FULL, null), null)
    assert.strictEqual(PLAUSIBILITY.assess(0, FULL, SPOT), null)
})
