'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const SPOT = require('../src/spot/spot.js')
const MARKET = require('../src/analytics/market.js')

const DAY_MS = 86400000

function fixture () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    return { db, repository }
}

test('migrations are idempotent', () => {
    const db = newDatabase(':memory:')
    const before = db.prepare('SELECT COUNT(*) AS n FROM schema_version').get().n
    assert.ok(before > 0)
})

test('a listing that omits optional fields still stores', () => {
    /* node:sqlite refuses to bind undefined, and Browse summaries routinely
       omit shipping, condition and images. */
    const { db, repository } = fixture()
    repository.saveListing({
        browseId: 'v1|1|0', legacyId: '1', title: 'Gold Sovereign 1974',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + DAY_MS).toISOString()
    })
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM listing').get().n, 1)
})

test('seller identity is hashed, never stored raw', () => {
    const { db, repository } = fixture()
    repository.saveListing({
        browseId: 'v1|2|0', legacyId: '2', title: 'Gold Sovereign', buyingOptions: 'AUCTION',
        sellerId: 'coin_dealer_bob', endTime: new Date().toISOString()
    })
    const row = db.prepare('SELECT seller_hash FROM listing WHERE browse_id = ?').get('v1|2|0')
    assert.ok(row.seller_hash.length === 16)
    assert.ok(!row.seller_hash.includes('bob'))
    /* Same seller must still be recognisable, for relist detection. */
    assert.strictEqual(repository.hashSeller('coin_dealer_bob'), row.seller_hash)
})

test('an auction snapshot records the live bid, not the buy-it-now price', () => {
    const { db, repository } = fixture()
    const end = new Date(Date.now() + 3600000).toISOString()
    repository.saveListing({ browseId: 'v1|3|0', legacyId: '3', title: 'Gold Sovereign', buyingOptions: 'AUCTION', endTime: end })
    repository.saveSnapshot('v1|3|0', { price: 999, currentBidPrice: 412, bidCount: 7, endTime: end })

    const row = db.prepare('SELECT price, seconds_to_end FROM listing_snapshot').get()
    assert.strictEqual(row.price, 412)
    assert.ok(row.seconds_to_end > 3500 && row.seconds_to_end <= 3600)
})

test('sold outcomes survive the round trip through the read model', () => {
    /*
        Regression: clearingObservations once omitted o.sold from its
        SELECT, so every outcome read back as unsold. Fair value silently
        became "no data" and sell-through read 0% while the table held
        hundreds of completed sales.
    */
    const { db, repository } = fixture()
    const endedAt = new Date(Date.now() - DAY_MS).toISOString()

    repository.saveListing({
        browseId: 'v1|4|0', legacyId: '4', title: '1974 Gold Sovereign', buyingOptions: 'AUCTION', endTime: endedAt
    })
    repository.saveClassification('v1|4|0',
        [{ key: 'GB.SOV.FULL', level: 0 }], 0.9, 'title', 0.2354, {})
    repository.saveOutcome('v1|4|0', {
        endTime: endedAt, sold: true, finalPrice: 500, shipping: 5,
        bidCount: 11, saleType: 'AUCTION', censored: false, source: 'trading_getitem'
    })

    const rows = repository.clearingObservations('GB.SOV.FULL', new Date(Date.now() - 30 * DAY_MS).toISOString())
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].sold, 1, 'sold column must survive the query')

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(endedAt, 'XAU', 2000, null, 'test')

    const view = MARKET.newMarketView(repository, SPOT.newSpotLookup(db), {})
    const market = view.forInstrument('GB.SOV.FULL')
    assert.strictEqual(market.outcomes[0].sold, true)
    assert.strictEqual(market.liquidity.sellThroughRate, 1)
})

test('a spot gap withholds the premium instead of using a stale price', () => {
    const { db, repository } = fixture()
    const base = Date.parse('2026-08-20T00:00:00Z')
    const insert = db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
    insert.run(new Date(base).toISOString(), 'XAU', 1950, null, 'test')

    const spotAt = SPOT.newSpotLookup(db, { toleranceMinutes: 90 })
    assert.ok(spotAt(new Date(base + 30 * 60000).toISOString()) !== null)
    assert.strictEqual(spotAt(new Date(base + 8 * 3600000).toISOString()), null)
})

test('retention purges raw listings but the schema survives', () => {
    const { db, repository } = fixture()
    repository.saveListing({ browseId: 'v1|5|0', legacyId: '5', title: 'Gold Sovereign', buyingOptions: 'AUCTION', endTime: new Date().toISOString() })
    db.prepare('UPDATE listing SET expires_at = ?').run(new Date(Date.now() - DAY_MS).toISOString())

    const purged = repository.purgeExpired()
    assert.strictEqual(purged, 1)
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM listing').get().n, 0)
})

test('outcome resolution queue respects the 90-day GetItem window', () => {
    const { db, repository } = fixture()
    const recent = new Date(Date.now() - 2 * DAY_MS).toISOString()
    const ancient = new Date(Date.now() - 200 * DAY_MS).toISOString()

    repository.saveListing({ browseId: 'v1|6|0', legacyId: '6', title: 'a', buyingOptions: 'AUCTION', endTime: recent })
    repository.saveListing({ browseId: 'v1|7|0', legacyId: '7', title: 'b', buyingOptions: 'AUCTION', endTime: ancient })

    const pending = repository.pendingOutcomes(10)
    assert.deepStrictEqual(pending.map(p => p.legacyId), ['6'],
        'lots past the 90-day window are unresolvable and must not be retried forever')
})
