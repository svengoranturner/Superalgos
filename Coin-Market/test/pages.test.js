'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const SPOT = require('../src/spot/spot.js')
const MARKET = require('../src/analytics/market.js')
const SERVER = require('../src/web/server.js')
const SERIES = require('../src/catalogue/series/index.js')
const LEARNED = require('../src/catalogue/learned.js')

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
            out[path] = {
                status: response.status,
                headers: response.headers,
                body: await response.text()
            }
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
/*  The two tab strips, told apart by what they offer rather than by their
    order on the page. Scoping each assertion to ONE strip is the whole point:
    a coin tab is SUPPOSED to change the coin, so a rule of the form "every
    /review link carrying sale= keeps coin=" quietly tests the wrong thing the
    moment coin tabs start carrying the sale - which is exactly what an
    auction default makes them do. */
function tabStrips (body) {
    const strips = [...body.matchAll(/<div class="tabs">([\s\S]*?)<\/div>/g)].map(m => m[1])
    const hrefs = strip => [...strip.matchAll(/href="([^"]*)"/g)].map(m => m[1])
    const sale = strips.find(x => /Auctions/.test(x) && /Buy-It-Now/.test(x))
    const coin = strips.find(x => x !== sale && /Morgan|Sovereign|Not attributed/.test(x))
    return { sale: hrefs(sale || ''), coin: hrefs(coin || ''), saleStrip: sale, coinStrip: coin }
}

test('choosing a sale type keeps the coin, and choosing a coin keeps the sale type', async () => {
    const opened = twoSeriesStore()
    const { '/review?coin=US.MORGAN': morgan } = await fetchAll(opened, ['/review?coin=US.MORGAN'])
    const bare = tabStrips(morgan.body)

    /*  Every link that CHANGES the sale type must stay on Morgans. */
    assert.ok(bare.sale.length > 0, 'no sale-type links rendered')
    for (const href of bare.sale) {
        assert.match(href, /coin=US\.MORGAN/, 'a sale-type link dropped the coin: ' + href)
    }

    /*  A bare ?coin= URL is the AUCTION view now, so the auction tab is the
        current one and renders as a span rather than a link. If it is still
        offered as a link here, the default did not move. */
    assert.ok(!bare.sale.some(h => /sale=auction/.test(h)),
        'the auction tab is offered as a link, so it is not the current view')

    /*  And from a filtered view, switching COIN must keep the sale type. */
    const { '/review?coin=US.MORGAN&sale=auction': auctions } =
        await fetchAll(opened, ['/review?coin=US.MORGAN&sale=auction'])
    const filtered = tabStrips(auctions.body)
    const otherCoin = filtered.coin.filter(h => /coin=GB\.SOV/.test(h))
    assert.ok(otherCoin.length > 0, 'no link to the other series')
    for (const href of otherCoin) {
        assert.match(href, /sale=auction/, 'switching coin dropped the sale type: ' + href)
    }

    /*  Everything must now SAY sale=all. It used to be the default and so
        carried no parameter at all; a bare URL means auctions today, so a
        link that drops the parameter no longer leads where its label says. */
    assert.ok(filtered.sale.some(h => h === '/review?coin=US.MORGAN&amp;sale=all'),
        'no way to every sale type that keeps the coin: ' + JSON.stringify(filtered.sale))

    /*  The default tab is the one allowed to drop the parameter, and only
        when it is not the current view. */
    const { '/review?coin=US.MORGAN&sale=bin': bin } =
        await fetchAll(opened, ['/review?coin=US.MORGAN&sale=bin'])
    assert.ok(tabStrips(bin.body).sale.some(h => h === '/review?coin=US.MORGAN'),
        'the default tab does not drop its parameter, so a bare URL is unreachable')

    /*  And from the EVERYTHING view specifically, which is the case the
        old omit-when-default idiom left broken: sale=all was the default so
        it was dropped from every link, and once a bare URL means auctions,
        clicking another coin from Everything silently narrows you to
        auctions. The auction and bin views cannot catch this - they are
        never the omitted value. */
    const { '/review?coin=US.MORGAN&sale=all': everything } =
        await fetchAll(opened, ['/review?coin=US.MORGAN&sale=all'])
    const fromAll = tabStrips(everything.body).coin.filter(h => /coin=GB\.SOV/.test(h))
    assert.ok(fromAll.length > 0, 'no link to the other series from the Everything view')
    for (const href of fromAll) {
        assert.match(href, /sale=all/,
            'switching coin from Everything drops you into auctions: ' + href)
    }

    /*  The way back after a verdict, too - stated explicitly whatever the
        filter, including the default. */
    assert.match(auctions.body, /name="back" value="\/review\?coin=US\.MORGAN&amp;sale=auction"/,
        'the return path lost a filter')
    assert.match(bin.body, /name="back" value="\/review\?coin=US\.MORGAN&amp;sale=bin"/,
        'the return path lost a filter')
    opened.db.close()
})

/*
    A store built for the rule pages, kept separate from twoSeriesStore()
    on purpose: two tests there count rendered rows, and adding dealer
    titles to the shared fixture would fail those instead of these.

    The shape that matters is a REJECTED Morgan whose title shares a phrase
    with priced coins of both series. That is the only arrangement in which
    a dropped series argument is visible: the rule is proposed from a Morgan,
    so it must be offered against Morgans, and there are sovereigns nearby
    for a series-blind version to wrongly count.
*/
function dealerStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 49.7, null, 'test')

    const add = (legacyId, title, series, key, fineOz, price) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title,
            buyingOptions: 'FIXED_PRICE', endTime: null
        }, now)
        repository.saveSnapshot(id, { price, shipping: 4, observedAt: now })
        repository.setListingSeries(id, series)
        /*  key === null models the large unclaimed pile: stored, never
            priced, and unreachable by any rule. */
        if (key !== null) {
            repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', fineOz, {})
        }
        return id
    }

    /*  Priced coins carrying the dealer's name, in BOTH series. */
    add('sov1', 'Bunce & Co 2020 Gold Sovereign Proof', 'GB.SOV', 'GB.SOV.BULLION.FULL', 0.2354, 900)
    add('sov2', 'Bunce & Co 2021 Gold Sovereign Proof', 'GB.SOV', 'GB.SOV.BULLION.FULL', 0.2354, 910)
    add('dol1', 'Bunce & Co 1921 Morgan Silver Dollar', 'US.MORGAN', 'US.MORGAN.COMMON.DOLLAR', 0.7734, 70)
    /*  Same phrase, no pack claimed it: no rule can reach this one. */
    add('junk1', 'Bunce & Co commemorative medal', null, null, 0, 30)

    /*  The rejected Morgan the rule gets proposed from. */
    const rejected = add('dol2', 'Bunce & Co Morgan Silver Dollar Replica Copy',
        'US.MORGAN', null, 0, 40)
    repository.queueForReview(rejected, 'looks like a replica', null, 0.2)
    repository.label({
        legacyId: 'dol2',
        title: 'Bunce & Co Morgan Silver Dollar Replica Copy',
        verdict: 'NOT_TRACKED',
        series: 'US.MORGAN'
    })

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('the rule pages render at all', async () => {
    const opened = dealerStore()
    const pages = await fetchAll(opened, [
        '/teach?legacy=dol2&back=%2Freview',
        '/rule-confirm?phrase=bunce&series=US.MORGAN&back=%2Freview',
        /*  Reached from /rules with no proposal behind it, which is the
            hand-typed blocklist path. */
        '/rule-confirm?phrase=bunce&back=%2Frules'
    ])

    for (const [path, page] of Object.entries(pages)) {
        assert.strictEqual(page.status, 200, path + ' returned ' + page.status)
        assert.ok(!/TypeError|ReferenceError|is not defined|is not a function/.test(page.body),
            path + ' rendered an error: ' +
            (page.body.match(/(TypeError|ReferenceError)[^<]*/) || [''])[0])
    }
    opened.db.close()
})

test('a rule proposed from a Morgan is offered against Morgans', async () => {
    const opened = dealerStore()
    const teachPath = '/teach?legacy=dol2&back=%2Freview'
    const teach = (await fetchAll(opened, [teachPath]))[teachPath].body

    /*  Every route off this page must carry the series. A safe proposal
        posts it as a hidden field; a risky one hands it to /rule-confirm on
        the query string. Whichever bucket the inducer puts a phrase in, the
        page must never offer US.MORGAN work scoped to GB.SOV. */
    assert.ok(/US\.MORGAN/.test(teach), 'the teach page never mentions the series')
    assert.ok(!/value="GB\.SOV"/.test(teach),
        'a Morgan proposal offers to write a GB.SOV rule')
    assert.ok(!/series=GB\.SOV/.test(teach),
        'a Morgan proposal links to /rule-confirm scoped to GB.SOV')

    /*  And the confirmation page must keep it, since that is where the
        risky ones are actually committed. */
    const confirmPath = '/rule-confirm?phrase=bunce&series=US.MORGAN&back=%2Freview'
    const body = (await fetchAll(opened, [confirmPath]))[confirmPath].body
    assert.ok(/name="series" value="US\.MORGAN"/.test(body),
        'the commit form would write the rule against the wrong series')
    opened.db.close()
})

test('a rule counts only the coins it can actually reach', async () => {
    const opened = dealerStore()
    const paths = [
        '/rule-confirm?phrase=bunce&series=GB.SOV&back=%2Frules',
        '/rule-confirm?phrase=bunce&series=US.MORGAN&back=%2Frules'
    ]
    const pages = await fetchAll(opened, paths)

    /*  "bunce" is on 5 titles: 2 priced sovereigns, 1 priced Morgan, 1
        rejected Morgan and 1 nothing claimed. compile() tests a rule only
        against the pack that owns the listing, so the sovereign rule breaks
        2 and the Morgan rule breaks 1 - never 3. */
    const sov = pages[paths[0]].body
    assert.ok(/Priced today, would stop \(2\)/.test(sov),
        'the sovereign rule does not report exactly 2 breaks: ' +
        (sov.match(/Priced today, would stop \(\d+\)/) || ['none'])[0])

    const morgan = pages[paths[1]].body
    assert.ok(/Priced today, would stop \(1\)/.test(morgan),
        'the Morgan rule does not report exactly 1 break: ' +
        (morgan.match(/Priced today, would stop \(\d+\)/) || ['none'])[0])

    /*  And it must say what it cannot touch, rather than quietly counting
        those titles or quietly dropping them. */
    assert.ok(/not british gold sovereigns, so this rule leaves them alone/.test(sov),
        'the sovereign rule does not disclose the matches it cannot reach')
    opened.db.close()
})

test('the nav underlines the page you are on, and only that one', async () => {
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened,
        ['/', '/review', '/rules', '/listings?key=GB.SOV.BULLION.FULL'])

    const lit = body => (body.match(/<nav>[\s\S]*?<\/nav>/) || [''])[0]
        .split('<a ').filter(a => /class="on"/.test(a))
        .map(a => (a.match(/href="([^"]*)"/) || [])[1])

    assert.deepStrictEqual(lit(pages['/'].body), ['/'])
    assert.deepStrictEqual(lit(pages['/review'].body), ['/review'])
    assert.deepStrictEqual(lit(pages['/rules'].body), ['/rules'])
    /*  A drill-down lights nothing: it belongs to no single tab, and it
        carries its own heading and a way back. */
    assert.deepStrictEqual(lit(pages['/listings?key=GB.SOV.BULLION.FULL'].body), [])

    /*  One <nav>, because report/build.js strips it with a non-greedy regex
        and a second would survive into a shared report. */
    for (const page of Object.values(pages)) {
        assert.strictEqual((page.body.match(/<nav>/g) || []).length, 1)
    }
    opened.db.close()
})

async function post (opened, path, fields) {
    const server = SERVER.start(opened, { port: 0, host: '127.0.0.1', quiet: true })
    await new Promise(resolve => server.once('listening', resolve))
    const port = server.address().port
    try {
        const response = await fetch('http://127.0.0.1:' + port + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams(fields).toString(),
            redirect: 'manual'
        })
        return { status: response.status, location: response.headers.get('location') }
    } finally {
        server.close()
    }
}

test('a dealer can be blocked by name, and unblocked again', async () => {
    const opened = dealerStore()
    const priced = () => opened.db.prepare(
        'SELECT COUNT(DISTINCT browse_id) AS n FROM listing_instrument').get().n

    assert.strictEqual(priced(), 3, 'fixture should start with 3 priced coins')

    /*  Typed in mixed case, the way a person types a dealer's name. */
    const added = await post(opened, '/rule', {
        phrase: 'Bunce & Co', series: 'GB.SOV', support: '2', back: '/rules'
    })
    assert.strictEqual(added.status, 303)

    /*  Scoped to sovereigns, so the Morgan keeps its price. */
    assert.strictEqual(priced(), 1, 'the sovereigns did not stop being priced')

    const rules = opened.repository.learnedRules()
    assert.strictEqual(rules.length, 1)
    /*  saveLearnedRule normalises case, and the rest of the tool relies on
        it: the "Rule added" banner looks the phrase up lowercased, and the
        unique index is on the raw column, so a stored "Bunce & Co" would
        sit beside "bunce & co" as a second rule doing the same job. Only a
        typed phrase can arrive in mixed case - the inducer lowercases the
        title before it generates candidates - so this guards the case that
        the blocklist form newly makes reachable. */
    assert.strictEqual(rules[0].phrase, 'bunce & co',
        'the phrase was stored in the case it was typed')
    assert.strictEqual(rules[0].series, 'GB.SOV')

    /*  The landing page must find the rule it just wrote, or there is no
        confirmation and no undo button. */
    const landed = await fetchAll(opened, [added.location])
    assert.ok(/Rule added/.test(landed[added.location].body),
        'the rules page does not confirm the rule it just saved')

    /*  And removing it puts every one of them back. That round trip is the
        whole safety claim the form makes. */
    const removed = await post(opened, '/rule/delete', { id: String(rules[0].id) })
    assert.strictEqual(removed.status, 303)
    assert.strictEqual(priced(), 3, 'removing the rule did not restore the coins')

    opened.db.close()
})

test('the rules table dates a rule instead of counting it', async () => {
    const opened = dealerStore()
    opened.repository.saveLearnedRule({
        phrase: 'bunce & co',
        kind: 'NOT_TRACKED',
        series: 'GB.SOV',
        /*  A support that is not a plausible date, so the two cannot be
            confused if the column regresses. */
        support: 4321
    })
    const page = (await fetchAll(opened, ['/rules']))['/rules'].body
    const row = (page.match(/<tr>\s*<td>drop titles containing[\s\S]*?<\/tr>/) || [''])[0]

    assert.ok(!/>4321</.test(row), 'the "when accepted" column is showing the support count')
    assert.ok(/>\d{4}-\d{2}-\d{2}</.test(row), 'the "when accepted" column shows no date')

    /*  Matches now must be scoped like the rule: 2 sovereigns, not the 4
        titles in the store carrying the phrase. */
    assert.ok(/<td class="mono">2<\/td>/.test(row),
        '"matches now" is counting coins the rule cannot reach: ' + row)
    opened.db.close()
})

test('the blocklist form offers every series and saves nothing by itself', async () => {
    const opened = dealerStore()
    const page = (await fetchAll(opened, ['/rules']))['/rules'].body

    const form = (page.match(/<form method="get" action="\/rule-confirm"[\s\S]*?<\/form>/) || [''])[0]
    assert.ok(form.length > 0, 'there is no blocklist form on the rules page')
    assert.ok(/name="phrase"/.test(form) && /required/.test(form))
    for (const pack of SERIES.all()) {
        assert.ok(form.includes('value="' + pack.id + '"'),
            pack.id + ' cannot be chosen in the blocklist form')
    }
    /*  A GET to a preview, never a write. */
    assert.ok(!/method="post"/i.test(form))
    assert.strictEqual(opened.repository.learnedRules().length, 0)
    opened.db.close()
})

test('a queued listing still counts as priced, so the preview cannot understate', async () => {
    const opened = dealerStore()

    /*  sov1 is in an instrument AND in the review queue - the state 253
        coins in the live store are in. The preview must count it, because
        accepting the rule will drop it and the rules page will say so. */
    opened.repository.queueForReview('v1|sov1|0', 'worth a look', 'GB.SOV.BULLION.FULL', 0.5)

    const row = opened.repository.titleCorpus().find(r => r.legacyId === 'sov1')
    assert.strictEqual(row.priced, 1,
        'a queued listing reads as unpriced, so a rule that drops it looks harmless')

    /*  And end to end: the page must promise the same number the click
        delivers. Understating here is worse than overstating - it is the
        difference between a warning and a one-click button. */
    const path = '/rule-confirm?phrase=bunce&series=GB.SOV&back=%2Frules'
    const body = (await fetchAll(opened, [path]))[path].body
    const promised = Number((body.match(/Priced today, would stop \((\d+)\)/) || [])[1])

    const before = opened.db.prepare(
        'SELECT COUNT(DISTINCT browse_id) AS n FROM listing_instrument').get().n
    await post(opened, '/rule', { phrase: 'bunce & co', series: 'GB.SOV', support: '2' })
    const after = opened.db.prepare(
        'SELECT COUNT(DISTINCT browse_id) AS n FROM listing_instrument').get().n

    assert.strictEqual(promised, before - after,
        'the confirmation page promised ' + promised + ' but the click dropped ' +
        (before - after))
    opened.db.close()
})

/*
    A drill-down with lots that can be told apart BY ORDER.

    twoSeriesStore gives every auction the same end time, so nothing there
    can catch a sort. This one spreads end times deliberately and makes the
    dearest lot the LAST to end, so dearest-first and ending-soonest-first
    produce opposite sequences: a test that passes under both is not testing
    the sort.
*/
function orderingStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const key = 'GB.SOV.BULLION.FULL'
    const at = hours => new Date(Date.now() + hours * 3600000).toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const add = (legacyId, endTime, price, auction) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title: 'Gold Sovereign ' + legacyId,
            buyingOptions: auction ? 'AUCTION' : 'FIXED_PRICE',
            endTime
        }, now)
        repository.saveSnapshot(id, { price, shipping: 0, observedAt: now })
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        return id
    }

    /*  Auctions: dearest ends LAST, so the two orderings disagree. */
    add('a-soon', at(1), 800, true)
    add('a-mid', at(5), 900, true)
    add('a-late', at(9), 1000, true)

    /*  Good-'Til-Cancelled Buy-It-Nows: no end time at all, and dearer than
        every auction, so under dearest-first they would lead the list. */
    add('b-dear', null, 5000, false)
    add('b-cheap', null, 4000, false)

    /*  One ENDED auction, judged. It lands in "Ended without selling" and
        never in `live`, so it cannot disturb an ordering assertion - it is
        here so the judged tile renders at all and its label can be pinned. */
    add('a-ended', at(-4), 850, true)
    repository.label({
        legacyId: 'a-ended', title: 'Gold Sovereign a-ended', verdict: 'SOVEREIGN'
    })
    /*  With an outcome, so the bids figure has something to report - it is
        auction-only by nature and is the statistic that must stay reachable
        from the Everything tab. */
    repository.saveOutcome('v1|a-ended|0', {
        endTime: at(-4), sold: true, finalPrice: 860, shipping: 0,
        bidCount: 7, saleType: 'AUCTION', censored: false, source: 'test'
    })

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}), key }
}

/*  The legacy ids of the "On sale now" section, in the order rendered. */
function liveOrder (body) {
    const section = body.split('<h2>On sale now')[1] || ''
    const upTo = section.split('<h2>')[0]
    return [...upTo.matchAll(/name="pick" value="([^"]*)"/g)].map(m => m[1])
}

test('a bare drill-down URL is the auction view, and Everything must ask', async () => {
    const opened = orderingStore()
    const bare = '/listings?key=' + opened.key
    const all = bare + '&sale=all'
    const pages = await fetchAll(opened, [bare, all])

    /*  Three auctions, no Buy-It-Now, without anything having been clicked. */
    assert.deepStrictEqual(liveOrder(pages[bare].body).sort(),
        ['a-late', 'a-mid', 'a-soon'],
        'a bare drill-down URL is not the auction view')

    /*  And sale=all has to be an accepted value, not merely the fallback for
        anything unrecognised - it is the only way back to the whole market. */
    assert.strictEqual(liveOrder(pages[all].body).length, 5,
        'sale=all does not show every lot')

    opened.db.close()
})

test('live lots run ending soonest, with the undated ones last', async () => {
    const opened = orderingStore()
    const path = '/listings?key=' + opened.key + '&sale=all'
    const body = (await fetchAll(opened, [path]))[path].body

    /*  The auctions in end-time order, THEN the Good-'Til-Cancelled lots
        dearest-first. Written as one exact sequence because the interesting
        failures are orderings that get part of it right: dearest-first would
        put b-dear first, and a bare String() comparison would sort the
        undated lots as "null" - after "2026" - scattering them among the
        auctions rather than below them. */
    assert.deepStrictEqual(liveOrder(body),
        ['a-soon', 'a-mid', 'a-late', 'b-dear', 'b-cheap'],
        'live lots are not ending-soonest with undated last')

    /*  And the blurb has to describe what the list actually did. */
    assert.match(body, /Ending soonest first, undated last/,
        'the ordering blurb does not match a mixed list')

    opened.db.close()
})

test('the ordering blurb follows the tab rather than being written down', async () => {
    const opened = orderingStore()
    const auctions = '/listings?key=' + opened.key
    const bin = '/listings?key=' + opened.key + '&sale=bin'
    const pages = await fetchAll(opened, [auctions, bin])

    /*  Every auction has an end time, so the qualifier would be noise. */
    assert.match(pages[auctions].body, /Ending soonest first &mdash;/)
    assert.ok(!/undated last/.test(pages[auctions].body),
        'the auction tab claims undated lots it does not have')

    /*  No Buy-It-Now lot has one, so there is no soonest to speak of and the
        list is dearest-first exactly as it always was. */
    assert.match(pages[bin].body, /Dearest first/)
    assert.deepStrictEqual(liveOrder(pages[bin].body), ['b-dear', 'b-cheap'],
        'undated lots are not dearest-first among themselves')

    opened.db.close()
})

test('an auctions-only view shows no Buy-It-Now statistic', async () => {
    const opened = orderingStore()
    const auctions = '/listings?key=' + opened.key
    const bin = '/listings?key=' + opened.key + '&sale=bin'
    const all = '/listings?key=' + opened.key + '&sale=all'
    const pages = await fetchAll(opened, [auctions, bin, all])

    /*  The asking median is built from FIXED_PRICE listings alone
        (liquidity.js:44). Printing it under an auctions-only view is the
        cross-pollution the filter exists to prevent, and it is the DEFAULT
        view - so this is the one that would be wrong on every page load. */
    const asking = /median <strong>asking<\/strong> premium/
    assert.ok(!asking.test(pages[auctions].body),
        'the auction view shows a Buy-It-Now-only asking median')
    assert.ok(asking.test(pages[bin].body),
        'the Buy-It-Now view lost its asking median')
    assert.ok(asking.test(pages[all].body),
        'the Everything view lost its asking median')

    /*  Everything shows the UNION. The bids figure is auction-only by
        nature, which is a reason to label it rather than to make it
        unreachable from the view whose whole point is to show everything. */
    const bids = /median bids on auctions that got any/
    assert.ok(bids.test(pages[auctions].body), 'the auction view lost its bids figure')
    assert.ok(bids.test(pages[all].body),
        'the Everything view cannot reach a statistic the auction view shows')
    assert.ok(!bids.test(pages[bin].body),
        'the Buy-It-Now view shows an auction-only statistic')

    /*  Each figure names the population it is drawn from, so a filtered
        count and a corpus-wide metric can sit side by side honestly. */
    assert.match(pages[bin].body, /across live Buy-It-Now lots/)
    assert.match(pages[auctions].body, /auctions actually <strong>cleared<\/strong> at/)

    /*  Every FILTER-SCOPED count says which filter, including the judged
        tile - it sits in the same hero row as two counts that do, so being
        the one that does not is how a number gets read as corpus-wide. */
    for (const [sale, page] of [['auction', pages[auctions]], ['bin', pages[bin]]]) {
        const noun = sale === 'auction' ? 'at auction' : 'at Buy-It-Now'
        for (const label of ['completed sales', 'live']) {
            assert.ok(page.body.includes(label + ' ' + noun),
                '"' + label + '" is not scoped to the ' + sale + ' tab')
        }
        assert.ok(/you have judged/.test(page.body) || sale === 'bin',
            'the fixture no longer renders a judged tile, so its label is untested')
        if (/you have judged/.test(page.body)) {
            assert.ok(page.body.includes('you have judged ' + noun),
                'the judged tile is filter-scoped but does not say so')
        }
    }

    opened.db.close()
})

test('the drill-down says how much the default is hiding', async () => {
    const opened = orderingStore()
    const auctions = '/listings?key=' + opened.key
    const body = (await fetchAll(opened, [auctions]))[auctions].body

    /*  The tab counts must be the size of the pile, not the size of the
        fetch - opening on auctions hides most of a real market, and the
        label is the only thing that says so on every page view. */
    assert.match(body, /Buy-It-Now \(2\)/, 'the Buy-It-Now tab does not carry its count')
    assert.match(body, /Everything \(6\)/, 'the Everything tab does not carry its count')
    assert.match(body, /Auctions \(4\)/, 'the auction tab does not carry its count')

    opened.db.close()
})

test('a filtered listings view states the filter in every link back', async () => {
    const opened = orderingStore()
    for (const sale of ['auction', 'bin', 'all']) {
        const path = '/listings?key=' + opened.key + '&sale=' + sale
        const body = (await fetchAll(opened, [path]))[path].body
        const backs = [...body.matchAll(/name="back" value="([^"]*)"/g)].map(m => m[1])
        assert.ok(backs.length > 0, 'no return path rendered for sale=' + sale)
        for (const b of backs) {
            assert.ok(b.includes('sale=' + sale),
                'a return path omitted the filter and would land elsewhere: ' + b)
        }
    }
    opened.db.close()
})

test('a review tab counts what it opens on', async () => {
    const opened = twoSeriesStore()
    const bare = '/review'
    const body = (await fetchAll(opened, [bare]))[bare].body

    /*  The coin tabs used to carry an unfiltered total beside a filtered
        list. On the live store that had the unattributed tab reading 20,562
        and opening on 1,691.

        Read from the CURRENT tab, not the first one with a number in it.
        The strip is ordered by the filtered count and the page deliberately
        lands on the biggest REAL series rather than the unattributed pile,
        so the first tab and the rendered one are routinely different coins -
        and comparing one tab's count against another tab's rows is a test
        that passes for the wrong reason. */
    const strips = tabStrips(body)
    const current = (strips.coinStrip || '').match(/class="tab on"[^>]*>([^<]*)</)
    assert.ok(current, 'no coin tab is marked as the current one')
    const advertised = Number((current[1].match(/\((\d+)\)/) || [])[1])
    assert.ok(Number.isFinite(advertised),
        'the current coin tab carries no count: ' + current[1])

    const shown = [...body.matchAll(/name="pick" value="/g)].length
    const settled = [...body.matchAll(/pick-spacer/g)].length
    assert.ok(advertised <= shown + settled,
        'the current coin tab advertises ' + advertised + ' but the page renders ' +
        shown + ' judgeable rows and ' + settled + ' already-settled ones')

    opened.db.close()
})

/*
    The one ordering the row limit can lie about.

    While the live section was displayed dearest-first it matched the order
    the SQL admitted rows in, so a cap could only hide the tail of what you
    were reading. Ending-soonest is the first ordering where the two differ:
    the fetch still admits the DEAREST, so a cheap lot closing in minutes can
    be missing entirely from a list whose stated promise is that the top of it
    is what you can still bid on.

    No key on the live store is truncated today - the largest fetches 480 of
    500 - so this is about what the page says when it happens, which is the
    only part that can be got right in advance.
*/
test('a capped fetch does not claim to be the whole market', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const key = 'GB.SOV.BULLION.FULL'
    const at = h => new Date(Date.now() + h * 3600000).toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    /*  More live auctions than the page fetches, with price and end time
        running in opposite directions so the cap provably drops the soonest. */
    for (let i = 0; i < 620; i++) {
        const id = 'v1|lot' + i + '|0'
        repository.saveListing({
            browseId: id, legacyId: 'lot' + i, title: 'Gold Sovereign ' + i,
            buyingOptions: 'AUCTION', endTime: at(i + 1)
        }, now)
        repository.saveSnapshot(id, { price: 500 + i, shipping: 0, observedAt: now })
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
    }

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const path = '/listings?key=' + key
    const body = (await fetchAll(opened, [path]))[path].body

    /*  The tab knows the real size; the sections only ever see the fetch.
        The page must not print the second as though it were the first. */
    assert.match(body, /Auctions \(620\)/, 'the tab does not carry the true count')
    assert.match(body, /620 lots on this tab/,
        'the page does not disclose that the fetch was capped')
    assert.match(body, /fetched the dearest 500 of them/,
        'the page does not say which 500 it fetched')

    /*  And it must stop promising that the top of the list is the soonest,
        because on a capped fetch it is the soonest of the dearest. */
    assert.ok(!/the top of this list is the part you can still bid on/.test(body),
        'a capped fetch still promises the soonest-ending lots');

    /*  Concretely: lot0 ends first and is the cheapest, so the cap drops it.
        If it were present the disclosure would be unnecessary. */
    assert.ok(!/value="lot0"/.test(body),
        'the fixture no longer truncates, so this test proves nothing')

    db.close()
})


/*
    The live store's shape, which twoSeriesStore does not have: the biggest
    pile by far is the unattributed one, and the page deliberately does NOT
    land there. So the first tab in the strip and the tab actually being
    shown are different coins, which is the only arrangement in which reading
    the wrong one is visible.
*/
function lopsidedStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const add = (n, series, auction) => {
        const id = 'v1|' + (series || 'none') + n + '|0'
        repository.saveListing({
            browseId: id, legacyId: (series || 'none') + n,
            title: 'Gold Sovereign ' + n,
            buyingOptions: auction ? 'AUCTION' : 'FIXED_PRICE',
            endTime: auction ? new Date(Date.now() + 3600000).toISOString() : null
        }, now)
        repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
        if (series !== null) { repository.setListingSeries(id, series) }
        repository.queueForReview(id, 'worth a look', null, 0.5)
    }

    /*  Twelve unattributed against three sovereigns, all auctions, so the
        unattributed tab leads the strip and the sovereign tab is current. */
    for (let n = 0; n < 12; n++) { add(n, null, true) }
    for (let n = 0; n < 3; n++) { add(100 + n, 'GB.SOV', true) }

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('the review page lands on a real coin, and counts that one', async () => {
    const opened = lopsidedStore()
    const body = (await fetchAll(opened, ['/review']))['/review'].body
    const strips = tabStrips(body)

    /*  Landing on the unattributed pile is landing on a page of jewellery
        and fishing reels, so the page skips it - which is exactly why the
        first tab is not the one to read a count from. */
    const first = (strips.coinStrip || '').match(/>([^<]*\(\d+\)[^<]*)</)
    const current = (strips.coinStrip || '').match(/class="tab on"[^>]*>([^<]*)</)
    assert.ok(first && current, 'the coin strip is missing a first or current tab')
    assert.match(first[1], /Not attributed \(12\)/, 'the largest pile does not lead the strip')
    assert.match(current[1], /\(3\)/, 'the page is not showing the sovereigns')
    assert.notStrictEqual(first[1], current[1],
        'the fixture no longer distinguishes the first tab from the current one')

    /*  And the count on the tab being shown is the number of rows shown. */
    const shown = [...body.matchAll(/name="pick" value="/g)].length
    assert.strictEqual(shown, 3,
        'the current tab advertises 3 but the page renders ' + shown)
    opened.db.close()
})

/*
    The documented first run.

    The demo is the only path that produces a working store without eBay
    credentials, and its noise lots are the only thing it queues for review.
    While every one of them was FIXED_PRICE, a fresh demo's review page had
    three empty sections under an auction default - on the one run where the
    tool has to explain itself and the user has no way to know a filter is
    the reason.
*/
test('a fresh demo has review work on the tab it opens', async () => {
    const db = newDatabase(':memory:')
    require('../src/demo.js').generate(db, {})
    const repository = newRepository(db, { sellerSalt: 'demo' })
    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }

    const body = (await fetchAll(opened, ['/review']))['/review'].body
    const shown = [...body.matchAll(/name="pick" value="/g)].length
    assert.ok(shown > 0,
        'a bare /review on a fresh demo renders no rows at all');

    /*  And the other tab still has the bulk, so the demo shows what the
        filter is FOR rather than just having some of everything. */
    const strips = tabStrips(body)
    const bin = (strips.saleStrip || '').match(/Buy-It-Now \((\d+)\)/)
    assert.ok(bin && Number(bin[1]) > 0,
        'the demo has nothing on the Buy-It-Now tab')
    db.close()
})


/*
    Which coin a bare /review opens on, when the two readings disagree.

    Sovereigns hold the bigger queue outright; Morgans hold more of it that
    an auction-defaulted page will actually show. Landing by the unfiltered
    total would open the largest queue on its emptiest tab - the page would
    say "British Gold Sovereigns (1)" and render one row while twelve Morgan
    auctions sat one tab over.
*/
test('the review queue opens on the coin with the most work on this tab', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 49.7, null, 'test')

    const add = (id, series, auction) => {
        repository.saveListing({
            browseId: 'v1|' + id + '|0', legacyId: id, title: 'Coin ' + id,
            buyingOptions: auction ? 'AUCTION' : 'FIXED_PRICE',
            endTime: auction ? new Date(Date.now() + 3600000).toISOString() : null
        }, now)
        repository.saveSnapshot('v1|' + id + '|0', { price: 900, shipping: 0, observedAt: now })
        repository.setListingSeries('v1|' + id + '|0', series)
        repository.queueForReview('v1|' + id + '|0', 'worth a look', null, 0.5)
    }

    /*  Sovereigns: 20 queued, 1 of them an auction.
        Morgans:    12 queued, all of them auctions. */
    for (let n = 0; n < 20; n++) { add('s' + n, 'GB.SOV', n === 0) }
    for (let n = 0; n < 12; n++) { add('m' + n, 'US.MORGAN', true) }

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }

    const body = (await fetchAll(opened, ['/review']))['/review'].body
    const current = (tabStrips(body).coinStrip || '').match(/class="tab on"[^>]*>([^<]*)</)
    assert.ok(current, 'no current coin tab')
    assert.match(current[1], /Morgan/,
        'the queue opened on the largest pile rather than the most workable one: ' + current[1])
    assert.match(current[1], /\(12\)/, 'the tab does not carry its filtered count')

    /*  And the tab NOT being shown carries its filtered count too. This is
        the pair that separates the two numbers: sovereigns hold 20 queued
        rows of which 1 is an auction, so a tab reading (20) here would be
        advertising work this view cannot show. */
    assert.match(tabStrips(body).coinStrip, /British Gold Sovereigns \(1\)/,
        'the sovereign tab advertises its unfiltered total on an auction view')

    /*  And switching to the Everything tab does flip which coin is biggest,
        which is what makes the two readings genuinely different. */
    const all = (await fetchAll(opened, ['/review?sale=all']))['/review?sale=all'].body
    const currentAll = (tabStrips(all).coinStrip || '').match(/class="tab on"[^>]*>([^<]*)</)
    assert.match(currentAll[1], /Sovereign/,
        'the Everything view does not open on the largest queue: ' + currentAll[1])
    db.close()
})


/*
    A live dashboard must never be served from a cache.

    There were no cache headers at all, and "no headers" is not "do not
    cache": with no Cache-Control, no ETag and no Last-Modified a browser
    falls back to heuristic caching and may reuse what it already has. The
    symptom is the worst kind - the page looks fine and the numbers are
    yesterday's - and it cost an hour after a deploy that had, in fact,
    worked.
*/
test('no page is cacheable', async () => {
    const opened = twoSeriesStore()
    const paths = ['/', '/review', '/rules', '/listings?key=GB.SOV.BULLION.FULL']
    const pages = await fetchAll(opened, paths)

    for (const path of paths) {
        const cc = pages[path].headers.get('cache-control')
        assert.ok(cc && /no-store/.test(cc),
            path + ' is cacheable: Cache-Control is ' + JSON.stringify(cc))
    }
    opened.db.close()
})

/*
    A second listener, because a container cannot see this host's loopback.

    MetalHead runs in Docker and reaches the Pi over a bridge gateway, so a
    dashboard bound to 127.0.0.1 alone is invisible to it however close the
    two apps sit on disk. This is the whole of the network change.

    Both halves matter and only one is obvious. The extra address must SERVE
    - the same pages, not a stub. And a bad extra address must NOT take the
    dashboard down: the bridge gateway does not exist on a laptop and moves
    if the docker network is recreated, so the loopback listener has to come
    up regardless. That second property is the one that keeps a misconfigured
    deploy from looking like a dead Pi.
*/
test('a second address serves the same pages', async () => {
    const opened = twoSeriesStore()

    /*  127.0.0.2 is loopback too, so this exercises a genuinely separate
        listener without touching any real network interface. */
    const server = SERVER.start(opened, {
        port: 0, host: '127.0.0.1', quiet: true, alsoHosts: ['127.0.0.2']
    })
    await new Promise(resolve => server.once('listening', resolve))
    const port = server.address().port

    /*  try/finally, because a listener left running by a failed assertion
        keeps the whole test process alive - the runner then never prints
        WHY it failed, which turns a one-line fix into an afternoon. */
    try {
        await new Promise(resolve => setTimeout(resolve, 250))

        const primary = await fetch('http://127.0.0.1:' + port + '/review')
        assert.strictEqual(primary.status, 200, 'the primary address does not serve')

        const second = await fetch('http://127.0.0.2:' + port + '/review',
            { signal: AbortSignal.timeout(5000) })
        assert.strictEqual(second.status, 200, 'the extra address does not serve')
        assert.ok((await second.text()).includes('Needs review'),
            'the extra address served something else')
    } finally {
        await new Promise(resolve => server.close(resolve))
        opened.db.close()
    }
})

test('an unusable extra address does not stop the dashboard', async () => {
    const opened = twoSeriesStore()

    /*  An address this machine does not have. listen() fails asynchronously
        with EADDRNOTAVAIL, and if that were unhandled it would take the
        process down - so this is really a test that the error handler exists. */
    const server = SERVER.start(opened, {
        port: 0, host: '127.0.0.1', quiet: true, alsoHosts: ['203.0.113.1']
    })
    await new Promise(resolve => server.once('listening', resolve))
    await new Promise(resolve => setTimeout(resolve, 250))

    const response = await fetch('http://127.0.0.1:' + server.address().port + '/review')
    assert.strictEqual(response.status, 200,
        'a bad extra address took the working listener with it')

    await new Promise(resolve => server.close(resolve))
    opened.db.close()
})

/*
    A silver coin is admitted on silver, not on gold.

    THE BUG THIS PINS, in the owner's own screenshot: "Live auctions at or
    near spot" listing a MORGAN DOLLAR at GBP 78.69 badged "priced near spot
    +110%". The panel took ONE gold price for the page and divided every lot
    by it, so a cheap silver coin read about 3% of its "spot value" and
    passed a filter meant to admit things within 5% OF spot. The badge beside
    it was already computed against silver and said +110%, so the panel
    admitted on one metal and labelled on another.

    Measured on the live store before the fix: 217 of 281 admitted lots were
    Morgans. After: 21, and the sovereign count was unchanged at 64 - which
    is the regression signal that matters.

    The fixture below is built so the two rules disagree loudly. The Morgan
    is priced at more than twice its silver, so it must NOT be admitted; and
    against gold it would read about 3%, so a page that still divides by gold
    cannot help admitting it.
*/
test('a silver lot is judged on silver, in the panel as well as on the badge', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const soon = new Date(Date.now() + 3600000).toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3253.92, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 48.50, null, 'test')

    const add = (legacyId, key, fineOz, price) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title: 'Coin ' + legacyId,
            buyingOptions: 'AUCTION', endTime: soon
        }, now)
        repository.saveSnapshot(id, { price, shipping: 0, observedAt: now })
        repository.setListingSeries(id, key.startsWith('US.') ? 'US.MORGAN' : 'GB.SOV')
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', fineOz, {})
    }

    /*  A sovereign at its gold: 0.2354 oz x 3253.92 = GBP 765.97, priced at
        GBP 780 -> 1.018, comfortably inside the 5% band. */
    add('sov', 'GB.SOV.BULLION.FULL', 0.2354, 780)

    /*  A Morgan at MORE THAN TWICE its silver: 0.7734 oz x 48.50 = GBP 37.51,
        priced at GBP 78.69 -> 2.10 against silver, which must be refused.
        Against GOLD the same lot reads 78.69 / 2516 = 0.031, which the old
        code admitted without hesitation. */
    add('morgan', 'US.MORGAN.COMMON.DOLLAR', 0.7734, 78.69)

    /*  One Buy-It-Now per coin type, purely so the page renders. A key with
        no ask sample and no completed sale is dropped from `markets`
        entirely, and with both keys dropped the whole page short-circuits to
        "no market yet" - so without these the panel under test does not
        exist and the assertions below would pass or fail for the wrong
        reason. Priced far above spot so neither can reach the panel. */
    const ask = (legacyId, key, fineOz, price) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title: 'Coin ' + legacyId,
            buyingOptions: 'FIXED_PRICE', endTime: null
        }, now)
        repository.saveSnapshot(id, { price, shipping: 0, observedAt: now })
        repository.setListingSeries(id, key.startsWith('US.') ? 'US.MORGAN' : 'GB.SOV')
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', fineOz, {})
    }
    ask('sov-ask', 'GB.SOV.BULLION.FULL', 0.2354, 1400)
    ask('morgan-ask', 'US.MORGAN.COMMON.DOLLAR', 0.7734, 140)

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }

    /*  ?min=1 because the market page hides a coin type with fewer than
        three listings, and this fixture is deliberately two per type - one
        auction to judge and one ask so the type exists at all. The filter is
        not what is under test here. */
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
    const panel = body.split('id="auctions"')[1] || body

    assert.ok(body.includes('id="auctions"'),
        'the near-spot panel did not render at all, so nothing below is tested')
    assert.ok(panel.includes('value="sov"'),
        'the sovereign, which IS within 5% of its gold, was dropped')
    assert.ok(!panel.includes('value="morgan"'),
        'a Morgan priced at twice its silver was admitted to the near-spot panel')

    /*  And the metal must reach the row at all - the whole fix is one column
        travelling with the coin. */
    const live = repository.liveAuctions(50)
    const morgan = live.find(r => r.legacyId === 'morgan')
    assert.strictEqual(morgan.metal, 'XAG', 'liveAuctions did not carry the metal')
    assert.strictEqual(live.find(r => r.legacyId === 'sov').metal, 'XAU')

    db.close()
})

/*
    The same omission, on the table of what actually sold.

    Every resolved Morgan reported about -97%, because the premium was taken
    against gold. That is not a rounding error - it is the wrong unit, and it
    made the one table in the tool built entirely on real prices useless for
    half its rows.
*/
test('a sold silver lot reports its premium over silver', () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3253.92, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 48.50, null, 'test')

    const id = 'v1|sold|0'
    repository.saveListing({
        browseId: id, legacyId: 'sold', title: 'Morgan Dollar 1903',
        buyingOptions: 'AUCTION', endTime: now
    }, now)
    repository.saveSnapshot(id, { price: 78, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'US.MORGAN')
    repository.saveClassification(id, [{ key: 'US.MORGAN.COMMON.DOLLAR', level: 0 }],
        0.9, 'title', 0.7734, {})
    repository.saveOutcome(id, {
        endTime: now, sold: true, finalPrice: 78.69, shipping: 0,
        bidCount: 4, saleType: 'AUCTION', censored: false, source: 'test'
    })

    const sale = repository.recentSales(5).find(r => r.legacyId === 'sold')
    assert.strictEqual(sale.metal, 'XAG', 'recentSales did not carry the metal')
    assert.strictEqual(sale.series, 'US.MORGAN', 'recentSales did not carry the series')

    const spotAt = SPOT.newSpotLookup(db, {})
    /*  What the page now asks for, and what it used to ask for. */
    assert.strictEqual(spotAt(sale.endedAt, sale.metal).gbpPerOz, 48.50)
    assert.strictEqual(spotAt(sale.endedAt).gbpPerOz, 3253.92,
        'the no-metal lookup should still be gold - that is WHY it had to be passed')
    db.close()
})

/*
    And the number a person actually reads.

    The test above proves the metal reaches the row and that the two lookups
    differ. It does NOT prove the page uses the right one - reverting the call
    site left it passing, which is exactly the gap a mutation check exists to
    find. This one renders the table and reads the premium out of it.

    GBP 78.69 against 0.7734 oz of silver at GBP 48.50 is about +115%. Against
    gold the same lot is about -97%. There is no arithmetic that confuses
    those two, so a loose "is it positive" assertion is enough and will not
    go brittle when the buyer-fee schedule is next recalibrated.
*/
test('the sold table prints a silver premium, not a gold one', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3253.92, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 48.50, null, 'test')

    const key = 'US.MORGAN.COMMON.DOLLAR'
    const file = (legacyId, opts) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title: 'Morgan Dollar ' + legacyId,
            buyingOptions: opts.buyingOptions, endTime: opts.endTime
        }, now)
        repository.saveSnapshot(id, { price: opts.price, shipping: 0, observedAt: now })
        repository.setListingSeries(id, 'US.MORGAN')
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.7734, {})
        return id
    }

    const sold = file('sold', { buyingOptions: 'AUCTION', endTime: now, price: 78 })
    repository.saveOutcome(sold, {
        endTime: now, sold: true, finalPrice: 78.69, shipping: 0,
        bidCount: 4, saleType: 'AUCTION', censored: false, source: 'test'
    })
    /*  An ask, so the coin type survives into `markets` and the page renders
        rather than short-circuiting to "no market yet". */
    file('ask', { buyingOptions: 'FIXED_PRICE', endTime: null, price: 140 })

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }

    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
    const table = body.split('id="sold"')[1] || ''
    assert.ok(table.length > 0, 'the sold table did not render, so nothing below is tested')

    /*  Every percentage in the sold row. Against gold this coin reads about
        -97%; against silver, about +115%. */
    const percents = [...table.matchAll(/(-?\d+(?:\.\d+)?)%/g)].map(m => Number(m[1]))
    assert.ok(percents.length > 0, 'no premium was printed at all')
    assert.ok(!percents.some(n => n < -50),
        'the sold table is still pricing silver against gold: ' + JSON.stringify(percents))
    assert.ok(percents.some(n => n > 50),
        'expected a premium over silver, got: ' + JSON.stringify(percents))

    db.close()
})

/*
    Judging a Morgan through the page records a Morgan decision.

    The repository test pins the derivation; this pins the PATH. Both /apply
    and /label passed no series at all, and neither had to change for this to
    work - which is the point of deriving it in the store rather than asking
    every caller to remember. A third caller added later cannot get it wrong.

    Why it matters more than the label row itself: a rule induced from a
    decision inherits that decision's series (server.js passes label.series
    into the proposal), and `learned.compile` only fires a rule against the
    pack that claimed the listing. So a Morgan decision recorded as GB.SOV
    produces a rule that can never fire on a Morgan - it would look accepted,
    appear on /rules, and do nothing at all.
*/
test('a verdict on a Morgan is stored against Morgans, and so is its rule', async () => {
    const opened = twoSeriesStore()
    const morgan = opened.repository.reviewQueue(50, 'US.MORGAN')[0]
    assert.ok(morgan, 'the fixture has no Morgan in the review queue')

    const server = SERVER.start(opened, { port: 0, host: '127.0.0.1', quiet: true })
    await new Promise(resolve => server.once('listening', resolve))
    const port = server.address().port
    try {
        const response = await fetch('http://127.0.0.1:' + port + '/label', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                legacyId: morgan.legacyId,
                verdict: 'NOT_TRACKED',
                back: '/review'
            }).toString(),
            redirect: 'manual'
        })
        assert.strictEqual(response.status, 303)
    } finally {
        server.close()
    }

    const stored = opened.repository.labels().find(l => l.legacyId === morgan.legacyId)
    assert.ok(stored, 'the verdict was not recorded at all')
    assert.strictEqual(stored.series, 'US.MORGAN',
        'a decision made on a Morgan was recorded against sovereigns')

    opened.db.close()
})

/*
    A Morgan page never calls a Morgan a sovereign.

    Straight from the owner's screenshot: a review queue full of Morgan and
    Peace dollars, under a bar reading "Not a sovereign - selected", each row
    ending in "Not a sov", each with a "denomination?" dropdown offering five
    sizes of sovereign and no dollar.

    The last of those was not cosmetic. Without a denomination the tool has no
    fine weight for the coin and so no premium, ever - the dropdown asked a
    question it would not accept the answer to.
*/
test('a Morgan queue is worded and offered in Morgan terms', async () => {
    const opened = twoSeriesStore()
    const path = '/review?coin=US.MORGAN&sale=all'
    const body = (await fetchAll(opened, [path]))[path].body

    assert.ok(body.includes('name="pick"'), 'no Morgan rows rendered, so nothing below is tested')

    /*  Everything except the coin-tab strip, which NAMES the other series on
        purpose - that is how you switch to them, and a page that hid the word
        there would be hiding the way out. */
    const withoutTabs = body.replace(/<div class="tabs">[\s\S]*?<\/div>/g, '')
    assert.ok(!/sovereign/i.test(withoutTabs),
        'a Morgan page still says sovereign: ' +
        (withoutTabs.match(/.{0,50}sovereign.{0,50}/i) || [''])[0])

    assert.ok(body.includes('Not a silver dollar &mdash; selected'),
        'the bulk bar does not name the coin it acts on')
    assert.ok(body.includes('>Not a silver dollar</button>'),
        'the per-row reject button does not name the coin')

    /*  The dropdown must offer the one denomination this coin has, and none
        of the five it does not. */
    assert.ok(body.includes('<option value="DOLLAR"'),
        'a Morgan row cannot be told it is a dollar')
    for (const sovereignOnly of ['FULL', 'HALF', 'QUARTER', 'DOUBLE', 'QUINTUPLE']) {
        assert.ok(!body.includes('<option value="' + sovereignOnly + '"'),
            'a Morgan row offers the sovereign denomination ' + sovereignOnly)
    }

    opened.db.close()
})

test('a sovereign queue still reads exactly as it did', async () => {
    const opened = twoSeriesStore()
    const path = '/review?coin=GB.SOV&sale=all'
    const body = (await fetchAll(opened, [path]))[path].body

    assert.ok(body.includes('Not a sovereign &mdash; selected'),
        'the sovereign wording regressed')
    assert.ok(body.includes('>Not a sovereign</button>'),
        'the per-row button lost its wording')
    /*  Order matters as much as membership: this is the order the dropdown
        has always had, and a change would be a diff the owner would notice
        without it being an improvement.

        Scoped to the denomination select by name, because the row now also
        carries a pool picker. Matching every <option> on the page swept both
        together and reported the pools as reordered denominations - the
        assertion was reading a control it was never about. */
    const denominationSelects = [...body.matchAll(/<select name="d_[^>]*>([\s\S]*?)<\/select>/g)]
    assert.ok(denominationSelects.length > 0, 'the denomination select vanished')
    const options = denominationSelects
        .flatMap(m => [...m[1].matchAll(/<option value="([A-Z_]*)"/g)].map(o => o[1]))
    const distinct = options.filter((d, i) => d !== '' && options.indexOf(d) === i)
    assert.deepStrictEqual(distinct, ['FULL', 'HALF', 'QUARTER', 'DOUBLE', 'QUINTUPLE'],
        'the sovereign denominations changed or reordered: ' + JSON.stringify(distinct))

    /*  And the pools are their own list, in the pack's own order. */
    const poolSelects = [...body.matchAll(/<select name="p_[^>]*>([\s\S]*?)<\/select>/g)]
    assert.ok(poolSelects.length > 0, 'the row offers no way to correct the coin group')
    const pools = [...poolSelects[0][1].matchAll(/<option value="([A-Z_]*)"/g)]
        .map(o => o[1]).filter(x => x !== '')
    assert.deepStrictEqual(pools,
        ['COLLECTOR', 'EARLY', 'GRADED', 'PROOF', 'BRANCH', 'UNATTRIBUTED', 'BULLION'],
        'the sovereign pools changed or reordered: ' + JSON.stringify(pools))

    opened.db.close()
})

test('a mixed panel names no single coin', async () => {
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body

    /*  The front-page panels draw across every series by construction, so
        there is no coin name that is true of the button. Naming one would be
        a lie rather than a default - and the verdict it records is still
        correct per row, because the series is derived from each listing. */
    const panel = body.split('id="auctions"')[1] || ''
    if (panel.includes('name="bulk"')) {
        assert.ok(panel.includes('Not what it says it is &mdash; selected'),
            'a mixed-series panel named one coin')
    }

    opened.db.close()
})

/*
    The list of your own decisions names the coin each one was about.

    An aggregate cannot - "N genuine, M rejected" spans every series and
    naming one would be false - but a ROW is not an aggregate: each label
    carries its own series, so this is exactly where the coin's own word
    belongs and where reading "not a sovereign" against a dollar is wrong.
*/
test('each recorded decision reads in its own coin terms', async () => {
    const opened = dealerStore()
    const body = (await fetchAll(opened, ['/rules']))['/rules'].body

    assert.ok(body.includes('>not a silver dollar</span>'),
        'a Morgan decision is badged in sovereign words')

    /*  And the aggregate above it stays neutral, because it counts both. */
    assert.ok(!/\d+ genuine, \d+ not a/.test(body),
        'the hero tile names a coin it cannot name')

    opened.db.close()
})

/*
    A wrong sale can be thrown out from where you noticed it.

    The owner's report: "it only shows 15 sold auctions and I've no way to
    exclude any if there are incorrect ones slipped through." Both halves
    were true - the table was capped at fifteen and rendered read-only, so a
    sale you could see was wrong had to be hunted down on another page to act
    on.

    It is the most expensive read-only table in the tool. Every clearing
    figure, fair value and bid ceiling is built from these rows and nothing
    else, so one misfiled lot moves the numbers the whole page exists to
    report.
*/
test('a wrong sale can be rejected from the table it appears in', async () => {
    const opened = twoSeriesStore()
    const before = opened.repository.recentSales(100)
    assert.ok(before.length > 0, 'the fixture has no completed sales')
    const target = before[0]

    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
    const table = body.split('id="sold"')[1] || ''
    assert.ok(table.length > 0, 'the sold table did not render')

    /*  The controls the table never had. */
    assert.ok(table.includes('name="pick" value="' + target.legacyId + '"'),
        'a sold row cannot be ticked')
    assert.ok(table.includes('name="reject" value="' + target.legacyId + '"'),
        'a sold row cannot be rejected')
    assert.ok(table.includes('name="bulk"'), 'the sold table has no bulk action')

    /*  And the verdict actually lands, through the same handler every other
        queue posts to. */
    const server = SERVER.start(opened, { port: 0, host: '127.0.0.1', quiet: true })
    await new Promise(resolve => server.once('listening', resolve))
    try {
        const response = await fetch(
            'http://127.0.0.1:' + server.address().port + '/apply', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ reject: target.legacyId, back: '/' }).toString(),
                redirect: 'manual'
            })
        assert.strictEqual(response.status, 303)
    } finally {
        server.close()
    }

    const label = opened.repository.labels().find(l => l.legacyId === target.legacyId)
    assert.ok(label, 'rejecting from the sold table recorded nothing')
    assert.strictEqual(label.verdict, 'NOT_TRACKED')

    /*  And it LEAVES. Rejecting drops the listing_instrument row, and
        recentSales joins that - so the lot is gone from the table and from
        every clearing figure built on it, which is exactly what the bar above
        it promises. Not merely greyed out: the point of the control is to
        stop a wrong sale counting. */
    const after = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
    const afterTable = after.split('id="sold"')[1] || ''
    assert.ok(!afterTable.includes('value="' + target.legacyId + '"'),
        'a rejected sale is still in the table, so it is still in the numbers')
    assert.ok(!opened.repository.recentSales(100).some(r => r.legacyId === target.legacyId),
        'a rejected sale still feeds the clearing figures')

    /*  A lot marked GENUINE stays, and reads as settled with a way back -
        the other half of the control, and the one that must not vanish. */
    const keeper = opened.repository.recentSales(100)[0]
    if (keeper) {
        opened.repository.label({
            legacyId: keeper.legacyId, title: keeper.title, verdict: 'TRACKED'
        })
        const kept = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
        const keptTable = kept.split('id="sold"')[1] || ''
        assert.ok(keptTable.includes('name="undo" value="' + keeper.legacyId + '"'),
            'a sale confirmed genuine offers no way to change your mind')
    }

    opened.db.close()
})

/*
    Fifteen was the cap; the heading must now say what is really there.

    A count that is really a fetch limit is a number that quietly stops being
    true, and on this table the total IS the point - it is the size of the
    evidence every clearing figure rests on.
*/
test('the sold heading counts the sales, not the fetch', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const key = 'GB.SOV.BULLION.FULL'

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    /*  MORE THAN THE FETCH LIMIT, not merely more than the page shows.
        Below the limit the true total and the fetched count are equal, so a
        heading that prints the wrong one still looks right - which is exactly
        how a fetch limit quietly becomes a lie. 105 crosses it. */
    for (let n = 0; n < 105; n++) {
        const id = 'v1|s' + n + '|0'
        repository.saveListing({
            browseId: id, legacyId: 's' + n, title: 'Gold Sovereign ' + n,
            buyingOptions: 'AUCTION', endTime: now
        }, now)
        repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
        repository.setListingSeries(id, 'GB.SOV')
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(id, {
            endTime: now, sold: true, finalPrice: 900 + n, shipping: 0,
            bidCount: 5, saleType: 'AUCTION', censored: false, source: 'test'
        })
    }

    assert.strictEqual(repository.soldCount(), 105)

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body

    assert.ok(body.includes('What has actually sold (105)'),
        'the heading reports the fetch limit rather than the real number of sales')
    /*  100 fetched, 25 shown, so 75 behind the fold. */
    assert.ok(body.includes('Show the other 75 completed sales'),
        'the rest are not reachable behind a fold')
    /*  And it says plainly that it is not showing all of them. */
    assert.ok(body.includes('Showing the 100 most recent'),
        'the page hides that it fetched fewer than exist')

    db.close()
})

/*
    The sold count counts what the table can actually show.

    `listing_outcome WHERE sold = 1` looks like the obvious definition and is
    the wrong one: recentSales INNER JOINs listing_instrument, so a sale whose
    listing is not filed under a coin type can never appear however high the
    limit goes. Measured on the live store when this was written: 295 sold
    outcomes against 69 the table could reach. A heading promising four times
    what the page can show is worse than the fetch limit it replaced.
*/
test('the sold count excludes sales the table can never show', () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const key = 'GB.SOV.BULLION.FULL'

    const sell = (legacyId, priced) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title: 'Gold Sovereign ' + legacyId,
            buyingOptions: 'AUCTION', endTime: now
        }, now)
        repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
        if (priced) {
            repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        }
        repository.saveOutcome(id, {
            endTime: now, sold: true, finalPrice: 910, shipping: 0,
            bidCount: 3, saleType: 'AUCTION', censored: false, source: 'test'
        })
    }

    sell('priced-1', true)
    sell('priced-2', true)
    /*  Sold, but filed under no coin type - exactly the shape that made the
        live store read 295 when the table could show 69. */
    sell('unfiled-1', false)
    sell('unfiled-2', false)
    sell('unfiled-3', false)

    assert.strictEqual(repository.soldCount(), 2,
        'the count includes sales the table cannot reach')
    assert.strictEqual(repository.recentSales(100).length, 2,
        'the fixture does not reproduce the shape being tested')

    db.close()
})

/*
    Nothing on a page points at eBay's image CDN any more.

    Through the login proxy the pictures stopped arriving - blank space, no
    broken icon, and still blank in a private window, which rules out an
    extension but not Firefox's own tracking protection. Rather than keep
    diagnosing a browser we do not control, the images are served from this
    origin: a relative path is not a third-party request, so there is nothing
    left to block.
*/
test('thumbnails are served from this origin, not linked to eBay', async () => {
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, ['/?min=1', '/review', '/listings?key=GB.SOV.BULLION.FULL'])

    /*  What matters is that nothing FETCHES from there. The proxied address
        naturally contains the host inside its own query parameter, so a bare
        substring search would fail on a correct page - and would have passed
        on a broken one that merely encoded the URL differently. */
    for (const [path, page] of Object.entries(pages)) {
        const direct = page.body.match(/(?:src|url\()["'&;quot]*https:\/\/i\.ebayimg[^"')]*/i)
        assert.ok(direct === null,
            path + ' still fetches an image straight from eBay: ' + (direct || [''])[0])
    }

    /*  And they are actually there - a test that passes because no image
        rendered at all would prove nothing. */
    assert.ok(pages['/review'].body.includes('src="/img?u='),
        'no proxied image on the review queue')

    /*  Both sizes: the enlarged picture rides in a CSS custom property and
        was the easier one to forget. */
    assert.ok(pages['/review'].body.includes('--shot:url(&quot;/img?u='),
        'the enlarged picture still points off-site')

    opened.db.close()
})

/*
    A sold row says HOW it sold, and the page admits what it cannot contain.

    The owner, looking at the sold table: "I can't tell which are BIN solds
    (without best offers of course), if indeed there are any (which I think
    there are because I can see them in the ebay UI)."

    Both halves of that were fair. The column showed a bid count, which is an
    auction idea - on a Buy-It-Now it is meaningless, and an em dash there
    reads as missing data rather than as a different kind of sale. And the
    deeper answer was invisible: there are none, and there can be none yet,
    because pendingOutcomes only offers the resolver lots with an end time and
    a Good-'Til-Cancelled Buy-It-Now has none. A table that looks like a table
    of sales should say which kind it can never hold.
*/
test('a sold row says how it sold, and a Buy-It-Now says so', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const key = 'GB.SOV.BULLION.FULL'

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const sell = (legacyId, saleType, bidCount) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title: 'Gold Sovereign ' + legacyId,
            buyingOptions: saleType === 'AUCTION' ? 'AUCTION' : 'FIXED_PRICE',
            endTime: now
        }, now)
        repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
        repository.setListingSeries(id, 'GB.SOV')
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(id, {
            endTime: now, sold: true, finalPrice: 905, shipping: 0,
            bidCount, saleType, censored: false, source: 'test'
        })
    }

    sell('auction-1', 'AUCTION', 7)
    sell('bin-1', 'FIXED_PRICE', null)

    /*  A LIVE listing as well, or the coin type has no ask sample and fewer
        than the three sales a clearing figure needs - so it is dropped from
        `markets` and the whole page short-circuits to "no market yet". The
        sold table would not render at all and every assertion below would be
        testing an empty string. */
    const liveId = 'v1|live|0'
    repository.saveListing({
        browseId: liveId, legacyId: 'live', title: 'Gold Sovereign live',
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, now)
    repository.saveSnapshot(liveId, { price: 1200, shipping: 0, observedAt: now })
    repository.setListingSeries(liveId, 'GB.SOV')
    repository.saveClassification(liveId, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
    /*  Bounded at the next heading. Splitting on the anchor alone runs to the
        end of the document, so "Buy-It-Now" from a sale tab further down
        satisfied the assertion and the test passed with the feature reverted. */
    const after = body.split('id="sold"')[1] || ''
    const table = after.split('<h2')[0]

    assert.ok(table.includes('>Buy-It-Now</span>'),
        'a Buy-It-Now sale is not distinguishable from an auction')
    assert.ok(table.includes('>7</td>') || table.includes('>7<'),
        'the auction lost its bid count')

    /*  With a Buy-It-Now sale present, the "we have none" note must be gone -
        the whole point of deriving it is that it disappears by itself. */
    assert.ok(!body.includes('Every one of these is an auction'),
        'the page still claims it has no Buy-It-Now sales while showing one')

    db.close()
})

test('a page with only auction sales says so plainly', async () => {
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
    assert.ok(body.includes('Every one of these is an auction'),
        'the page does not disclose that it holds no Buy-It-Now sales')
    assert.ok(body.includes('clearing prices on this page are auction prices'),
        'the disclosure does not say what that costs the reader')
    opened.db.close()
})

/*
    A Best Offer sale, and the one number the page must refuse to print.

    COL-01 started resolving Buy-It-Now lots, and the first fifty-six threw up
    nine sales that had all gone through Best Offer. eBay does not publish
    what an accepted offer was - the listing just ends showing its asking
    price - so that figure is an UPPER bound on what changed hands and
    nothing more.

    The premium column already declined to guess. The price column did not:
    it printed the asking price under a tooltip reading "What the winner
    actually paid", which is a specific false claim about a specific coin,
    and the badge beside it said the lot had been "bought outright at the
    asking price". A confident price next to a blank premium reads as a
    display fault rather than as the admission it is.
*/
test('a Best Offer sale is never reported as a price somebody paid', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const key = 'GB.SOV.BULLION.FULL'

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const sell = (legacyId, saleType, censored) => {
        const id = 'v1|' + legacyId + '|0'
        repository.saveListing({
            browseId: id, legacyId, title: 'Gold Sovereign ' + legacyId,
            buyingOptions: 'FIXED_PRICE', endTime: now
        }, now)
        repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
        repository.setListingSeries(id, 'GB.SOV')
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(id, {
            endTime: now, sold: true, finalPrice: 905, shipping: 0, bidCount: null,
            saleType, censored, source: 'test'
        })
    }
    sell('offer-1', 'BEST_OFFER', true)

    const liveId = 'v1|live|0'
    repository.saveListing({
        browseId: liveId, legacyId: 'live', title: 'Gold Sovereign live',
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, now)
    repository.saveSnapshot(liveId, { price: 1200, shipping: 0, observedAt: now })
    repository.setListingSeries(liveId, 'GB.SOV')
    repository.saveClassification(liveId, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body
    const table = (body.split('id="sold"')[1] || '').split('<h2')[0]

    assert.ok(table.includes('at most'),
        'the asking price is presented as the price it sold for')
    assert.ok(!table.includes('What the winner actually paid'),
        'the page claims to know what an offers-allowed buyer paid')
    assert.ok(table.includes('>Offers allowed</span>'),
        'a lot that merely allowed offers is badged as an ordinary Buy-It-Now')
    assert.ok(!table.includes('Bought outright at the asking price'),
        'a lot that may have been negotiated is described as paid at the asking price')
    assert.ok(!table.includes('agreed a price privately'),
        'the page asserts a negotiation that eBay never confirmed happened')

    /*  And the page says why, once, rather than leaving a reader to work out
        what a blank premium column means. */
    assert.ok(body.includes('no exact price'),
        'the page shows ceiling-only sales without saying they are ceilings')
    assert.ok(!body.includes('Every one of these is an auction'),
        'the page claims to hold no Buy-It-Now sales while showing one')

    db.close()
})


/*
    Every judged row says which coin group the tool filed it under.

    The owner, working the review queue: "I can't see what category the coin
    has been placed in. all i've been looking for is 'is it a real x or not?'
    I haven't been checking the categorisation, so that's potential room for
    error."

    Exactly right, and the room for error is large. The group decides which
    pile of clearing prices the coin joins, and so the premium shown against
    it and the ceiling of any offer on it. Measured on the live store's own
    sold auctions, a full sovereign filed as bullion clears at +9.6% and one
    filed as a proof at +40.6%: a coin in the wrong pile is a thirty point
    error in what the tool thinks it is worth. 3,400 lots are filed this way,
    almost all off the title alone, and the row never said so.
*/
test('a review row says which coin group it was filed under', async () => {
    const opened = twoSeriesStore()
    /*  The queue defaults to one series and to the auction tab, so each coin
        is asked for where it actually lives. */
    const pages = await fetchAll(opened, ['/review', '/review?coin=US.MORGAN'])
    const body = pages['/review'].body
    const dollars = pages['/review?coin=US.MORGAN'].body

    assert.ok(body.includes('Sovereign (bullion)'),
        'the queue never says which group a sovereign was filed under')
    assert.ok(dollars.includes('Silver Dollar (common date)'),
        'the queue never says which group a dollar was filed under')

    /*  Per row, not a page-level heading: the queue mixes series, so one
        label at the top would be worse than none. */
    const badges = (body.match(/has filed this as/g) || []).length
    assert.ok(badges >= 2,
        'the group is stated once for the page, not on each row (found ' + badges + ')')
    assert.ok(!dollars.includes('Sovereign (bullion)'),
        'a sovereign group leaked onto the dollar queue')

    opened.db.close()
})

test('a group the classifier was guessing at is flagged, not stated flatly', async () => {
    /*
        Two different confidences live on a queued row and only one of them
        is about the badge.

        The review queue's own confidence says how sure the tool is that a
        HUMAN should look; the instrument row's says how sure it was of the
        group it actually filed the coin under. A row can be queued at 0.5
        for a reason that has nothing to do with the group - an odd price, a
        suspect category - while the group itself was a confident call. The
        badge hedges on the second, because that is the number attached to
        the claim it is making.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const id = 'v1|guess|0'
    repository.saveListing({
        browseId: id, legacyId: 'guess', title: 'Sovereign 1980 possibly proof',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString(),
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    /*  Filed under proof, but barely. */
    repository.saveClassification(id, [{ key: 'GB.SOV.PROOF.FULL', level: 0 }], 0.4, 'title', 0.2354, {})
    /*  Queued for a confident reason unrelated to the group. */
    repository.queueForReview(id, 'worth a look', 'GB.SOV.PROOF.FULL', 0.95)

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    assert.ok(body.includes('Sovereign (proof)'), 'the group is missing')
    assert.ok(body.includes('unsure'), 'a 40%-confidence filing is presented as settled')
    assert.ok(body.includes('40% sure'),
        'the row hedges on the queue score rather than on the filing it is describing')
    db.close()
})

test('a coin that IS counted shows the group counting it, with no guess to fall back on', async () => {
    /*
        The case that made this worth fixing, and the one every other test
        here was accidentally hiding.

        review_queue.best_guess is what the classifier PROPOSED for a lot it
        could not place. It is null for exactly the rows that WERE placed -
        so on the live queue, 82 of 83 rows carried a group and showed
        nothing, because the badge had only ever been fed best_guess. The row
        said "counted in the statistics" while refusing to say which
        statistic, which is the whole complaint: the reviewer confirms the
        coin is genuine having never seen the classification that decides
        what it is worth.

        So this row is classified and queued WITHOUT a guess, exactly as the
        real ones are.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const id = 'v1|placed|0'
    repository.saveListing({
        browseId: id, legacyId: 'placed', title: '1980 Gold Proof Sovereign boxed',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString(),
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    repository.saveClassification(id, [{ key: 'GB.SOV.PROOF.FULL', level: 0 }], 0.88, 'title', 0.2354, {})
    repository.queueForReview(id, 'worth a look', null, 0.5)

    /*  The store must hand the group over, or no amount of rendering can
        show it. */
    const queued = repository.reviewQueue(10, 'GB.SOV')
    assert.strictEqual(queued.length, 1)
    assert.strictEqual(queued[0].bestGuess, null, 'the fixture is not the real shape')
    assert.strictEqual(queued[0].instrumentKey, 'GB.SOV.PROOF.FULL',
        'the queue knows the coin is counted somewhere but not where')

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    assert.ok(body.includes('counted in the statistics'), 'the fixture is not counted at all')
    assert.ok(body.includes('Sovereign (proof)'),
        'the row says it is counted in the statistics without saying in which')
    assert.ok(!body.includes('no group'), 'a placed coin was reported as unplaced')

    db.close()
})

test('a row the tool could not place says so, rather than showing nothing', async () => {
    /*  A blank where the group goes reads as a rendering fault. An unplaced
        coin is a different job for the reviewer from a misfiled one: it is
        counted in no clearing figure at all. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const id = 'v1|nogroup|0'
    repository.saveListing({
        browseId: id, legacyId: 'nogroup', title: 'Gold coin, unclear what',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString(),
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    /*  Queued with no guess and never classified: nothing filed it anywhere. */
    repository.queueForReview(id, 'cannot place this', null, 0.1)

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    assert.ok(body.includes('no group'), 'an unplaced coin shows a blank where its group goes')
    db.close()
})

test('a confident group is stated without hedging', async () => {
    /*  The other half of the same rule: a number beside every row is noise,
        and hedging on a 0.9 call would train the eye to ignore the hedge. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const id = 'v1|sure|0'
    repository.saveListing({
        browseId: id, legacyId: 'sure', title: 'Gold Proof Sovereign 1980',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString(),
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    repository.saveClassification(id, [{ key: 'GB.SOV.PROOF.FULL', level: 0 }], 0.95, 'title', 0.2354, {})
    repository.queueForReview(id, 'worth a look', 'GB.SOV.PROOF.FULL', 0.95)

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    assert.ok(body.includes('Sovereign (proof)'), 'the group is missing')
    /*  Scoped to the badge marker. A bare substring test now also matches
        the sort control's own value, which is a different feature entirely -
        the assertion was reading a control it was never about. */
    assert.ok(!body.includes('&middot; unsure</span>'), 'a confident call was hedged anyway')
    db.close()
})


/*
    Correcting which KIND of coin something is, and having it stick.

    The owner gave 192 genuine/not-genuine verdicts with no way to see, let
    alone fix, which pool the coin had been put in - and the pool decides
    which clearing prices it is measured against. On this store's own sold
    auctions a full sovereign in the bullion pool clears at +9.6% and one in
    the proof pool at +40.6%, so a coin in the wrong pool is a thirty point
    error in what the tool thinks it is worth.

    A picker that stores a preference but leaves the coin where it was would
    be worse than none, so the assertion here is on the instrument key the
    listing ends up counted under.
*/
test('a pool you choose moves the coin, not just the label', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const id = 'v1|misfiled|0'
    repository.saveListing({
        browseId: id, legacyId: 'misfiled', title: '1980 Gold Sovereign Elizabeth II boxed',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString(),
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    repository.saveClassification(id, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.6, 'title', 0.2354, {})

    const keyOf = () => (db.prepare(
        'SELECT li.key AS k FROM listing_instrument li JOIN instrument i ON i.key = li.key ' +
        'AND i.level = 0 WHERE li.browse_id = ?').get(id) || {}).k
    assert.strictEqual(keyOf(), 'GB.SOV.BULLION.FULL', 'the fixture does not start where it should')

    /*  You look at the picture and say: that is a proof. */
    repository.label({
        legacyId: 'misfiled', title: '1980 Gold Sovereign Elizabeth II boxed',
        verdict: LEARNED.VERDICT.SOVEREIGN, denomination: 'FULL', pool: 'PROOF', series: 'GB.SOV'
    })
    require('../src/catalogue/reclassify.js').one(db, repository, 'misfiled', {})

    assert.strictEqual(keyOf(), 'GB.SOV.PROOF.FULL',
        'the coin was told it is a proof and stayed in the bullion pool')

    /*  And it is now measured against proofs, which is the point of moving it. */
    const view = MARKET.newMarketView(repository, SPOT.newSpotLookup(db, {}), {})
    assert.ok(view.forInstrument('GB.SOV.PROOF.FULL') !== null,
        'the proof pool has no market for the coin just moved into it')

    db.close()
})

test('leaving the pool picker alone changes nothing', async () => {
    /*  An untouched dropdown posts an empty string. Stored, it would read as
        a human having chosen "no pool" and would outrank the classifier with
        nothing behind it. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const id = 'v1|untouched|0'
    repository.saveListing({
        browseId: id, legacyId: 'untouched', title: '1980 Gold Proof Sovereign',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString()
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    repository.saveClassification(id, [{ key: 'GB.SOV.PROOF.FULL', level: 0 }], 0.9, 'title', 0.2354, {})

    repository.label({
        legacyId: 'untouched', title: '1980 Gold Proof Sovereign',
        verdict: LEARNED.VERDICT.SOVEREIGN, denomination: 'FULL', pool: '', series: 'GB.SOV'
    })
    require('../src/catalogue/reclassify.js').one(db, repository, 'untouched', {})

    const key = (db.prepare(
        'SELECT li.key AS k FROM listing_instrument li JOIN instrument i ON i.key = li.key ' +
        'AND i.level = 0 WHERE li.browse_id = ?').get(id) || {}).k
    assert.strictEqual(key, 'GB.SOV.PROOF.FULL',
        'an untouched dropdown overrode the classifier')
    db.close()
})


test('choosing a pool on a row carries through the form to the coin', async () => {
    /*
        The three tests above all call repository.label() directly, so none of
        them touches the wire - and the field name has to match on both sides
        or a picker sits there doing nothing. Mutating the bulk handler to
        drop the pool broke no test at all until this one existed.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const id = 'v1|wire|0'
    repository.saveListing({
        browseId: id, legacyId: 'wire', title: '1980 Gold Sovereign Elizabeth II boxed',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString()
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    repository.saveClassification(id, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.6, 'title', 0.2354, {})

    const opened = { db, repository, spotAt: SPOT.newSpotLookup(db, {}), view: MARKET.newMarketView(repository, SPOT.newSpotLookup(db, {}), {}) }
    await post(opened, '/apply', {
        genuine: 'wire', back: '/review',
        p_wire: 'PROOF', d_wire: 'FULL', q_wire: '1'
    })

    assert.strictEqual(repository.labels()[0].pool, 'PROOF',
        'the pool chosen on the row never reached the store')
    const key = (db.prepare(
        'SELECT li.key AS k FROM listing_instrument li JOIN instrument i ON i.key = li.key ' +
        'AND i.level = 0 WHERE li.browse_id = ?').get(id) || {}).k
    assert.strictEqual(key, 'GB.SOV.PROOF.FULL', 'the coin did not move')
    db.close()
})

test('an untouched pool dropdown is stored as no answer, not as an empty one', async () => {
    /*  The dropdown posts an empty string when nobody touches it. Stored as
        '', it is a value a later reader could take for a choice; the column
        exists to record judgements, and "" is not one. Checked at the store
        rather than through a key, because learned.js also treats it as
        falsy - so a key assertion passes either way and proves nothing. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    repository.label({
        legacyId: 'blank', title: 'Gold Sovereign', verdict: LEARNED.VERDICT.SOVEREIGN,
        denomination: 'FULL', pool: '', series: 'GB.SOV'
    })
    assert.strictEqual(db.prepare('SELECT pool FROM listing_label WHERE legacy_id = ?').get('blank').pool,
        null, 'an empty dropdown was stored as a decision')
    db.close()
})

test('the classifier is handed the pool a human chose', async () => {
    /*  labels() feeds the classifier's hot path. A column missing from it is
        a correction that stores and then does nothing, which is exactly how
        this failed first time round. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    repository.label({
        legacyId: 'handed', title: 'Gold Sovereign', verdict: LEARNED.VERDICT.SOVEREIGN,
        denomination: 'FULL', pool: 'GRADED', series: 'GB.SOV'
    })
    assert.strictEqual(repository.labels()[0].pool, 'GRADED',
        'the classifier is never told which pool a human chose')
    db.close()
})


/*
    Search, order and group, on every table of listings.

    The owner: "on set of data it needs to be filterable, searchable,
    sortable!" - and both working surfaces already held their rows in memory,
    so this is query parameters rather than SQL or client script. Which means
    a filtered view is a URL: bookmarkable, and returnable-to after a verdict,
    which is the half that is easy to get wrong.
*/
test('searching narrows the queue to titles holding every word', async () => {
    const opened = twoSeriesStore()
    const path = '/review?coin=GB.SOV&sale=all&q=' + encodeURIComponent('example 1')
    const body = (await fetchAll(opened, [path]))[path].body

    assert.ok(body.includes('Showing <strong>1</strong> of'),
        'the page does not say how much the search narrowed it to')
    assert.ok(body.includes('GB.SOV.BULLION.FULL example 1'), 'the matching row is missing')
    assert.ok(!body.includes('GB.SOV.BULLION.FULL example 2'),
        'a row matching only one of the two words survived')
    opened.db.close()
})

test('a search that matches nothing says so, rather than looking empty', async () => {
    /*  An empty queue and a search with no hits render identically otherwise,
        and they want opposite next actions. */
    const opened = twoSeriesStore()
    const path = '/review?coin=GB.SOV&sale=all&q=zzzznothing'
    const body = (await fetchAll(opened, [path]))[path].body
    assert.ok(body.includes('Nothing matches'), 'a fruitless search looks like an empty queue')
    opened.db.close()
})

test('a verdict returns you to the queue you were searching, not to all of it', async () => {
    /*  The same lost-parameter bug the coin tabs were written to avoid, one
        control further along: search, judge a row, and land back among 6,000. */
    const opened = twoSeriesStore()
    const path = '/review?coin=GB.SOV&sale=all&q=example&order=title'
    const body = (await fetchAll(opened, [path]))[path].body
    const back = body.match(/name="back" value="([^"]*)"/)
    assert.ok(back !== null, 'no back field on the form')
    const value = back[1].replace(/&amp;/g, '&')
    assert.ok(value.includes('q=example'), 'the search is dropped on the way back: ' + value)
    assert.ok(value.includes('order=title'), 'the sort is dropped on the way back: ' + value)
    opened.db.close()
})

test('ordering by title actually reorders the rows', async () => {
    const opened = twoSeriesStore()
    const asc = '/review?coin=GB.SOV&sale=all&order=title'
    const dear = '/review?coin=GB.SOV&sale=all&order=dearest'
    const pages = await fetchAll(opened, [asc, dear])

    const titlesIn = (body) => [...body.matchAll(/GB\.SOV\.BULLION\.FULL example (\d+)/g)]
        .map(m => m[1])
    const a = titlesIn(pages[asc].body)
    const d = titlesIn(pages[dear].body)
    assert.ok(a.length > 1 && d.length > 1, 'not enough rows to tell an order from')
    assert.notDeepStrictEqual(a, d, 'two different sorts produced the same order')
    opened.db.close()
})

test('the group filter offers only groups that are actually there', async () => {
    /*  Offering the pack's whole vocabulary would list groups selecting
        nothing, and a filter that can only empty the page is one nobody
        trusts twice. */
    const opened = twoSeriesStore()
    const path = '/review?coin=GB.SOV&sale=all'
    const body = (await fetchAll(opened, [path]))[path].body
    const picker = body.match(/<select name="group"[\s\S]*?<\/select>/)
    assert.ok(picker !== null, 'the queue offers no way to filter by group')
    assert.ok(picker[0].includes('bullion ('), 'the group present is not named properly')

    /*  Asserted on the option VALUES, not their labels. A label check reads
        whatever the fallback happens to render and passed against a picker
        carrying an extra empty group - it was testing a string that never
        appears rather than the list it was about. */
    const offered = [...picker[0].matchAll(/<option value="([A-Z_]*)"/g)]
        .map(m => m[1]).filter(v => v !== '')
    assert.deepStrictEqual(offered, ['BULLION'],
        'the picker offers groups with no rows behind them: ' + JSON.stringify(offered))
    opened.db.close()
})

test('choosing a group actually filters the rows to it', async () => {
    /*  The picker being right about which groups exist is a different claim
        from the filter working, and only one of them was tested. */
    const opened = twoSeriesStore()
    const bullion = '/review?coin=GB.SOV&sale=all&group=BULLION'
    const branch = '/review?coin=GB.SOV&sale=all&group=BRANCH'
    const pages = await fetchAll(opened, [bullion, branch])

    assert.ok(pages[bullion].body.includes('GB.SOV.BULLION.FULL example'),
        'filtering to the group the rows are in hid them')
    assert.ok(pages[bullion].body.includes('in bullion'),
        'the page does not say it is showing one group')

    /*  And a group with no rows empties the table rather than being ignored.
        A filter that silently does nothing is worse than one that shows you
        it found nothing. */
    assert.ok(!pages[branch].body.includes('GB.SOV.BULLION.FULL example'),
        'filtering to an absent group returned rows from another one')
    opened.db.close()
})

test('the drill-down carries the same strip', async () => {
    const opened = twoSeriesStore()
    const path = '/listings?key=GB.SOV.BULLION.FULL&q=example'
    const body = (await fetchAll(opened, [path]))[path].body
    assert.ok(body.includes('name="q"'), 'the drill-down cannot be searched')
    assert.ok(body.includes('name="order"'), 'the drill-down cannot be sorted')
    /*  And it keeps the key, or applying the strip would throw away the very
        thing that says which coin is being looked at. */
    assert.ok(body.includes('name="key" value="GB.SOV.BULLION.FULL"'),
        'the strip drops the instrument key')
    opened.db.close()
})
