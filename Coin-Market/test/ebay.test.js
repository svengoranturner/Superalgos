'use strict'

const test = require('node:test')
const assert = require('node:assert')

const XML = require('../src/ebay/xml.js')
const TRADING = require('../src/ebay/trading.js')
const BROWSE = require('../src/ebay/browse.js')
const { newDatabase } = require('../src/store/db.js')
const BUDGET = require('../src/ebay/budget.js')

function itemResponse (inner) {
    return XML.parse('<GetItemResponse><Ack>Success</Ack><Item>' + inner + '</Item></GetItemResponse>').GetItemResponse
}

test('XML reader handles entities, nesting and repeated siblings', () => {
    const parsed = XML.parse(
        '<R><A>x &amp; y</A><L><I>1</I><I>2</I></L><E/><C><![CDATA[<raw>]]></C></R>')
    assert.strictEqual(XML.get(parsed, 'R.A'), 'x & y')
    assert.deepStrictEqual(XML.get(parsed, 'R.L.I'), ['1', '2'])
    assert.strictEqual(XML.get(parsed, 'R.C'), '<raw>')
})

test('a sold auction resolves to a real clearing price', () => {
    const item = TRADING.parseItem(itemResponse(
        '<ItemID>1</ItemID><ListingType>Chinese</ListingType>' +
        '<SellingStatus><ConvertedCurrentPrice>452.00</ConvertedCurrentPrice>' +
        '<BidCount>17</BidCount><QuantitySold>1</QuantitySold></SellingStatus>'))
    assert.strictEqual(item.sold, true)
    assert.strictEqual(item.finalPrice, 452)
    assert.strictEqual(item.saleType, 'AUCTION')
    assert.strictEqual(item.censored, false)
})

test('an accepted Best Offer is marked censored, not recorded as a sale at list price', () => {
    /*
        eBay shows the list price on a Best Offer listing that sold; what
        was actually paid is never published. Treating 560 as the sale
        price would bias every clearing estimate upward.
    */
    const item = TRADING.parseItem(itemResponse(
        '<ItemID>2</ItemID><ListingType>FixedPriceItem</ListingType>' +
        '<BestOfferDetails><BestOfferEnabled>true</BestOfferEnabled></BestOfferDetails>' +
        '<SellingStatus><ConvertedCurrentPrice>560.00</ConvertedCurrentPrice><QuantitySold>1</QuantitySold></SellingStatus>'))
    assert.strictEqual(item.censored, true)
    assert.strictEqual(item.saleType, 'BEST_OFFER')
})

test('an unsold auction with bids is not a sale', () => {
    const item = TRADING.parseItem(itemResponse(
        '<ItemID>3</ItemID><ListingType>Chinese</ListingType>' +
        '<SellingStatus><ConvertedCurrentPrice>300.00</ConvertedCurrentPrice>' +
        '<BidCount>4</BidCount><QuantitySold>0</QuantitySold></SellingStatus>'))
    assert.strictEqual(item.sold, false)
})

test('a Browse search without a buyingOptions filter is refused', () => {
    /*
        Browse returns FIXED_PRICE listings only unless told otherwise.
        Omitting the filter yields a Buy-It-Now-only dataset - exactly the
        bias this tool exists to measure - and nothing about the response
        reveals the omission.
    */
    const auth = { applicationToken: async () => 't', endpoints: { browse: 'https://example.invalid' } }
    const client = BROWSE.newBrowseClient(auth)
    return assert.rejects(
        () => client.searchAll({ q: 'gold sovereign', filter: 'price:[100..900]' }),
        /buyingOptions/)
})

test('Browse summaries keep the legacy id needed to resolve outcomes', () => {
    const summary = BROWSE.normaliseSummary({
        itemId: 'v1|123|0', legacyItemId: '123', title: 'Gold Sovereign',
        price: { value: '452.00', currency: 'GBP' }, buyingOptions: ['AUCTION'], bidCount: 3
    })
    assert.strictEqual(summary.legacyId, '123')
    assert.strictEqual(summary.price, 452)
})

test('filters serialise into eBay syntax', () => {
    assert.strictEqual(
        BROWSE.buildFilter({ buyingOptions: ['AUCTION', 'FIXED_PRICE'], price: '[100..900]' }),
        'buyingOptions:{AUCTION|FIXED_PRICE},price:[100..900]')
})

test('the budget protects discovery before snapshotting', () => {
    /*
        A missed snapshot costs precision on one lot; a missed discovery
        loses the lot, and with it the outcome that teaches the curve.
    */
    const db = newDatabase(':memory:')
    const budget = BUDGET.newBudget(db, { dailyLimit: 300, reserve: 250 })
    for (let i = 0; i < 60; i++) { budget.record('browse') }

    assert.strictEqual(budget.spent(), 60)
    assert.strictEqual(budget.allows('snapshot', 1), false, 'low-priority work stops at the reserve')
    assert.strictEqual(budget.allows('discover', 1), true, 'discovery may use the reserve')
})

test('trading calls are metered separately from the Browse quota', () => {
    const db = newDatabase(':memory:')
    const budget = BUDGET.newBudget(db, { dailyLimit: 5000 })
    budget.record('trading')
    budget.record('browse')
    assert.strictEqual(budget.spent(), 1, 'Trading has its own quota and must not consume the Browse budget')
})

test('the consent-code exchange surfaces the refresh token it exists to obtain', async () => {
    /*
        Regression: requestToken originally kept only the access token, so
        exchangeCode - whose entire purpose is to mint the ~18-month refresh
        token - returned an access token that expired in two hours.
    */
    const AUTH = require('../src/ebay/auth.js')
    const originalFetch = global.fetch
    global.fetch = async () => ({
        ok: true,
        json: async () => ({ access_token: 'A', refresh_token: 'R', expires_in: 7200 })
    })
    try {
        const auth = AUTH.newAuth({ clientId: 'i', clientSecret: 's', ruName: 'r' })
        const token = await auth.exchangeCode('code123')
        assert.strictEqual(token.refreshToken, 'R')
    } finally {
        global.fetch = originalFetch
    }
})

test('a consent exchange that yields no refresh token fails loudly', async () => {
    const AUTH = require('../src/ebay/auth.js')
    const originalFetch = global.fetch
    global.fetch = async () => ({ ok: true, json: async () => ({ access_token: 'A', expires_in: 7200 }) })
    try {
        const auth = AUTH.newAuth({ clientId: 'i', clientSecret: 's', ruName: 'r' })
        await assert.rejects(() => auth.exchangeCode('stale'), /refresh token/)
    } finally {
        global.fetch = originalFetch
    }
})

/*  The cheap half of the country filter: a Browse search is billed per call
    and returns 200 listings a call, so asking only for the countries you buy
    from is fewer calls, not just fewer rows. */
test('the search asks eBay only for the countries you buy from', () => {
    const DISCOVER = require('../src/collect/discover.js')
    const coins = {
        partitions: [{ name: 'p', q: 'gold sovereign', buyingOptions: ['AUCTION'] }],
        priceBands: [[100, 500]]
    }
    const filterFor = (allowedCountries) => DISCOVER
        .newDiscoverer({}, {}, { allowedCountries })
        .buildQueries(coins)[0].query.filter

    assert.match(filterFor(['GB']), /itemLocationCountry:\{GB\}/)
    assert.match(filterFor(['GB', 'AU']), /itemLocationCountry:\{GB\|AU\}/)
    /*  Empty means ask for everything. The other reading - ask for nothing -
        would quietly stop the collector dead. */
    assert.ok(!/itemLocationCountry/.test(filterFor([])))
    assert.ok(!/itemLocationCountry/.test(DISCOVER.newDiscoverer({}, {}, {})
        .buildQueries(coins)[0].query.filter))
})

/*  Trading is excluded from the Browse budget so the two never compete - but
    nothing was capping it either. Every Trading call site only record()ed, so
    a job resolving one listing per vanished Buy-It-Now could have spent the
    whole day's allowance unchecked. */
test('trading calls are capped, not merely counted', () => {
    const { newDatabase } = require('../src/store/db.js')
    const BUDGET = require('../src/ebay/budget.js')
    const db = newDatabase(':memory:')
    const budget = BUDGET.newBudget(db, { dailyLimit: 5000, tradingDailyLimit: 3 })

    assert.strictEqual(budget.allowsTrading(1), true)
    for (let i = 0; i < 3; i++) { budget.record('trading') }

    assert.strictEqual(budget.spentOn('trading'), 3)
    assert.strictEqual(budget.tradingRemaining(), 0)
    assert.strictEqual(budget.allowsTrading(1), false, 'the ceiling must actually stop it')

    /*  And it must not have touched the Browse allowance on the way. */
    assert.strictEqual(budget.spent(), 0)
    assert.strictEqual(budget.remaining(), 5000)
    db.close()
})

/*  eBay sends the listing's creation date on every summary and it was being
    discarded, which left start_time NULL on all 5,516 stored rows and
    silently disabled medianDaysToSale. */
test('the listing start date is kept', () => {
    const BROWSE = require('../src/ebay/browse.js')
    const row = BROWSE.normaliseSummary({
        itemId: 'v1|1|0', title: 'Gold Sovereign 1912',
        itemCreationDate: '2026-08-01T09:00:00.000Z',
        buyingOptions: ['FIXED_PRICE']
    })
    assert.strictEqual(row.startTime, '2026-08-01T09:00:00.000Z')
    assert.strictEqual(
        BROWSE.normaliseSummary({ itemId: 'v1|2|0', title: 'x', buyingOptions: [] }).startTime, null)
})
