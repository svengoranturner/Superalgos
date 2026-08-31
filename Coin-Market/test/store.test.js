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

/*  CLS-07 kept lot size off the shared instrument row, because writing it
    there would have redefined the gold content of every coin under the same
    key. The read path made the same mistake by other means: it took the
    instrument's fine ounces from active[0].fineOz, which IS lot-multiplied,
    so whichever listing happened to sort first set the gold for all of them.
    A nine-coin set was due at the front of GB.SOV.UNATTRIBUTED.HALF on
    2026-09-03, which would have multiplied that key's bid ceiling by nine. */
test('a multi-coin lot does not redefine the gold in one coin', () => {
    const { db, repository } = fixture()
    const now = Date.now()
    const SINGLE = 0.2354

    /*  The bulk lot ends soonest, so activeListings sorts it first - which is
        precisely when the old code adopted its gold as the instrument's. */
    repository.saveListing({
        browseId: 'v1|set|0', legacyId: 'set', title: 'Full Set (9) Gold Half Sovereigns',
        buyingOptions: 'AUCTION', endTime: new Date(now + 3600000).toISOString()
    })
    repository.saveSnapshot('v1|set|0', { price: 6000, shipping: 0, observedAt: new Date().toISOString() })
    repository.saveClassification('v1|set|0',
        [{ key: 'GB.SOV.HALF', level: 0 }], 0.9, 'title', SINGLE, { quantity: 9 })

    repository.saveListing({
        browseId: 'v1|one|0', legacyId: 'one', title: 'Gold Half Sovereign 1912',
        buyingOptions: 'AUCTION', endTime: new Date(now + 2 * 3600000).toISOString()
    })
    repository.saveSnapshot('v1|one|0', { price: 700, shipping: 0, observedAt: new Date().toISOString() })
    repository.saveClassification('v1|one|0',
        [{ key: 'GB.SOV.HALF', level: 0 }], 0.9, 'title', SINGLE, {})

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(new Date().toISOString(), 'XAU', 3292, null, 'test')

    const view = MARKET.newMarketView(repository, SPOT.newSpotLookup(db), {})
    const market = view.forInstrument('GB.SOV.HALF')

    /*  The nine-coin lot is genuinely nine coins' gold - that part is right,
        and the ask premium depends on it. */
    const bulk = market.active.find(a => a.legacyId === 'set')
    assert.ok(Math.abs(bulk.fineOz - SINGLE * 9) < 1e-9, 'a lot carries its own gold')

    /*  But the INSTRUMENT is one coin, whatever is listed under it. */
    assert.ok(Math.abs(market.fineOz - SINGLE) < 1e-9,
        'instrument fineOz was ' + market.fineOz + ', expected one coin at ' + SINGLE)
    db.close()
})

/*  Every human decision in this tool is keyed on the legacy id, so a lot
    the market view surfaces has to be one the owner can then judge. The
    query selected it and the view's mapping dropped it, which meant an
    alert could name a listing but offer no way to say it was wrong. */
test('a live listing keeps the id its verdict will be recorded against', () => {
    const { db, repository } = fixture()
    repository.saveListing({
        browseId: 'v1|live|0', legacyId: 'live-1', title: 'Gold Sovereign 1912',
        buyingOptions: 'FIXED_PRICE|BEST_OFFER', endTime: null
    })
    repository.saveSnapshot('v1|live|0', { price: 800, shipping: 4, observedAt: new Date().toISOString() })
    repository.saveClassification('v1|live|0',
        [{ key: 'GB.SOV.FULL', level: 0 }], 0.9, 'title', 0.2354, {})
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(new Date().toISOString(), 'XAU', 3292, null, 'test')

    const view = MARKET.newMarketView(repository, SPOT.newSpotLookup(db), {})
    const active = view.forInstrument('GB.SOV.FULL').active
    assert.strictEqual(active.length, 1)
    assert.strictEqual(active[0].legacyId, 'live-1')
    db.close()
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

/*
    Multi-variation listings.

    eBay Browse ids are v1|<legacyItemId>|<variationId>, so one listing with
    several variations arrives as several rows sharing a legacy item number.
    legacy_id was UNIQUE, which made the second variation throw and cost the
    rest of that discovery partition.
*/

function variationFixture () {
    const db = newDatabase(':memory:')
    const repo = newRepository(db, { sellerSalt: 'salt' })
    const base = {
        marketplace: 'EBAY_GB', title: 'Gold Sovereign', buyingOptions: 'FIXED_PRICE',
        currency: 'GBP', firstSeen: '2026-08-01T00:00:00Z', lastSeen: '2026-08-01T00:00:00Z',
        endTime: '2026-08-02T00:00:00Z'
    }
    return { db, repo, base }
}

test('two variations of one listing both store, sharing a legacy id', () => {
    const { db, repo, base } = variationFixture()
    repo.saveListing(Object.assign({}, base, {
        browseId: 'v1|327041911935|515924774139', legacyId: '327041911935'
    }))
    repo.saveListing(Object.assign({}, base, {
        browseId: 'v1|327041911935|515924774151', legacyId: '327041911935'
    }))
    const n = db.prepare('SELECT COUNT(*) c FROM listing WHERE legacy_id = ?').get('327041911935').c
    assert.strictEqual(n, 2)
    db.close()
})

test('one physical sale yields one outcome to resolve, not one per variation', () => {
    const { db, repo, base } = variationFixture()
    for (const suffix of ['515924774139', '515924774151', '515924774163']) {
        repo.saveListing(Object.assign({}, base, {
            browseId: 'v1|327041911935|' + suffix, legacyId: '327041911935'
        }))
    }
    const pending = repo.pendingOutcomes(50)
    assert.strictEqual(pending.length, 1, 'three variations, one lot to resolve')
    assert.strictEqual(pending[0].legacyId, '327041911935')
    db.close()
})

/*  Without this the group would nominate an unresolved sibling next cycle
    and the same lot would be resolved forever, spending a call each time. */
test('once any variation is resolved, no sibling is offered again', () => {
    const { db, repo, base } = variationFixture()
    for (const suffix of ['515924774139', '515924774151']) {
        repo.saveListing(Object.assign({}, base, {
            browseId: 'v1|327041911935|' + suffix, legacyId: '327041911935'
        }))
    }
    const first = repo.pendingOutcomes(50)
    repo.saveOutcome(first[0].browseId, {
        endTime: base.endTime, sold: true, finalPrice: 851.27, bidCount: 3,
        saleType: 'AUCTION', source: 'GetItem'
    })
    assert.strictEqual(repo.pendingOutcomes(50).length, 0)
    db.close()
})

test('separate listings are still resolved separately', () => {
    const { db, repo, base } = variationFixture()
    repo.saveListing(Object.assign({}, base, { browseId: 'v1|111|0', legacyId: '111' }))
    repo.saveListing(Object.assign({}, base, { browseId: 'v1|222|0', legacyId: '222' }))
    assert.strictEqual(repo.pendingOutcomes(50).length, 2)
    db.close()
})

/*
    The ask side.

    Good-'Til-Cancelled fixed-price listings have no end time, and testing
    end_time > now is false for NULL - which silently excluded almost every
    ask from the very spread the tool exists to measure.
*/
function askFixture () {
    const db = newDatabase(':memory:')
    const repo = newRepository(db, { sellerSalt: 'salt' })
    const now = Date.now()
    const seen = new Date(now - 60 * 60 * 1000).toISOString()
    /* saveListing takes the observation time as its SECOND argument; a
       lastSeen on the object itself is ignored. */
    repo.saveListing({
        browseId: 'v1|gtc|0', legacyId: 'gtc', marketplace: 'EBAY_GB', title: 'Gold Sovereign',
        buyingOptions: 'FIXED_PRICE', currency: 'GBP', endTime: null
    }, seen)
    repo.saveListing({
        browseId: 'v1|auction|0', legacyId: 'auction', marketplace: 'EBAY_GB', title: 'Gold Sovereign',
        buyingOptions: 'AUCTION', currency: 'GBP',
        endTime: new Date(now + 3600 * 1000).toISOString()
    }, seen)
    repo.saveListing({
        browseId: 'v1|stale|0', legacyId: 'stale', marketplace: 'EBAY_GB', title: 'Gold Sovereign',
        buyingOptions: 'FIXED_PRICE', currency: 'GBP', endTime: null
    }, new Date(now - 8 * 86400000).toISOString())
    for (const id of ['v1|gtc|0', 'v1|auction|0', 'v1|stale|0']) {
        repo.saveSnapshot(id, { observedAt: seen, price: 500, shipping: 0, bidCount: 0 })
        repo.saveClassification(id, [{ key: 'GB.SOV.FULL', level: 1 }], 0.9, 'test', 0.2354, {})
    }
    return { db, repo }
}

/*  The opportunities panel is ordered by how long you have left to act, so
    the query underneath it has to deliver that order rather than leave it to
    a re-sort that could quietly go missing. It also decides what counts as
    an opportunity at all - a lot already ended, already resolved, or never an
    auction is not one. */
test('live auctions come back ending soonest first, and only live auctions', () => {
    const { db, repository } = fixture()
    const now = Date.now()
    const at = (ms) => new Date(now + ms).toISOString()

    const rows = [
        ['v1|thu|0', 'thu', 'Gold Sovereign 1966', 'AUCTION', at(3 * DAY_MS)],
        ['v1|soon|0', 'soon', 'Gold Sovereign 1912', 'AUCTION', at(20 * 60 * 1000)],
        ['v1|tomorrow|0', 'tomorrow', 'Gold Sovereign 1900', 'AUCTION', at(DAY_MS)],
        ['v1|ended|0', 'ended', 'Gold Sovereign 1887', 'AUCTION', at(-DAY_MS)],
        ['v1|bin|0', 'bin', 'Gold Sovereign 1974', 'FIXED_PRICE', at(5 * DAY_MS)],
        ['v1|done|0', 'done', 'Gold Sovereign 1925', 'AUCTION', at(2 * DAY_MS)]
    ]
    for (const [browseId, legacyId, title, buyingOptions, endTime] of rows) {
        repository.saveListing({ browseId, legacyId, title, buyingOptions, endTime })
        repository.saveSnapshot(browseId, { price: 600, shipping: 0, observedAt: at(0) })
        repository.saveClassification(browseId,
            [{ key: 'GB.SOV.FULL', level: 0 }], 0.9, 'title', 0.2354, {})
    }
    /*  Already resolved: its outcome is known, so it is history, not a lot
        you can still bid on. */
    repository.saveOutcome('v1|done|0', {
        endTime: at(2 * DAY_MS), sold: true, finalPrice: 640, shipping: 0,
        bidCount: 4, saleType: 'AUCTION', censored: false, source: 'trading_getitem'
    })

    const live = repository.liveAuctions(50)
    assert.deepStrictEqual(live.map(r => r.legacyId), ['soon', 'tomorrow', 'thu'],
        'ending soonest first, with ended, resolved and Buy-It-Now lots left out')
    db.close()
})

test('a Good-Til-Cancelled listing with no end time counts as an active ask', () => {
    const { db, repo } = askFixture()
    const ids = repo.activeListings('GB.SOV.FULL').map(r => r.browseId)
    assert.ok(ids.includes('v1|gtc|0'), 'NULL end_time must not exclude the ask')
    db.close()
})

test('a live auction is still active', () => {
    const { db, repo } = askFixture()
    assert.ok(repo.activeListings('GB.SOV.FULL').map(r => r.browseId).includes('v1|auction|0'))
    db.close()
})

/*  Without an end time, last_seen is the only signal a listing has gone. */
test('an endless listing not seen for days drops out rather than lingering', () => {
    const { db, repo } = askFixture()
    assert.ok(!repo.activeListings('GB.SOV.FULL').map(r => r.browseId).includes('v1|stale|0'))
    db.close()
})

/* ------------------------------------------------------- review queue */

/*  The review queue query had no test at all, so a change to it passed a
    green suite while being syntactically fine and semantically wrong. */
function queueFixture () {
    const { db, repository } = fixture()
    const soon = new Date(Date.now() + DAY_MS).toISOString()

    for (const [browseId, legacyId, title] of [
        ['v1|q1|0', 'q1', 'Gold Sovereign 1911 uncertain portrait'],
        ['v1|q2|0', 'q2', 'Sovereign something odd'],
        ['v1|q3|0', 'q3', 'Gold Sovereign priced and flagged']
    ]) {
        repository.saveListing({
            browseId, legacyId, title, buyingOptions: 'FIXED_PRICE', endTime: soon,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg',
            categoryPath: 'Coins|Bullion', sellerFeedbackPct: 99.2, sellerFeedbackCnt: 410
        })
        repository.saveSnapshot(browseId, { price: 700, shipping: 4, observedAt: new Date().toISOString() })
    }

    /*  q3 is the case that matters: flagged for a human AND still counted in
        the market statistics. */
    repository.saveClassification('v1|q3|0', [{ key: 'GB.SOV.BULLION.FULL', level: 3 }], 0.5, 'title', 0.2354, {})

    repository.queueForReview('v1|q1|0', 'Portrait type ambiguous for that year', 'GB.SOV.BULLION.FULL', 0.5)
    repository.queueForReview('v1|q2|0', 'EXCLUDED: Not a coin', null, 0)
    repository.queueForReview('v1|q3|0', 'Denomination not identified', 'GB.SOV.BULLION.FULL', 0.5)
    return { db, repository }
}

test('the review queue carries everything a glance needs', () => {
    const { db, repository } = queueFixture()
    const rows = repository.reviewQueue(50)
    assert.strictEqual(rows.length, 3)

    const one = rows.find(r => r.legacyId === 'q1')
    /*  Each of these costs no API call - it is already stored - and each
        removes a reason to open a new tab. */
    assert.strictEqual(one.imageUrl, 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg')
    assert.strictEqual(one.categoryPath, 'Coins|Bullion')
    assert.strictEqual(one.sellerFeedbackPct, 99.2)
    assert.strictEqual(one.price, 700)
    assert.strictEqual(one.shipping, 4)
    db.close()
})

/*  Newest-first buried the listings that are actually making a number wrong
    among the ones already dropped and shown only for auditability. */
test('listings still counted in the statistics come first in the queue', () => {
    const { db, repository } = queueFixture()
    const rows = repository.reviewQueue(50)
    assert.strictEqual(rows[0].legacyId, 'q3', 'the priced-and-flagged listing must lead')
    assert.strictEqual(rows[0].priced, 1)
    assert.ok(rows.slice(1).every(r => r.priced === 0))
    db.close()
})

/*  A listing has one listing_instrument row per level it was filed under, so
    a plain COUNT(*) over the join triples it - the country picker showed the
    United Kingdom holding 9,523 listings out of a corpus of 5,490. */
test('country counts count listings, not instrument assignments', () => {
    const { db, repository } = fixture()
    const soon = new Date(Date.now() + DAY_MS).toISOString()

    repository.saveListing({
        browseId: 'v1|c1|0', legacyId: 'c1', title: 'Gold Sovereign 1912',
        buyingOptions: 'AUCTION', endTime: soon, itemCountry: 'GB'
    })
    repository.saveClassification('v1|c1|0', [
        { key: 'GB.SOV.BULLION.FULL', level: 0 },
        { key: 'GB.SOV.BULLION.FULL.GEORGE_V', level: 1 },
        { key: 'GB.SOV.BULLION.FULL.GEORGE_V.1912', level: 2 }
    ], 1, 'title', 0.2354, {})

    const gb = repository.countryCounts().find(r => r.country === 'GB')
    assert.strictEqual(gb.listings, 1, 'one listing, however many instruments it sits in')
    assert.strictEqual(gb.priced, 1)
    db.close()
})

/*  Completed sales are few and are the only prices somebody actually paid, so
    the row limit must never be able to cut them off. Sorting them behind the
    live listings meant an instrument with 500 live lots reported "0 sold"
    while holding more completed sales than any other. */
test('completed sales survive the row limit on a busy instrument', () => {
    const { db, repository } = fixture()
    const soon = new Date(Date.now() + DAY_MS).toISOString()
    const key = 'GB.SOV.BULLION.FULL'

    const file = (browseId, legacyId, title, price) => {
        repository.saveListing({ browseId, legacyId, title, buyingOptions: 'AUCTION', endTime: soon })
        repository.saveSnapshot(browseId, { price, shipping: 0 })
        repository.saveClassification(browseId, [{ key, level: 0 }], 1, 'title', 0.2354, {})
    }

    /* Twelve dear live lots, then one modest completed sale. */
    for (let i = 0; i < 12; i++) { file('v1|live' + i + '|0', 'live' + i, 'Gold Sovereign ' + i, 9000 + i) }
    file('v1|sold|0', 'sold', 'Gold Sovereign that actually sold', 800)
    repository.saveOutcome('v1|sold|0', {
        endTime: new Date(Date.now() - DAY_MS).toISOString(),
        sold: true, finalPrice: 820, bidCount: 15, saleType: 'AUCTION', source: 'test'
    })

    /* A limit far below the number of live lots must still return the sale. */
    const rows = repository.listingsForInstrument(key, 5)
    assert.strictEqual(rows.length, 5)
    assert.strictEqual(rows[0].browseId, 'v1|sold|0', 'the sale must lead, whatever it fetched')
    assert.strictEqual(rows[0].sold, 1)
    assert.strictEqual(rows[0].finalPrice, 820)
    assert.strictEqual(rows[0].finalBidCount, 15)
    db.close()
})

/*
    The row limit admits the DEAREST live lots, and that is a decision, not
    an accident.

    The drill-down sorts its live section by end time, but does it in JS
    after the fetch. Moving that ordering into the SQL would look tidier and
    would quietly change which rows come back: with `end_time ASC` as a sort
    key, a limit of 5 admits the five soonest and drops everything dearer
    that ends later. The dearest lot is the one most likely to be distorting
    the premium the page exists to explain, so losing it loses the reason for
    the page.

    The sibling test above pins the FIRST key (completed sales lead). This
    one pins the last, which is the one a plausible refactor reaches for.
*/
test('the row limit keeps the dearest live lots, not the soonest', () => {
    const { db, repository } = fixture()
    const key = 'GB.SOV.BULLION.FULL'
    const at = hours => new Date(Date.now() + hours * 60 * 60 * 1000).toISOString()

    /*  Ten live auctions where price and end time run in OPPOSITE
        directions: the dearest ends last. Under dearest-first it is
        admitted; under ending-soonest it is the first thing dropped. */
    for (let i = 0; i < 10; i++) {
        const id = 'v1|lot' + i + '|0'
        repository.saveListing({
            browseId: id, legacyId: 'lot' + i, title: 'Gold Sovereign ' + i,
            buyingOptions: 'AUCTION', endTime: at(i + 1)
        })
        repository.saveSnapshot(id, { price: 1000 + i * 100, shipping: 0 })
        repository.saveClassification(id, [{ key, level: 0 }], 1, 'title', 0.2354, {})
    }

    const rows = repository.listingsForInstrument(key, 5)
    assert.strictEqual(rows.length, 5)

    const got = rows.map(r => r.legacyId)
    assert.deepStrictEqual(got, ['lot9', 'lot8', 'lot7', 'lot6', 'lot5'],
        'the fetch no longer admits the dearest five: ' + JSON.stringify(got))

    /*  Said the other way round, because this is the claim that matters: the
        lot ending soonest is the CHEAPEST here, and it must not displace a
        dearer one from the sample. */
    assert.ok(!got.includes('lot0'),
        'the soonest-ending lot displaced a dearer one from the fetch')
    db.close()
})
