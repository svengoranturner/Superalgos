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
        const sov = add(n, 'GB.SOV.BULLION.FULL', 0.2354, 900 + n, n % 2 === 0)
        const dollar = add(n, 'US.MORGAN.COMMON.DOLLAR', 0.7734, 70 + n, n % 2 === 0)
        /*  A queue with both coins in it, because an empty one hides every
            bug about telling them apart. */
        if (n < 3) {
            repository.setListingSeries(sov, 'GB.SOV')
            repository.queueForReview(sov, 'worth a look', 'GB.SOV.BULLION.FULL', 0.5)
            repository.setListingSeries(dollar, 'US.MORGAN')
            repository.queueForReview(dollar, 'worth a look', 'US.MORGAN.COMMON.DOLLAR', 0.5)
        }
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

/*
    The owner spotted this within an hour of the second series going live:
    silver dollars valued against gold, and against a sovereign's weight.

    Both halves were true. The plausibility cell took a single spot price -
    gold - and measured every row against it, and when it could not read a
    denomination it fell back to a QUARTER SOVEREIGN. A Morgan holds 0.7734
    oz of silver: against silver it is worth about GBP 38, against gold
    about GBP 2,545, so a lot at GBP 70 read as 3% of spot and got badged
    "below spot - not this coin".

    Two series sharing one metal is not a rounding error, and it arrives
    disguised as either a bargain or a fake.
*/
test('a silver coin is measured against silver, on the page as well as in the store', async () => {
    const opened = twoSeriesStore()
    const { '/review': review, '/listings?key=US.MORGAN.COMMON.DOLLAR': drill } =
        await fetchAll(opened, ['/review', '/listings?key=US.MORGAN.COMMON.DOLLAR'])

    /*  The fixture prices its Morgans at GBP 70-75 against silver at
        GBP 49.70/oz and 0.7734 oz, so a premium of roughly +80% to +95%.
        Measured against GOLD the same rows would read about −97%, which is
        the number this test exists to keep off the page.

        Read as a signed premium, because that is what the badge now shows:
        every other figure in the tool is a premium, so "130% of spot" was
        the one a reader had to convert before comparing it with anything. */
    const premiums = [...drill.body.matchAll(/([+−-])(\d+)%/g)]
        .map(m => (m[1] === '+' ? 1 : -1) * Number(m[2]))
    assert.ok(premiums.length > 0, 'no plausibility figures rendered at all')
    for (const p of premiums) {
        assert.ok(p > 0 && p < 300,
            'a Morgan read ' + p + '% premium - that is another metal, not this coin')
    }

    /*  And nothing on either page should be calling them impossible. */
    for (const [name, page] of [['review', review], ['drill-down', drill]]) {
        const impossible = (page.body.match(/below spot - not this coin/g) || []).length
        assert.strictEqual(impossible, 0, name + ' badged a correctly priced coin impossible')
    }
    opened.db.close()
})

/*
    MKT-14. A partition that asks for the newest auctions and stops.

    Measured over 1,637 auctions, the median gap between a seller listing
    one and this tool first seeing it was 87.8 hours - more than half of a
    7-day auction - because a fresh listing sits deep in a relevance-sorted
    result set and only surfaces as it nears its end. A tool that never sees
    an auction near its start cannot know what it opened at.

    The cost has to stay at one call: banding it would multiply that by six,
    and paging deeper would re-fetch what the other partitions already sweep.
*/
test('the newest-listings partition costs one call and skips the bands', () => {
    const DISCOVER = require('../src/collect/discover.js')
    const discoverer = DISCOVER.newDiscoverer({}, {}, { allowedCountries: () => ['GB'] })

    const queries = discoverer.buildQueries({
        currency: 'GBP',
        priceBands: [[10, 50], [50, 90], [90, 150]],
        partitions: [
            { name: 'banded', q: 'gold sovereign', buyingOptions: ['AUCTION'] },
            {
                name: 'newest', q: 'gold sovereign', buyingOptions: ['AUCTION'],
                sort: 'newlyListed', bands: false, maxPages: 1
            }
        ]
    })

    const newest = queries.filter(q => q.name.startsWith('newest'))
    assert.strictEqual(newest.length, 1, 'the newest partition must not be multiplied by bands')
    assert.strictEqual(newest[0].maxPages, 1, 'it must not page past the newest listings')
    assert.strictEqual(newest[0].query.sort, 'newlyListed')
    assert.ok(!/price:/.test(newest[0].query.filter), 'no price band on an unbanded partition')

    /*  And the banded partitions are untouched by any of that. */
    assert.strictEqual(queries.filter(q => q.name.startsWith('banded')).length, 3)
    assert.strictEqual(queries.find(q => q.name.startsWith('banded')).maxPages, undefined)
})

/*  Both series ship the partition, because the question - what should I
    open an auction at? - is asked of whatever you are selling. */
test('every collected series looks for its own new listings', () => {
    for (const name of ['sovereign', 'morgan']) {
        const coins = require('../config/coins.' + name + '.json')
        const newest = coins.partitions.filter(p => p.sort === 'newlyListed')
        assert.strictEqual(newest.length, 1, name + ' has no newly-listed partition')
        assert.deepStrictEqual(newest[0].buyingOptions, ['AUCTION'],
            'a starting price is an auction idea')
        assert.strictEqual(newest[0].bands, false)
        assert.strictEqual(newest[0].maxPages, 1)
    }
})

/*
    The owner's report: on the Morgan tab, clicking "auctions only" served
    sovereign auctions.

    saleTabs was given no parameters, so every link it built dropped the
    coin and fell back to the default series. It reads as the tab not
    working; it is a lost parameter. The same omission sent you to a
    different queue after every verdict, because the return link carried
    only one of the two filters as well.

    So the property is: each filter's links carry the other, in both
    directions, and so does the way back.
*/
test('choosing a sale type keeps the coin, and choosing a coin keeps the sale type', async () => {
    const opened = twoSeriesStore()
    const { '/review?coin=US.MORGAN': morgan } = await fetchAll(opened, ['/review?coin=US.MORGAN'])

    /*  Every link that CHANGES the sale type must stay on Morgans. */
    const saleLinks = [...morgan.body.matchAll(/href="(\/review\?[^"]*sale=[^"]*)"/g)].map(m => m[1])
    assert.ok(saleLinks.length > 0, 'no sale-type links rendered')
    for (const href of saleLinks) {
        assert.match(href, /coin=US\.MORGAN/, 'a sale-type link dropped the coin: ' + href)
    }

    /*  And from a filtered view, switching COIN must keep the sale type.
        Checked on the link to the other series specifically: the "Everything"
        sale link also contains coin=, and it drops sale= on purpose, which
        is what that tab is for. */
    const { '/review?coin=US.MORGAN&sale=auction': auctions } =
        await fetchAll(opened, ['/review?coin=US.MORGAN&sale=auction'])
    const otherCoin = [...auctions.body.matchAll(/href="(\/review\?[^"]*coin=GB\.SOV[^"]*)"/g)]
        .map(m => m[1])
    assert.ok(otherCoin.length > 0, 'no link to the other series')
    for (const href of otherCoin) {
        assert.match(href, /sale=auction/, 'switching coin dropped the sale type: ' + href)
    }

    /*  The Everything tab is the one link allowed to drop it. */
    assert.ok(auctions.body.includes('href="/review?coin=US.MORGAN"'),
        'no way back to every sale type without losing the coin')

    /*  The way back after a verdict, too. */
    assert.match(auctions.body, /name="back" value="\/review\?coin=US\.MORGAN&amp;sale=auction"/,
        'the return path lost a filter')
    opened.db.close()
})
