'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const SPOT = require('../src/spot/spot.js')
const MARKET = require('../src/analytics/market.js')
const SERVER = require('../src/web/server.js')

/*
    Does every page actually render?

    Nothing tested this, and it showed. Two defects reached the owner's
    screen that a single request would have caught: an offers panel where
    every row was missing its checkbox and both verdict buttons, because the
    market view silently dropped the id they were keyed on; and a market page
    that returned 500 on every request, because a refactor renamed a variable
    and one template reference still read the old shape.

    Neither was subtle. Both were invisible to a suite that only ever tested
    the functions underneath the pages. So this starts the real server on an
    ephemeral port and asks it for each page, which is the cheapest possible
    version of looking.
*/

/*  A store with TWO series in it, because one is the case that hides the
    grouping bugs. Small and synthetic - the classification of real titles is
    covered by the golden fixture and the Morgan corpus; what is being tested
    here is that the page survives contact with them. */
function twoSeriesStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const soon = new Date(Date.now() + 3600000).toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 49.7, null, 'test')

    const add = (n, key, fineOz, price, auction) => {
        const id = 'v1|' + key.replace(/\W/g, '') + n + '|0'
        repository.saveListing({
            browseId: id, legacyId: key.replace(/\W/g, '') + n,
            title: key + ' example ' + n,
            buyingOptions: auction ? 'AUCTION' : 'FIXED_PRICE|BEST_OFFER',
            endTime: auction ? soon : null,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(id, { price, shipping: 4, observedAt: now })
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', fineOz, {})
        return id
    }

    for (let n = 0; n < 6; n++) {
        add(n, 'GB.SOV.BULLION.FULL', 0.2354, 900 + n, n % 2 === 0)
        add(n, 'US.MORGAN.COMMON.DOLLAR', 0.7734, 70 + n, n % 2 === 0)
    }
    /*  A few resolved sales, so fair value and the sold table have something
        to say rather than every number being a blank. */
    for (let n = 0; n < 4; n++) {
        const id = add(100 + n, 'GB.SOV.BULLION.FULL', 0.2354, 880, true)
        repository.saveOutcome(id, {
            endTime: now, sold: true, finalPrice: 880 + n, shipping: 4,
            bidCount: 7, saleType: 'AUCTION', censored: false, source: 'trading_getitem'
        })
    }

    const spotAt = SPOT.newSpotLookup(db, {})
    return {
        db,
        repository,
        spotAt,
        view: MARKET.newMarketView(repository, spotAt, {})
    }
}

async function fetchAll (opened, paths) {
    const server = SERVER.start(opened, { port: 0, host: '127.0.0.1', quiet: true })
    await new Promise(resolve => server.once('listening', resolve))
    const port = server.address().port
    const out = {}
    try {
        for (const path of paths) {
            const response = await fetch('http://127.0.0.1:' + port + path)
            out[path] = { status: response.status, body: await response.text() }
        }
    } finally {
        server.close()
    }
    return out
}

test('every page renders, with two series in the store', async () => {
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, [
        '/', '/review', '/rules', '/listings?key=GB.SOV.BULLION.FULL',
        '/listings?key=US.MORGAN.COMMON.DOLLAR'
    ])

    for (const [path, page] of Object.entries(pages)) {
        assert.strictEqual(page.status, 200, path + ' returned ' + page.status)
        /*  A 500 renders as a 200-shaped page in some handlers, so check the
            body too - this is exactly how the market page failure looked. */
        assert.ok(!/TypeError|ReferenceError|is not a function/.test(page.body),
            path + ' rendered an error: ' +
            (page.body.match(/(TypeError|ReferenceError)[^<]*/) || [''])[0])
    }
    opened.db.close()
})

/*  UI-12. The cap used to be global and ordered by listing count, so a new
    series got a share proportional to its size - which is backwards, since a
    new series is both the smallest and the one you most need to see. */
test('both series appear on the market page, neither crowded out', async () => {
    const opened = twoSeriesStore()
    const { '/': page } = await fetchAll(opened, ['/'])

    assert.ok(page.body.includes('British Gold Sovereigns'), 'sovereigns are missing')
    assert.ok(page.body.includes('Morgan') && page.body.includes('Dollars'),
        'the second series is missing from a page that tracks it')
    opened.db.close()
})

/*  The failure that reached the owner: twenty rows rendered perfectly and
    not one of them could be acted on, because the id every verdict is keyed
    on was selected by the query and then dropped by the mapping above it.
    Asserted on the OFFERS panel specifically - that is the one fed by
    activeListings, and the review queue's own rows come from elsewhere, so
    checking there would have passed while the bug was live. */
test('a lot you can see is a lot you can judge', async () => {
    const opened = twoSeriesStore()
    const { '/': market } = await fetchAll(opened, ['/'])

    const offers = market.body.split('id="offers"')[1]
    assert.ok(offers !== undefined, 'the offers panel is missing entirely')

    const section = offers.split('id="sold"')[0]
    const rows = (section.match(/class="q"/g) || []).length
    assert.ok(rows > 0, 'the fixture should produce offers, or this proves nothing')
    assert.ok(section.includes('name="pick"'),
        'rows with no checkbox: a decision you cannot make')
    assert.ok(section.includes('name="genuine"') && section.includes('name="reject"'),
        'rows with no verdict buttons')
    opened.db.close()
})

/*  The country filter has to hold on every path that fetches.

    It held on the hourly sweep and not on the five-minute poller, so the
    poller went on fetching lots the owner cannot buy - every five minutes,
    for every series. It surfaced when a Morgan sweep pulled 3,664 US
    listings into a UK-only store within the hour, but it had been leaking
    on the sovereign side all along.

    A filter that holds on one path and not the other is not a filter. */
test('the country filter holds on every path that asks eBay for listings', async () => {
    const DISCOVER = require('../src/collect/discover.js')
    const asked = []
    const browse = {
        async search (params) { asked.push(params); return { itemSummaries: [] } },
        async searchAll (params) { asked.push(params); return { items: [], truncated: false } }
    }
    const coins = {
        currency: 'GBP',
        partitions: [{ name: 'p', q: 'gold sovereign', buyingOptions: ['AUCTION'] }],
        priceBands: [[100, 300]]
    }

    /*  A function, because the dashboard writes this setting and the
        collector has to see the change on the next sweep, not the next
        restart. */
    const discoverer = DISCOVER.newDiscoverer(browse, {
        saveListing () {}, saveSnapshot () {}, queueForReview () {},
        setListingSeries () {}, saveClassification () {},
        labelIndex: () => new Map(), learnedRules: () => []
    }, { allowedCountries: () => ['GB'] })

    await discoverer.sweep(coins, 'GB.SOV')
    await discoverer.endingSoon(coins, 'GB.SOV')

    assert.ok(asked.length >= 2, 'both paths should have asked eBay something')
    for (const params of asked) {
        assert.match(String(params.filter), /itemLocationCountry/,
            'a request went out with no country restriction: ' + params.filter)
    }
})
