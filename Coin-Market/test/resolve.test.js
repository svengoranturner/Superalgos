'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const RESOLVE = require('../src/collect/resolve.js')
const TRADING = require('../src/ebay/trading.js')

/*
    Outcome resolution.

    Two things had never been exercised here. The fixed-price branch of
    parseItem had never executed at all, because pendingOutcomes could not
    offer a listing without an end time; and nothing checked what happens
    when eBay answers that a lot we assumed was over is in fact still on
    sale. The second is the whole safety of the first.
*/

const HOUR_MS = 60 * 60 * 1000

function store () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'salt' })
    const now = Date.now()

    /*  Something the most recent sweep saw, which is what sets the sweep
        clock that absence is measured against. */
    repository.saveListing({
        browseId: 'v1|fresh|0', legacyId: 'fresh', marketplace: 'EBAY_GB',
        title: 'Gold Sovereign 1912', buyingOptions: 'FIXED_PRICE', currency: 'GBP', endTime: null
    }, new Date(now).toISOString())

    /*  And a lot last seen four days before it: quiet enough to be offered
        up as probably ended. */
    const lastSeen = new Date(now - 96 * HOUR_MS).toISOString()
    repository.saveListing({
        browseId: 'v1|quiet|0', legacyId: 'quiet', marketplace: 'EBAY_GB',
        title: 'Gold Sovereign 1911', buyingOptions: 'FIXED_PRICE', currency: 'GBP', endTime: null
    }, lastSeen)
    repository.saveSnapshot('v1|quiet|0', { observedAt: lastSeen, price: 640, shipping: 0 })
    repository.saveClassification('v1|quiet|0', [{ key: 'GB.SOV.FULL', level: 1 }], 0.9, 'test', 0.2354, {})
    return { db, repository }
}

function clientReturning (item) {
    const asked = []
    return {
        asked,
        async getItem (legacyId) { asked.push(legacyId); return item }
    }
}

const outcomeOf = (db, browseId) =>
    db.prepare('SELECT * FROM listing_outcome WHERE browse_id = ?').get(browseId)

test('a lot eBay still calls Active is never recorded as an outcome', async () => {
    /*
        The quiet Buy-It-Now trigger is a guess: a lot can drop out of search
        results for three days and come back. Recording an outcome for one
        would be a fabrication in two directions at once - it would enter the
        clearing statistics as an unsold lot and disappear from the live
        market on the same write. Because of this check, being wrong costs
        one Trading call and nothing else, which is what makes the threshold
        safe to tune.
    */
    const { db, repository } = store()
    const client = clientReturning({
        listingStatus: 'Active', sold: false, finalPrice: 640,
        saleType: 'FIXED_PRICE', censored: false, endTime: null, aspects: {}
    })
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.deepStrictEqual(client.asked, ['quiet'], 'the quiet lot was never asked about')
    assert.strictEqual(report.stillLive, 1)
    assert.strictEqual(report.resolved, 0)
    assert.strictEqual(outcomeOf(db, 'v1|quiet|0'), undefined, 'a live listing was recorded as ended')
    db.close()
})

test('a lot still live is offered again next time, not lost', async () => {
    const { db, repository } = store()
    const client = clientReturning({
        listingStatus: 'Active', sold: false, saleType: 'FIXED_PRICE', aspects: {}
    })
    await RESOLVE.newResolver(client, repository).resolvePending(10)
    assert.deepStrictEqual(repository.pendingOutcomes(10).map(r => r.legacyId), ['quiet'])
    db.close()
})

test('an ended Buy-It-Now sale is finally recorded', async () => {
    /*  This branch of parseItem was complete, correct, and had never once
        run in production: every clearing price the tool knew came from an
        auction, on roughly half the market. */
    const { db, repository } = store()
    const endedAt = new Date(Date.now() - 12 * HOUR_MS).toISOString()
    const client = clientReturning({
        listingStatus: 'Completed', sold: true, finalPrice: 655.5, bidCount: null,
        saleType: 'FIXED_PRICE', censored: false, endTime: endedAt, aspects: {}
    })
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(report.resolved, 1)
    assert.strictEqual(report.stillLive, 0)
    const row = outcomeOf(db, 'v1|quiet|0')
    assert.strictEqual(row.sold, 1)
    assert.strictEqual(row.final_price, 655.5)
    assert.strictEqual(row.sale_type, 'FIXED_PRICE')
    assert.strictEqual(row.ended_at, endedAt,
        'eBay knows when it ended; we only know when we last looked')
    db.close()
})

test('a Best Offer sale is recorded but marked as not the price paid', async () => {
    /*  eBay does not publish what a Best Offer accepted for; the listing
        simply ends showing its list price. Taking that as the sale price is
        the easiest way to build a tool that lies to you confidently. */
    const { db, repository } = store()
    const client = clientReturning({
        listingStatus: 'Completed', sold: true, finalPrice: 700, saleType: 'BEST_OFFER',
        censored: true, endTime: new Date().toISOString(), aspects: {}
    })
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(report.censored, 1)
    assert.strictEqual(outcomeOf(db, 'v1|quiet|0').censored, 1)
    db.close()
})

test('an exhausted Trading budget stops the queue rather than burning it', async () => {
    /*  The queue is ordered by deadline, so what is left is exactly what
        should be tried first next cycle. Walking the rest of it to collect
        the same refusal sixty times only buries the reason in the journal. */
    const { db, repository } = store()
    let asked = 0
    const client = {
        async getItem () {
            asked++
            const err = new Error('Trading daily call budget exhausted')
            err.code = 'BUDGET_EXHAUSTED'
            throw err
        }
    }
    for (const id of ['a', 'b', 'c']) {
        repository.saveListing({
            browseId: 'v1|' + id + '|0', legacyId: id, marketplace: 'EBAY_GB',
            title: 'Gold Sovereign', buyingOptions: 'AUCTION', currency: 'GBP',
            endTime: new Date(Date.now() - 3 * HOUR_MS).toISOString()
        })
    }
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(asked, 1, 'it kept asking after being told the budget was gone')
    assert.strictEqual(report.budgetStopped, true)
    assert.strictEqual(report.failed, 0, 'a budget stop was reported as a failure')
    db.close()
})

/*
    The gate has to stand in front of the request.

    It used to sit below the fetch, so an exhausted budget refused to parse a
    response that had already been paid for - the request was on the wire
    before anything consulted the ledger, and a looping caller could still
    spend the whole day's allowance one refused call at a time.
*/
test('an exhausted budget is refused before the request is made', async () => {
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (...args) => {
        calls.push(args)
        throw new Error('should never be reached')
    }
    try {
        const client = TRADING.newTradingClient(
            { endpoints: { trading: 'https://api.ebay.test/ws' }, userToken: async () => 't' },
            {},
            {
                budget: {
                    allowsTrading: () => false,
                    record () { assert.fail('recorded a call it had refused') }
                }
            })

        await assert.rejects(client.getItem('123'), err => err.code === 'BUDGET_EXHAUSTED')
        assert.strictEqual(calls.length, 0, 'the refused call still went out over the network')
    } finally {
        globalThis.fetch = realFetch
    }
})
