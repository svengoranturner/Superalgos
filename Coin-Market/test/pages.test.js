'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const SPOT = require('../src/spot/spot.js')
const MARKET = require('../src/analytics/market.js')
const SERVER = require('../src/web/server.js')
const SERIES = require('../src/catalogue/series/index.js')

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
