'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const SPOT = require('../src/spot/spot.js')
const MARKET = require('../src/analytics/market.js')
const INSTRUMENTS = require('../src/catalogue/instruments.js')
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
test('both series appear on the coin types page, neither crowded out', async () => {
    /*  The per-series tables moved off the front page onto /types when the
        five reference folds became five pages. The claim is unchanged: a
        second series must not be crowded out by an established one. */
    const opened = twoSeriesStore()
    const { '/types': page } = await fetchAll(opened, ['/types'])

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
    /*  One list at a time now: near-spot, offers and sold sit behind view
        pills where they used to be stacked, so the offers panel is asked for
        by name and is the whole page rather than a slice of it. */
    const opened = twoSeriesStore()
    const path = '/?view=offers'
    const { [path]: market } = await fetchAll(opened, [path])

    const section = market.body.split('id="offers"')[1]
    assert.ok(section !== undefined, 'the offers panel is missing entirely')

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

    /*  Matching a nav that carries attributes, which it does now that it is
        a menu bar. The old pattern was anchored on a bare <nav> and stopped
        matching the moment it gained a class - and report/build.js used the
        same pattern to strip it, so the failure was not cosmetic: the whole
        bar would have travelled inside a shared report. */
    const lit = body => (body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]
        .split('<a ').filter(a => /class="[^"]*\bon\b[^"]*"/.test(a))
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
        assert.strictEqual((page.body.match(/<nav\b/g) || []).length, 1)
    }
    opened.db.close()
})

async function post (opened, path, fields) {
    const server = SERVER.start(opened, { port: 0, host: '127.0.0.1', quiet: true })
    await new Promise(resolve => server.once('listening', resolve))
    const port = server.address().port
    try {
        /*  Arrays become REPEATED keys, which is what a form with several
            ticked checkboxes actually sends. new URLSearchParams(object)
            joins them with a comma instead, so a test ticking two boxes
            posted one phrase called "a,b" and the second rule silently never
            existed. */
        const body = new URLSearchParams()
        for (const [name, value] of Object.entries(fields)) {
            if (Array.isArray(value)) { value.forEach(v => body.append(name, v)) }
            else { body.append(name, value) }
        }
        const response = await fetch('http://127.0.0.1:' + port + path, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: body.toString(),
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

    /*  One list at a time now: the front page shows near-spot, offers or sold
        behind view pills, where all three used to be stacked. The section this
        test is about is asked for by name. */
    const path = '/?min=1&view=sold'
    const body = (await fetchAll(opened, [path]))[path].body
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

    /*  On the TITLE, not on the face of the button.

        Both are the tick and the cross now, the same pair the scanner uses, so
        one gesture does not have two appearances depending which list you
        found the coin in. The series-specific wording did not go away - it
        moved into the tooltip, which is the only thing that changed and the
        only thing these assertions had to follow. The batch button keeps the
        word "selected" on its face, because it acts on everything ticked and
        must not be mistaken for the row beside it. */
    assert.ok(body.includes('title="Not a silver dollar - everything ticked"'),
        'the bulk bar does not name the coin it acts on')
    assert.ok(body.includes('title="Not a silver dollar"'),
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

    /*  On the TITLE, not on the face of the button.

        Both are the tick and the cross now, the same pair the scanner uses, so
        one gesture does not have two appearances depending which list you
        found the coin in. The series-specific wording did not go away - it
        moved into the tooltip, which is the only thing that changed and the
        only thing these assertions had to follow. The batch button keeps the
        word "selected" on its face, because it acts on everything ticked and
        must not be mistaken for the row beside it. */
    assert.ok(body.includes('title="Not a sovereign - everything ticked"'),
        'the sovereign wording regressed')
    assert.ok(body.includes('title="Not a sovereign"'),
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

    /*  One list at a time now: the front page shows near-spot, offers or sold
        behind view pills, where all three used to be stacked. The section this
        test is about is asked for by name. */
    const path = '/?min=1&view=sold'
    const body = (await fetchAll(opened, [path]))[path].body
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
    const after = (await fetchAll(opened, [path]))[path].body
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
        const kept = (await fetchAll(opened, [path]))[path].body
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
    /*  One list at a time now: the front page shows near-spot, offers or sold
        behind view pills, where all three used to be stacked. The section this
        test is about is asked for by name. */
    const path = '/?min=1&view=sold'
    const body = (await fetchAll(opened, [path]))[path].body

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
    /*  One bid as well as seven, so the plural is exercised. */
    sell('auction-2', 'AUCTION', 1)

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
    /*  One list at a time now: the front page shows near-spot, offers or sold
        behind view pills, where all three used to be stacked. The section this
        test is about is asked for by name. */
    const path = '/?min=1&view=sold'
    const body = (await fetchAll(opened, [path]))[path].body
    /*  Bounded at the next heading. Splitting on the anchor alone runs to the
        end of the document, so "Buy-It-Now" from a sale tab further down
        satisfied the assertion and the test passed with the feature reverted. */
    const after = body.split('id="sold"')[1] || ''
    const table = after.split('<h2')[0]

    /*  The words moved into the mark that replaced them. Asserted on the
        accessible label rather than on the glyph: that is what a screen
        reader is handed and what a hover reads back, so it is the part that
        has to be right. A test that matched the path data would pin the
        drawing and let the meaning rot. */
    assert.ok(table.includes('aria-label="Buy-It-Now"'),
        'a Buy-It-Now sale is not distinguishable from an auction')
    assert.ok(table.includes('aria-label="Auction"'),
        'an auction sale carries no mark of its own')
    /*  With its unit. The cell used to be a bare number, which read as data
        with no meaning beside a badge that had words - the owner could not
        tell the two apart, which is why this cell changed in the first
        place. Both forms, because `n + ' bid'` unconditionally would satisfy
        a test that only ever looked at seven. */
    assert.ok(table.includes('>7 bids<'), 'the auction lost its bid count, or its unit')
    assert.ok(table.includes('>1 bid<'), 'a single bid is reported as "1 bids"')

    /*  With a Buy-It-Now sale present, the "we have none" note must be gone -
        the whole point of deriving it is that it disappears by itself. */
    assert.ok(!body.includes('Every one of these is an auction'),
        'the page still claims it has no Buy-It-Now sales while showing one')

    db.close()
})

test('a page with only auction sales says so plainly', async () => {
    const opened = twoSeriesStore()
    /*  One list at a time now: the front page shows near-spot, offers or sold
        behind view pills, where all three used to be stacked. The section this
        test is about is asked for by name. */
    const path = '/?min=1&view=sold'
    const body = (await fetchAll(opened, [path]))[path].body
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
test('a sold row is ticked when it counts, and not when eBay withheld the price', async () => {
    /*  The tick means one thing everywhere: counted in the statistics. On a
        completed sale that is the clearing price for its coin type - so a
        censored one is the single kind of sold row without a tick, because
        eBay never published what it went for and it feeds no figure.

        Both halves, because "no tick on a censored sale" is equally satisfied
        by a table that lost the tick altogether. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const KEY = 'GB.SOV.BULLION.FULL'
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const sell = (id, censored) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: id, buyingOptions: 'FIXED_PRICE|BEST_OFFER',
            endTime: now, imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(browseId, { price: 900, shipping: 0, observedAt: now })
        repository.saveClassification(browseId, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(browseId, {
            endTime: now, sold: true, finalPrice: 900, shipping: 0, bidCount: null,
            saleType: censored ? 'BEST_OFFER' : 'FIXED_PRICE', censored, source: 'test'
        })
    }
    sell('a published sale', false)
    sell('a withheld sale', true)
    /*  A live lot so the coin type reaches `markets` and a table renders. */
    const live = 'v1|shelf|0'
    repository.saveListing({
        browseId: live, legacyId: 'shelf', title: 'on the shelf',
        buyingOptions: 'FIXED_PRICE', endTime: null,
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(live, { price: 1000, shipping: 0, observedAt: now })
    repository.saveClassification(live, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const path = '/?min=1&view=sold'
    const body = (await fetchAll(opened, [path]))[path].body
    const rowFor = (title) => {
        const at = body.indexOf('>' + title + '<')
        assert.ok(at > -1, 'row missing: ' + title)
        return body.slice(body.lastIndexOf('<tr>', at), body.indexOf('</tr>', at))
    }

    assert.match(rowFor('a published sale'), /class="tick-slot ticked"/,
        'a sale that feeds the clearing price carries no tick')
    assert.ok(!/class="tick-slot ticked"/.test(rowFor('a withheld sale')),
        'a sale whose price eBay never published is ticked as though it counted')
    db.close()
})

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
    /*  One list at a time now: the front page shows near-spot, offers or sold
        behind view pills, where all three used to be stacked. The section this
        test is about is asked for by name. */
    const path = '/?min=1&view=sold'
    const body = (await fetchAll(opened, [path]))[path].body
    const table = (body.split('id="sold"')[1] || '').split('<h2')[0]

    assert.ok(table.includes('at most'),
        'the asking price is presented as the price it sold for')
    assert.ok(!table.includes('What the winner actually paid'),
        'the page claims to know what an offers-allowed buyer paid')
    assert.ok(table.includes('aria-label="Buy-It-Now, offers allowed"'),
        'a lot that merely allowed offers is marked as an ordinary Buy-It-Now')
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

    /*  A tick now, not five words. The owner asked for the lists to agree
        and this was the example they gave: "'counted in the statistics'
        instead of the tick we use on the sold page". */
    assert.ok(body.includes('title="Counted in the statistics"'),
        'the fixture is not counted at all, or the tick has gone')
    assert.ok(!body.includes('>counted in the statistics<'),
        'the row still spells out in five words what the tick beside it already says')
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


/*
    The front page carries the strip too, and one search covers all of it.

    Three tables of different things - live auctions, lots open to an offer,
    completed sales - but the question a person has is about a coin, not
    about a table. Typing "proof" should narrow all three rather than making
    you ask three times.
*/
test('a search follows you from one view to the next', async () => {
    /*
        The front page used to stack three tables and one search narrowed all
        of them at once. It shows one at a time now, behind view pills - so
        the claim worth making is that the search is a property of the page
        rather than of the table: type it once, switch view, and it is still
        applied.

        That is also what stops the pills from quietly widening a filtered
        page back out, which would be the same lost-parameter fault the coin
        tabs were written to avoid.
    */
    const opened = twoSeriesStore()
    const nearSpot = '/?min=1&q=' + encodeURIComponent('US.MORGAN')
    const sold = '/?min=1&view=sold&q=' + encodeURIComponent('US.MORGAN')
    const soldAll = '/?min=1&view=sold'
    const pages = await fetchAll(opened, [nearSpot, sold, soldAll])

    assert.ok(pages[soldAll].body.includes('GB.SOV.BULLION.FULL example'),
        'the unfiltered sold view is missing the sovereign rows')
    assert.ok(!pages[sold].body.includes('GB.SOV.BULLION.FULL example'),
        'searching for dollars still shows sovereign rows in the sold view')

    for (const path of [nearSpot, sold]) {
        assert.ok(pages[path].body.includes('Showing rows matching'),
            'the page does not say it is filtered: ' + path)
        /*  And the box keeps what was typed, on every view, or switching
            would silently throw the search away. */
        assert.ok(pages[path].body.includes('value="US.MORGAN"'),
            'the search box forgot the term on ' + path)
    }

    /*  And the form carries the view, or pressing Apply from the sold list
        would submit you back to near-spot with your search intact and your
        place gone. */
    assert.ok(pages[sold].body.includes('name="view" value="sold"'),
        'the search form drops the view it was used on')
    opened.db.close()
})
test('the sold table can be ordered without disturbing the other panels', async () => {
    const opened = twoSeriesStore()
    const dear = '/?min=1&view=sold&order=dearest'
    const cheap = '/?min=1&view=sold&order=cheapest'
    const pages = await fetchAll(opened, [dear, cheap])

    /*  The price CELL only. Every row carries three figures - what went to
        the seller, the fee, and the total - and sweeping them all up gave a
        list whose first and last entries were different quantities from
        different rows, so a descending check compared a total against a
        hammer price and failed on correct output. */
    const pricesIn = (body) => {
        const section = (body.split('id="sold"')[1] || '').split('<h2')[0]
        return [...section.matchAll(/<strong[^>]*>£([0-9,]+\.[0-9]{2})<\/strong>/g)]
            .map(m => Number(m[1].replace(/,/g, '')))
    }
    const a = pricesIn(pages[dear].body)
    const b = pricesIn(pages[cheap].body)
    assert.ok(a.length > 1, 'not enough sold rows to tell an order from')
    assert.notDeepStrictEqual(a, b, 'dearest and cheapest produced the same order')
    assert.ok(a[0] >= a[a.length - 1], 'dearest-first is not descending')
    opened.db.close()
})

test('the front page strip keeps the sample size it arrived with', async () => {
    /*  min= decides how many sales a coin type needs before it is shown at
        all. Dropping it on search would silently widen the page underneath
        the search, which reads as the search doing something it did not. */
    const opened = twoSeriesStore()
    const path = '/?min=1&q=example'
    const body = (await fetchAll(opened, [path]))[path].body
    assert.ok(body.includes('name="min" value="1"'),
        'the strip drops the minimum sample size')
    opened.db.close()
})


test('the search narrows the opportunities panel too, not only the tables below it', async () => {
    /*
        Its own fixture, because the shared one leaves this panel empty - a
        lot only appears in it when its price is within a few percent of the
        metal in it, and the shared listings are all well above that. A test
        asserting against an empty panel proves nothing, which is exactly why
        dropping the filter here broke no test.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const soon = new Date(Date.now() + 3600000).toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 49.7, null, 'test')

    /*  Priced at roughly the value of their own metal, so both land in the
        panel: a full sovereign holds 0.2354oz (about GBP 775 here) and a
        Morgan 0.7734oz of silver (about GBP 38). */
    const near = (id, key, fineOz, price, title) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title, buyingOptions: 'AUCTION', endTime: soon,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(browseId, { price, shipping: 0, bidCount: 3, observedAt: now })
        repository.setListingSeries(browseId, key.startsWith('GB') ? 'GB.SOV' : 'US.MORGAN')
        repository.saveClassification(browseId, [{ key, level: 0 }], 0.9, 'title', fineOz, {})
    }
    near('sov1', 'GB.SOV.BULLION.FULL', 0.2354, 740, 'Gold Sovereign 1912 bullion')
    near('mor1', 'US.MORGAN.COMMON.DOLLAR', 0.7734, 36, 'Morgan Silver Dollar 1921')

    /*  One Good-'Til-Cancelled lot, purely to set the sweep clock:
        lastSweepAt() reads the newest sighting among listings with no end
        time, and the freshness gate this panel runs is measured against it.
        With only auctions in the store there is no clock, nothing is
        actionable, and the panel is empty for a reason that has nothing to
        do with what is being tested. */
    const anchor = 'v1|anchor|0'
    repository.saveListing({
        browseId: anchor, legacyId: 'anchor', title: 'Gold Sovereign shop stock',
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, now)
    repository.saveSnapshot(anchor, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(anchor, 'GB.SOV')
    repository.saveClassification(anchor, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const all = '/?min=1'
    const hunt = '/?min=1&q=morgan'
    const pages = await fetchAll(opened, [all, hunt])

    /*  The heading is the view's own title now - "Auctions at or near spot" -
        rather than a panel heading among three. */
    const countIn = (body) => {
        const m = body.match(/Auctions at or near spot \((\d+)\)/)
        return m === null ? -1 : Number(m[1])
    }
    assert.strictEqual(countIn(pages[all].body), 2, 'the fixture does not fill the panel')
    assert.strictEqual(countIn(pages[hunt].body), 1,
        'the opportunities panel ignored the search')
    assert.ok(!pages[hunt].body.includes('Gold Sovereign 1912 bullion'),
        'a row that does not match the search survived in the panel')
    db.close()
})

test('the sold table orders by when a sale closed, not when the lot appeared', async () => {
    /*  A completed sale has no firstSeen worth ordering by - what anybody
        means by "newest sale" is the one that closed most recently. Dating
        these rows by the listing's own arrival put them in an order nobody
        asked for, and every sale in the earlier fixture shared an end time,
        so no test could see it. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = Date.now()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(new Date(now).toISOString(), 'XAU', 3290, null, 'test')

    /*  Listed in one order, sold in the opposite one. */
    const days = [1, 2, 3, 4]
    days.forEach((d, i) => {
        const id = 'v1|sale' + i + '|0'
        repository.saveListing({
            browseId: id, legacyId: 'sale' + i, title: 'Gold Sovereign closing ' + d,
            buyingOptions: 'AUCTION', endTime: new Date(now - d * 86400000).toISOString()
        }, new Date(now - (10 - d) * 86400000).toISOString())
        repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: new Date(now).toISOString() })
        repository.setListingSeries(id, 'GB.SOV')
        repository.saveClassification(id, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(id, {
            endTime: new Date(now - d * 86400000).toISOString(), sold: true,
            finalPrice: 900, shipping: 0, bidCount: 5, saleType: 'AUCTION',
            censored: false, source: 'trading_getitem'
        })
    })
    const liveId = 'v1|live|0'
    repository.saveListing({
        browseId: liveId, legacyId: 'live', title: 'Gold Sovereign live',
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, new Date(now).toISOString())
    repository.saveSnapshot(liveId, { price: 1200, shipping: 0, observedAt: new Date(now).toISOString() })
    repository.setListingSeries(liveId, 'GB.SOV')
    repository.saveClassification(liveId, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const newest = '/?min=1&view=sold&order=newest'
    const oldest = '/?min=1&view=sold&order=oldest'
    const pages = await fetchAll(opened, [newest, oldest])

    const closingIn = (body) => {
        const section = (body.split('id="sold"')[1] || '').split('<h2')[0]
        return [...section.matchAll(/Gold Sovereign closing (\d)/g)].map(m => Number(m[1]))
    }
    assert.deepStrictEqual(closingIn(pages[newest].body), [1, 2, 3, 4],
        'newest-first is not ordering by when the sale closed')
    assert.deepStrictEqual(closingIn(pages[oldest].body), [4, 3, 2, 1],
        'oldest-first is not ordering by when the sale closed')
    db.close()
})

test('the review figure counts the work, not the exclusions', async () => {
    /*
        The scanner's summary strip says "Needs review". On the live store the
        whole queue is 25,560 rows, of which 20,872 are listings outside the
        chosen countries and most of the rest jewellery categories - all
        deliberately excluded and none of them work. A figure that size beside
        that label reads as a backlog nobody could clear, when the actual job
        is three orders of magnitude smaller.

        What counts is a coin the tool is still PRICING while unsure of it:
        queued, not excluded, and feeding a statistic. Those are the only rows
        whose being wrong changes a number on the page.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    const queue = (id, reason, priced) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: 'Gold Sovereign ' + id,
            buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString()
        }, now)
        repository.saveSnapshot(browseId, { price: 900, shipping: 0, observedAt: now })
        repository.setListingSeries(browseId, 'GB.SOV')
        if (priced) {
            repository.saveClassification(browseId,
                [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.5, 'title', 0.2354, {})
        }
        repository.queueForReview(browseId, reason, null, 0.5)
    }

    queue('work1', 'Portrait type ambiguous for that year', true)
    queue('work2', 'No tracked series recognises this', true)
    /*  Excluded, and priced - still not work: it feeds no statistic because
        the exclusion took it out of one. */
    queue('gone1', 'EXCLUDED: Listed outside your chosen countries (US)', true)
    queue('gone2', 'EXCLUDED: Not listed in a coin category (Rings)', false)
    /*  Uncertain but unpriced: a real question, but it is making no number
        wrong today. */
    queue('idle1', 'Portrait type ambiguous for that year', false)

    assert.strictEqual(repository.reviewAffectingCount(), 2,
        'the count includes exclusions or unpriced rows')
    db.close()
})

/*  A store with two lots priced at and under the metal in them, so the
    scanner table has something to draw. Gold is 0.2354oz at £3290 - about
    £775 - so £740 is a shade under and £700 is nearly ten per cent under. */
function scannerStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const soon = new Date(Date.now() + 3600000).toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const lot = (id, price, title) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title, buyingOptions: 'AUCTION', endTime: soon,
            itemWebUrl: 'https://www.ebay.co.uk/itm/' + id,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(browseId, { price, shipping: 0, bidCount: 3, observedAt: now })
        repository.setListingSeries(browseId, 'GB.SOV')
        repository.saveClassification(browseId,
            [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})
    }
    lot('near', 770, 'Gold Sovereign 1912 near spot')
    lot('under', 690, 'Gold Sovereign 1913 well under spot')

    /*  One endless lot to set the sweep clock, without which the freshness
        gate empties the panel for a reason unrelated to the test. */
    const anchor = 'v1|anchor|0'
    repository.saveListing({
        browseId: anchor, legacyId: 'anchor', title: 'Gold Sovereign shop stock',
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, now)
    repository.saveSnapshot(anchor, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(anchor, 'GB.SOV')
    repository.saveClassification(anchor,
        [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('the scanner draws a dense table, not the tall queue cards', async () => {
    /*  The design's whole first move: a 44px picture, one title line and one
        meta line, where the queue card ran four lines and a full set of
        verdict controls. The queue row is untouched and still used by
        /review and the drill-down, where the taller shape is right. */
    const opened = scannerStore()
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body

    assert.ok(body.includes('<table class="scan">'), 'the scanner is not a table')
    assert.ok(body.includes('Gold Sovereign 1912 near spot'), 'the rows are missing')
    /*  Seven columns, and the fourth says Spot rather than Melt - the design
        is explicit about the word. The label sits inside a link now, because
        the column is sortable, so this reads the head rather than the exact
        tag it used to be. */
    const head = (/<thead>[\s\S]*?<\/thead>/.exec(body) || [''])[0]
    assert.match(head, /<th[^>]*class="figure spot"[^>]*>[\s\S]*?Spot/,
        'the spot column is missing or renamed')
    assert.ok(!/Melt/.test(head), 'the column is called Melt')
    assert.ok(/Verdict/.test(head), 'the verdict column is missing')

    /*  And it is a column you can click, which nothing in this app was. */
    assert.match(head, /<a class="sortable[^"]*" href="[^"]+">Spot/,
        'the spot column is not sortable')
    opened.db.close()
})

/*
    THE META LINE STARTED 20px LEFT OF THE TITLE.

    The owner, on a laptop: the bids / listed / seller line "could do with being
    a bit bigger and justified in line with the title (at the moment it's
    aligned to the 'counted in the stats' tick)". Measured at 1440px before the
    fix: title text x=277, meta x=257, on every row.

    The cause was structural rather than a stray margin - the tick lived INSIDE
    .lot-title, which is a flex row, so the title text began after it while the
    meta line, a sibling, began at the container edge. So the assertion is
    structural too: the tick must not be inside the title.
*/
/*
    THE SILVER / GOLD TOGGLES.

    The owner: "grey out the option for silver / gold on the filters when that
    option isn't available based on the other filters selected - it's kind of
    confusing at the moment."

    Two things were wrong, and only one of them was the one reported. The
    toggles render on all four scanner views and were wired into two: the
    near-spot list and the ending list. On the offers list and the sold list
    they rewrote the URL and changed nothing. A count beside a control that
    does nothing would have been worse than no count, so that had to go first.
*/
test('the metal toggle filters every view it appears on', async () => {
    const opened = bothMetalsStore()
    const marker = 'US.MORGAN.COMMON.DOLLAR'
    const VIEWS = ['', 'view=offers', 'view=sold', 'view=ending']

    /*  UNFILTERED FIRST, AND THAT IS THE WHOLE GUARD.

        twoSeriesStore has silver on the scanner and none on the offers or
        sold lists - it resolves no silver sales and raises no silver offer -
        so an "absent when filtered" assertion passed there for both of the
        views this change actually fixed. Proving the silver is there before
        proving the filter removes it is what stops that happening again. */
    for (const view of VIEWS) {
        const path = '/?sale=all&band=any' + (view ? '&' + view : '')
        const body = (await fetchAll(opened, [path]))[path].body
        assert.ok(body.includes(marker),
            path + ' shows no silver at all, so filtering it out proves nothing')
    }

    for (const view of VIEWS) {
        const path = '/?sale=all&band=any&metal=XAU' + (view ? '&' + view : '')
        const body = (await fetchAll(opened, [path]))[path].body
        assert.ok(!body.includes(marker),
            path + ' still shows a silver lot with only gold selected')
    }
    opened.db.close()
})

/*  Both metals present on all four scanner views: live auctions, a live
    Best Offer lot within reach of its ceiling, and resolved sales. Four sold
    auctions per metal, because a coin type needs three before it has a
    clearing price and therefore before it can raise an offer at all. */
function bothMetalsStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const soon = new Date(Date.now() + 3600000).toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAG', 49.7, null, 'test')

    const add = (id, key, fineOz, price, options, endTime) => {
        repository.saveListing({
            browseId: 'v1|' + id + '|0', legacyId: id, title: key + ' example ' + id,
            buyingOptions: options, endTime,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot('v1|' + id + '|0', { price, shipping: 4, observedAt: now })
        repository.saveClassification('v1|' + id + '|0', [{ key, level: 0 }], 0.9, 'title', fineOz, {})
        return 'v1|' + id + '|0'
    }

    for (const coin of [
        { tag: 'au', key: 'GB.SOV.BULLION.FULL', fineOz: 0.2354, sold: 860, live: 880, offer: 940 },
        { tag: 'ag', key: 'US.MORGAN.COMMON.DOLLAR', fineOz: 0.7734, sold: 70, live: 72, offer: 78 }
    ]) {
        for (let n = 0; n < 4; n++) {
            const id = add(coin.tag + 's' + n, coin.key, coin.fineOz, coin.sold + n, 'AUCTION', now)
            repository.saveOutcome(id, {
                endTime: now, sold: true, finalPrice: coin.sold + n, shipping: 4, bidCount: 6,
                saleType: 'AUCTION', censored: false, source: 'trading_getitem'
            })
        }
        for (let n = 0; n < 2; n++) {
            add(coin.tag + 'l' + n, coin.key, coin.fineOz, coin.live + n, 'AUCTION', soon)
        }
        /*  The offer lot: Best Offer enabled and asking modestly above the
            ceiling, which is what BEST_OFFER_IN_REACH waits for. */
        add(coin.tag + 'o', coin.key, coin.fineOz, coin.offer, 'FIXED_PRICE|BEST_OFFER', null)
    }

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('a metal with nothing behind it is dimmed, and never into a dead end', async () => {
    const opened = goldOnlyStore()
    /*  The control's own opening tag, not whatever element happens to sit
        closest to the label - the radio puts its dot span between the two, so
        the nearest '<' is that dot's closing tag. */
    const control = (filters, label) => {
        const upTo = filters.split(label)[0]
        const at = upTo.lastIndexOf('class="radio')
        assert.ok(at > -1, 'no metal control before ' + label)
        return upTo.slice(upTo.lastIndexOf('<', at))
    }
    const liveLink = (filters, label) => control(filters, label).startsWith('<a class="radio')
    const filtersOf = (body) => {
        const found = body.split('class="filters"')[1]
        assert.ok(found !== undefined, 'the page rendered no filter row at all')
        return found.split('</div>')[0]
    }

    const path = '/?sale=all&band=any'
    const filters = filtersOf((await fetchAll(opened, [path]))[path].body)

    assert.match(control(filters, 'Silver'), /^<span class="radio off"/,
        'a metal with no lots behind it is still offered as a live control')
    assert.ok(filters.includes('Silver <span class="n">0</span>'),
        'the dimmed control does not say why it is dimmed')

    /*  Gold has to stay clickable in the same breath. An assertion that only
        looks for "radio off" is equally satisfied by a page that dimmed BOTH
        controls, which is not a filter row, it is a dead end. */
    assert.ok(liveLink(filters, 'Gold'),
        'gold was dimmed too, leaving no way to filter at all')

    /*  And the other dead end: narrow to the empty metal deliberately. The
        control you are standing on must not go dim under you, and there must
        still be a way out. */
    const narrowed = '/?sale=all&band=any&metal=XAG'
    const onSilver = filtersOf((await fetchAll(opened, [narrowed]))[narrowed].body)
    assert.ok(liveLink(onSilver, 'Silver'),
        'the metal you narrowed to went dim under you')
    assert.ok(liveLink(onSilver, 'Gold'),
        'no way back to the metal that has lots in it')
    opened.db.close()
})

test('the metal count is narrowed by the other filters, never by itself', async () => {
    /*  THE ASSERTION THAT SEPARATES THIS FROM THE OBVIOUS WRONG VERSION.

        Counted after the metal filter - which is the natural way to write it,
        off `priced` rather than off `opportunities` - the metal you have not
        selected always reads zero. Every other assertion in this file passes
        for that implementation, because a fixture usually has the unselected
        metal empty anyway. This one has two silver lots sitting behind a gold
        selection, and they have to be counted. */
    const opened = twoSeriesStore()
    const path = '/?sale=all&band=any&metal=XAU'
    const body = (await fetchAll(opened, [path]))[path].body
    const filters = body.split('class="filters"')[1].split('</div>')[0]

    const shown = /Silver <span class="n">(\d+)<\/span>/.exec(filters)
    assert.ok(shown !== null, 'the silver toggle carries no count')
    assert.ok(Number(shown[1]) > 0,
        'silver reads ' + shown[1] + ' while gold is selected: the count was taken after the ' +
        'metal filter, so it can never be turned on')
    opened.db.close()
})

test('the metal count describes the view you are on, exactly', async () => {
    /*  Four views draw from four populations, so one count printed on all of
        them is a fact about the scanner sitting beside the sold list.

        Asserted as exact numbers rather than as "these differ": a pair of
        different numbers is satisfied by any two implementations that happen
        to disagree, including one that crashes a count to zero. The fixture
        is built so all four are different, which is what makes the exact
        form worth having. */
    const opened = bothMetalsStore()
    const EXPECTED = [
        { view: '', gold: 3, why: 'two live auctions and one Best Offer lot' },
        { view: 'view=offers', gold: 1, why: 'one lot within reach of its ceiling' },
        { view: 'view=sold', gold: 4, why: 'four resolved sales' },
        { view: 'view=ending', gold: 2, why: 'the two auctions closing inside the window' }
    ]

    for (const { view, gold, why } of EXPECTED) {
        const path = '/?sale=all&band=any' + (view ? '&' + view : '')
        const body = (await fetchAll(opened, [path]))[path].body
        const filters = body.split('class="filters"')[1].split('</div>')[0]
        const found = /Gold <span class="n">(\d+)<\/span>/.exec(filters)
        assert.ok(found !== null, 'no gold count on ' + path)
        assert.strictEqual(Number(found[1]), gold,
            path + ' counts ' + found[1] + ' gold lots; it draws from ' + why +
            ', so it should count ' + gold)
    }
    opened.db.close()
})

/*  Gold and nothing else, so the silver toggle has genuinely nothing behind
    it - the state the owner was looking at. Half the lots fixed-price: a coin
    type reaches `markets` only with a clearing price or something on the
    shelf, and with neither the page early-returns to "nothing tracked yet"
    and has no filter row to test at all. */
function goldOnlyStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const soon = new Date(Date.now() + 3600000).toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    for (let n = 0; n < 6; n++) {
        const id = 'v1|gold' + n + '|0'
        repository.saveListing({
            browseId: id, legacyId: 'gold' + n, title: 'GB.SOV.BULLION.FULL example ' + n,
            buyingOptions: n % 2 === 0 ? 'AUCTION' : 'FIXED_PRICE',
            endTime: n % 2 === 0 ? soon : null,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(id, { price: 800 + n, shipping: 4, observedAt: now })
        repository.saveClassification(id, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }],
            0.9, 'title', 0.2354, {})
    }

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

/*
    ONE NOUN FOR ONE FACT.

    The owner asked for the format to become an icon. The reason it was worth
    doing was underneath that: the same fact had two vocabularies. The review
    queue printed `buying_options` lowercased with the pipe swapped for a
    slash - "fixed price / best offer" - and the sold table printed
    `sale_type` as "Offers allowed", for the identical listing.
*/
/*
    THE OFFERS ROW SAYS THE TYPE-WIDE FIGURE ONCE.

    The owner, on "+ £2.85 post · 25.1% over spot · 0.9% below their ask":
    how can we make it less of a wall of tiny text? The middle figure was the
    wall - measured on the live page it was the same characters on ten
    consecutive rows, because it is the premium at that coin TYPE's bid
    ceiling and the postage in it cancels exactly. It had no per-lot
    component at all.
*/
function offersStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    /*  A sale is priced against the metal price at the moment it closed, and
        the spot lookup will not carry a reading more than ninety minutes -
        so the sales close now rather than at a tidy date in the past, which
        would leave them with no premium and the coin type with no clearing
        price at all. */
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const KEY = 'GB.SOV.BULLION.FULL'
    const put = (id, price, options, endTime, outcome) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: id, buyingOptions: options, endTime,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(browseId, { price, shipping: outcome ? 0 : 3, observedAt: now })
        repository.saveClassification(browseId, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})
        if (outcome) {
            repository.saveOutcome(browseId, {
                endTime: now, sold: true, finalPrice: price, shipping: 0, bidCount: 5,
                saleType: 'AUCTION', censored: false, source: 'test'
            })
        }
    }
    /*  Four sold auctions give the type a clearing price and so a ceiling. */
    ;[860, 880, 900, 940].forEach((price, n) => put('sold' + n, price, 'AUCTION', now, true))
    /*  THREE OFFER LOTS OF ONE TYPE AT THREE DIFFERENT POSTAGES, which is
        what makes "once per type" different from "once per row". */
    put('offer one', 980, 'FIXED_PRICE|BEST_OFFER', null, false)
    put('offer two', 990, 'FIXED_PRICE|BEST_OFFER', null, false)
    put('offer three', 1000, 'FIXED_PRICE|BEST_OFFER', null, false)

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('the offer limit is stated once per coin type, not once per row', async () => {
    const opened = offersStore()
    const path = '/?min=1&view=offers'
    const body = (await fetchAll(opened, [path]))[path].body

    const rows = (body.match(/class="q"/g) || []).length
    assert.ok(rows >= 3, 'the fixture raised ' + rows + ' offers; it needs at least three of ' +
        'one type or "once per type" and "once per row" are the same number')

    const stated = (body.match(/Your limit is/g) || []).length
    assert.strictEqual(stated, 1,
        'the limit is stated ' + stated + ' times across ' + rows + ' rows of one coin type')

    /*  And it is actually there. Asserting only that it appears at most once
        is satisfied by a page that dropped it altogether, which would be the
        opposite of the fix. */
    assert.match(body, /Your limit is [^<]*over spot/,
        'the limit is not stated at all')

    /*  What the rows keep is what differs between them. */
    assert.ok((body.match(/below their ask/g) || []).length === rows,
        'the per-lot gap is no longer on every row')
    opened.db.close()
})

test('the offer limit does not move when the postage does', async () => {
    /*  The property that makes "once" correct rather than merely tidy: the
        postage cancels exactly, so the figure is the same for every lot of a
        type whatever they charge to post it. Asserted by rendering the same
        fixture twice with different postage and comparing - if the test
        recomputed the number the way the code does, it would prove nothing
        about cancellation. */
    const limitOf = async (postage) => {
        const opened = offersStore()
        opened.db.prepare('UPDATE listing_snapshot SET shipping = ? WHERE shipping > 0').run(postage)
        const path = '/?min=1&view=offers'
        const body = (await fetchAll(opened, [path]))[path].body
        const found = /Your limit is ([^<]*?) over spot/.exec(body)
        opened.db.close()
        assert.ok(found !== null, 'no limit stated at ' + postage + ' postage')
        return found[1]
    }

    assert.strictEqual(await limitOf(3), await limitOf(25),
        'the limit moved when the postage did, so it is not a property of the coin type')
})

test('the offers panel names the metal the coin is made of', async () => {
    /*  The tooltip hard-coded "the value of the gold in the coin" and fired
        on silver types too. A mixed fixture, because a single-metal one
        passes for an implementation that hard-codes the other way. */
    const opened = bothMetalsStore()
    const path = '/?min=1&view=offers&sale=all&band=any'
    const body = (await fetchAll(opened, [path]))[path].body

    const heads = body.split('class="offer-head"').slice(1)
    assert.ok(heads.length >= 2, 'the fixture raised offers on only one metal')

    const gold = heads.find(h => h.includes('Sovereign'))
    const silver = heads.find(h => h.includes('Dollar'))
    assert.ok(gold !== undefined && silver !== undefined, 'one of the two metals raised no offer')
    assert.ok(gold.includes('the gold in the coin'), 'a gold coin is not described as gold')
    assert.ok(silver.includes('the silver in the coin'),
        'a silver coin is described as gold, which is what the hard-coded wording did')
    opened.db.close()
})

test('the queue and the sold table say the same thing about the same listing', async () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const KEY = 'GB.SOV.BULLION.FULL'
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    /*  One listing, offers enabled, that went on to sell through an offer -
        so the queue reads it off buying_options and the sold table off
        sale_type, which is exactly where the two vocabularies used to part
        company. */
    const id = 'v1|both|0'
    repository.saveListing({
        browseId: id, legacyId: 'both', title: 'Gold Sovereign both ways',
        buyingOptions: 'FIXED_PRICE|BEST_OFFER', endTime: null,
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(id, { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries(id, 'GB.SOV')
    repository.saveClassification(id, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})
    repository.queueForReview(id, 'worth a look', KEY, 0.5)
    repository.saveOutcome(id, {
        endTime: now, sold: true, finalPrice: 900, shipping: 0, bidCount: null,
        saleType: 'BEST_OFFER', censored: true, source: 'test'
    })
    /*  A live lot too, or the coin type has no ask sample and no clearing
        price and the page short-circuits before rendering a table at all. */
    const live = 'v1|shelf|0'
    repository.saveListing({
        browseId: live, legacyId: 'shelf', title: 'Gold Sovereign on the shelf',
        buyingOptions: 'FIXED_PRICE', endTime: null,
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(live, { price: 1000, shipping: 0, observedAt: now })
    repository.setListingSeries(live, 'GB.SOV')
    repository.saveClassification(live, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }

    const paths = ['/review?sale=all', '/?min=1&view=sold']
    const pages = await fetchAll(opened, paths)
    const labelIn = (body, where) => {
        const found = /aria-label="([^"]*)"/.exec(body)
        assert.ok(found !== null, 'no format mark on ' + where)
        return found[1]
    }

    const queue = pages['/review?sale=all'].body.split('<tbody>')[1]
    const sold = pages['/?min=1&view=sold'].body.split('id="sold"')[1].split('<h2')[0]

    assert.strictEqual(labelIn(queue, 'the review queue'), 'Buy-It-Now, offers allowed',
        'the queue does not name the format the way the sold table does')
    assert.strictEqual(labelIn(sold, 'the sold table'), 'Buy-It-Now, offers allowed',
        'the sold table does not name the format the way the queue does')

    /*  Equality alone would be satisfied by both returning nothing, which is
        why each is asserted against the literal above. And the enum must be
        gone from both: it is the database's words, not anybody's. */
    for (const [path, page] of Object.entries(pages)) {
        assert.ok(!page.body.includes('fixed price / best offer'),
            path + ' still prints the raw buying-options enum')
    }
    db.close()
})

test('a format mark is not a silent one', async () => {
    /*  These replace words rather than decorating them, so hiding them from
        the accessibility tree deletes the fact instead of de-duplicating it.
        Scoped to the format marks: RENDER.icon emits aria-hidden SVGs all
        over the page and legitimately so, and a page-wide assertion would
        either fail for the wrong reason or be weakened until it proved
        nothing. */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/review?sale=all']))['/review?sale=all'].body

    const marks = body.split('<span class="fmt"').slice(1).map(part => part.split('</span>')[0])
    assert.ok(marks.length > 0, 'no format marks on the page at all')
    for (const mark of marks) {
        assert.match(mark, /aria-label="[^"]+"/, 'a format mark carries no label')
        assert.match(mark, /<title>[^<]+<\/title>/, 'a format mark carries no title to hover')
        assert.ok(!mark.includes('aria-hidden'),
            'a format mark is hidden from a screen reader, which deletes the fact it replaced')
    }
    opened.db.close()
})

test('an icon nobody defined is loud, not invisible', () => {
    /*  ICON[name] for an unknown name used to yield d="undefined", which
        draws nothing and looks exactly like a mark that is simply too faint.
        Adding three names at once is when that bites. */
    const RENDER = require('../src/web/render.js')
    assert.throws(() => RENDER.icon('gavel-with-a-typo'), /unknown icon/)
    assert.ok(RENDER.icon('gavel').includes('<path'), 'the gavel is not defined')
})

test('the tick sits beside the title, not inside it', async () => {
    const opened = scannerStore()
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body

    const lotText = body.split('<div class="lot-text">')[1]
    assert.ok(lotText !== undefined, 'no lot cell rendered')
    const slot = lotText.split('<div class="lot-title">')[0]

    assert.match(slot, /class="tick-slot/,
        'the tick slot is not before the title; the meta line cannot line up with it')
    /*  And the title itself holds nothing but the link. A tick still inside it
        reproduces the exact offset the owner reported. */
    const title = lotText.split('<div class="lot-title">')[1].split('</div>')[0]
    assert.ok(!title.includes('ticked'),
        'the tick is still inside the title, which is what pushed the text 20px right')
    opened.db.close()
})

test('every row reserves the gutter, whether it has a tick or not', async () => {
    /*  If a row skipped the slot its title would sit 20px left of its
        neighbours', which is the same misalignment this whole change is
        about, one column over. Asserted across every row rather than on one:
        the invariant is that the slot is always emitted, and a single row
        cannot tell "always" from "this time". */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    const rows = body.split('<tbody>')[1].split('</tr>').filter(r => r.includes('lot-text'))
    assert.ok(rows.length >= 2, 'only ' + rows.length + ' rows; "every" needs more than one')

    for (const row of rows) {
        const before = row.split('<div class="lot-title">')[0]
        assert.ok(before.includes('class="tick-slot'),
            'a row emitted no tick slot, so its title starts 20px left of its neighbours')
        /*  And the tick is never back inside the title, which is what made
            the two lines disagree in the first place. */
        const title = row.split('<div class="lot-title">')[1].split('</div>')[0]
        assert.ok(!title.includes('ticked'), 'the tick is inside the title again')
    }
    opened.db.close()
})

test('a coin type with no completed sales is left uncoloured, and says why', async () => {
    const opened = scannerStore()
    const body = (await fetchAll(opened, ['/?min=1']))['/?min=1'].body

    const rowFor = (title) => {
        const at = body.indexOf(title)
        assert.ok(at > -1, 'row missing: ' + title)
        return body.slice(body.lastIndexOf('<tr>', at), body.indexOf('</tr>', at))
    }
    /*  Eleven per cent under spot, which the old rule painted. With no sales
        on record the tool cannot know whether that is cheap for this coin. */
    const deep = rowFor('well under spot')
    assert.ok(!/class="chip (cheap|dear)"/.test(deep),
        'a coin type with no sales behind it was still coloured')
    assert.match(deep, /completed sales? of this kind on record/,
        'the chip does not say why it is uncoloured')
    opened.db.close()
})

/*  Two coin types, priced decades apart, and the SAME lot price sitting in
    opposite quarters of each. Bullion sells around a tenth over its metal
    here and proofs around three quarters over, which is roughly the real
    spread between them.

    Fixed-price throughout: a live auction's band is judged on where the bid is
    heading rather than where it is, and that is a separate question with its
    own test below. This one is only about whose distribution is used. */
function bandedStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const add = (id, key, price, options, endTime) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: id, buyingOptions: options, endTime,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(browseId, { price, shipping: 0, observedAt: now })
        repository.saveClassification(browseId, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        return browseId
    }
    const sale = (id, key, price, saleType, censored) => {
        const browseId = add(id, key, price, 'FIXED_PRICE', null)
        repository.saveOutcome(browseId, {
            endTime: now, sold: true, finalPrice: price, shipping: 0, bidCount: null,
            saleType, censored, source: 'trading_getitem'
        })
    }

    /*  Metal is 0.2354 oz at GBP 3,290 = GBP 774.55. */
    const BULLION = 'GB.SOV.BULLION.FULL'
    const PROOF = 'GB.SOV.PROOF.FULL'
    const prices = { bullion: [810, 840, 870, 930], proof: [1250, 1290, 1330, 1400] }
    prices.bullion.forEach((p, n) => sale('bs' + n, BULLION, p, 'FIXED_PRICE', false))
    prices.proof.forEach((p, n) => sale('ps' + n, PROOF, p, 'FIXED_PRICE', false))

    add('cheap bullion', BULLION, 700, 'FIXED_PRICE', null)
    add('ordinary bullion', BULLION, 850, 'FIXED_PRICE', null)
    /*  THE PAIR THAT MATTERS: the same price on both types. */
    add('dear bullion', BULLION, 1120, 'FIXED_PRICE', null)
    add('cheap proof', PROOF, 1120, 'FIXED_PRICE', null)

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

function chipRow (body, title) {
    const at = body.indexOf('>' + title + '<')
    assert.ok(at > -1, 'row missing: ' + title)
    return body.slice(body.lastIndexOf('<tr>', at), body.indexOf('</tr>', at))
}
function chipClass (row) {
    const found = /<span class="chip([^"]*)"/.exec(row)
    assert.ok(found !== null, 'no chip in the row at all')
    return found[1].trim()
}

test('the chip bands against the coin type, not against a threshold', async () => {
    const opened = bandedStore()
    const path = '/?min=1&sale=bin&band=any'
    const body = (await fetchAll(opened, [path]))[path].body

    assert.strictEqual(chipClass(chipRow(body, 'cheap bullion')), 'cheap',
        'a lot below everything this type has sold for is not marked cheap')
    assert.strictEqual(chipClass(chipRow(body, 'ordinary bullion')), '',
        'an ordinary price for this type was coloured')
    assert.strictEqual(chipClass(chipRow(body, 'dear bullion')), 'dear',
        'a lot above everything this type has sold for is not marked dear')

    /*  THE ASSERTION THE WHOLE TEST IS FOR.

        'dear bullion' and 'cheap proof' are the same price, the same metal
        and the same weight, so they carry the identical premium over spot -
        which is what the chip prints on both. Any rule that colours from a
        threshold on that number, however it is tuned, must give them the same
        verdict. Only a rule that asks what each COIN TYPE goes for can call
        one dear and the other cheap. */
    assert.strictEqual(chipClass(chipRow(body, 'cheap proof')), 'cheap',
        'the same price that is dear for a bullion sovereign is not cheap for a proof, so the ' +
        'colour is coming from a threshold on the premium rather than from the coin type')
    opened.db.close()
})

test('a live auction is not called cheap on a bid that has not finished rising', async () => {
    /*  The chip prints a current bid; the distribution is finished prices.
        Measured on the live store, 82 of the 96 auctions a naive comparison
        would paint green end more than a day out - so green would mean
        "nobody has bid yet". UPLIFT.project answers that, and returns null
        rather than guessing when it has not learned the stretch of clock -
        which is the state this fixture is in, with no snapshot history.

        So: no green. Red still holds, because a bid already past the dearest
        quarter only rises. */
    const opened = bandedStore()
    const soon = new Date(Date.now() + 3600000).toISOString()

    /*  THE TYPE NEEDS AN AUCTION DISTRIBUTION, or this test proves nothing.

        Without one the band is withheld a step earlier - no sample, no
        verdict - and the projection guard below is never reached at all. The
        first version of this test passed for exactly that reason, and the
        mutation that removes the guard survived it. */
    const stamp = new Date().toISOString()
    ;[820, 850, 880, 940].forEach((price, n) => {
        const id = 'v1|as' + n + '|0'
        opened.repository.saveListing({
            browseId: id, legacyId: 'as' + n, title: 'auction sale ' + n,
            buyingOptions: 'AUCTION', endTime: stamp,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, stamp)
        opened.repository.saveSnapshot(id, { price, shipping: 0, observedAt: stamp })
        opened.repository.saveClassification(id,
            [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})
        opened.repository.saveOutcome(id, {
            endTime: stamp, sold: true, finalPrice: price, shipping: 0, bidCount: 5,
            saleType: 'AUCTION', censored: false, source: 'trading_getitem'
        })
    })

    opened.repository.saveListing({
        browseId: 'v1|young|0', legacyId: 'young bullion', title: 'young bullion',
        buyingOptions: 'AUCTION', endTime: soon,
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, new Date().toISOString())
    opened.repository.saveSnapshot('v1|young|0',
        { price: 700, shipping: 0, observedAt: new Date().toISOString() })
    opened.repository.saveClassification('v1|young|0',
        [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})

    const path = '/?min=1&sale=auction&band=any'
    const body = (await fetchAll(opened, [path]))[path].body
    const row = chipRow(body, 'young bullion')

    /*  The type HAS an auction band - an auction lot above it is still
        painted dear - so the green being withheld below is the projection
        guard doing it, not a missing sample. */
    opened.repository.saveListing({
        browseId: 'v1|dearauction|0', legacyId: 'dear auction', title: 'dear auction',
        buyingOptions: 'AUCTION', endTime: soon,
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, new Date().toISOString())
    opened.repository.saveSnapshot('v1|dearauction|0',
        { price: 1400, shipping: 0, observedAt: new Date().toISOString() })
    opened.repository.saveClassification('v1|dearauction|0',
        [{ key: 'GB.SOV.BULLION.FULL', level: 0 }], 0.9, 'title', 0.2354, {})

    const again = (await fetchAll(opened, [path]))[path].body
    assert.strictEqual(chipClass(chipRow(again, 'dear auction')), 'dear',
        'this coin type has no auction band at all, so withholding green below proves nothing')

    assert.strictEqual(chipClass(row), '',
        'an auction bid below the cheap quarter was called cheap without any idea where it ' +
        'will finish')

    /*  And the same fixture DOES paint a fixed-price lot at the same price
        green, or this passes for an implementation where green never works. */
    const shelf = '/?min=1&sale=bin&band=any'
    const shelfBody = (await fetchAll(opened, [shelf]))[shelf].body
    assert.strictEqual(chipClass(chipRow(shelfBody, 'cheap bullion')), 'cheap',
        'nothing is being coloured cheap at all, so the assertion above proves nothing')
    opened.db.close()
})

test('the projection decides the verdict, not the bid it started from', async () => {
    /*  THE ASSERTION THAT PROVES THE PROJECTION IS DOING WORK.

        Every other test here is satisfied by an implementation that computes
        the expected finish and then bands on the current bid anyway, because
        in those fixtures the curve has learned nothing and the projection is
        withheld before it can matter.

        Here it has learned: five resolved auctions, each seen with half an
        hour to run at a price well under what it went on to fetch, so the
        tool's own record says a lot at this stage roughly doubles. The live
        lot's bid is far below the cheap quarter and its projected finish is
        far above it. One number says cheap, the other says ordinary, and the
        chip has to follow the second.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    /*  Two readings, and the earlier one is not optional: a sale is priced
        against the metal price at the moment it CLOSED, so an outcome dated
        yesterday against a spot table that starts today gets no premium at
        all and the coin type reads as having no sales. */
    const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString()
    for (const at of [daysAgo(3), now]) {
        db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
            .run(at, 'XAU', 3290, null, 'test')
    }

    const KEY = 'GB.SOV.BULLION.FULL'
    const HALF_HOUR = new Date(Date.now() + 1800000).toISOString()

    const auctionSale = (id, key, closed, snapshotPrice, finalPrice, seenSecondsOut) => {
        const out = seenSecondsOut === undefined ? 1800 : seenSecondsOut
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: id, buyingOptions: 'AUCTION', endTime: closed,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        /*  Seen with half an hour left, which is the bucket the live lot below
            will fall in. seconds_to_end is derived from endTime, so the
            snapshot has to carry it. */
        repository.saveSnapshot(browseId, {
            price: snapshotPrice,
            shipping: 0,
            observedAt: new Date(new Date(closed).getTime() - out * 1000).toISOString(),
            endTime: closed
        })
        repository.saveClassification(browseId, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(browseId, {
            endTime: closed, sold: true, finalPrice, shipping: 0, bidCount: 8,
            saleType: 'AUCTION', censored: false, source: 'trading_getitem'
        })
    }

    /*  The band for this type: four sales between about +8% and +24% over
        its metal, which is GBP 774.55. */
    const closed = new Date(Date.now() - 86400000).toISOString()
    ;[840, 870, 900, 960].forEach((price, n) =>
        auctionSale('band' + n, KEY, closed, price, price))

    /*  And the curve: five OTHER auctions, filed elsewhere so they do not
        move the band, each roughly doubling in its last half hour. The curve
        is built across every auction rather than per coin type, so these
        teach it without touching the distribution above. Five, because
        buildCurve wants five distinct auctions in a bucket before it will
        speak. */
    for (let n = 0; n < 5; n++) {
        auctionSale('rise' + n, 'GB.SOV.UNATTRIBUTED.FULL', closed, 480 + n, 940 + n, 1800)
    }

    /*  AND A SECOND BUCKET, TAUGHT THE OPPOSITE.

        With only one stretch of the clock in the curve, reading the wrong one
        is indistinguishable from reading the right one - a projection that
        always asked for the final minute would be withheld for want of data
        and the row would come out the same way by accident. So the last
        minute is taught too, and taught that a lot there barely moves: five
        auctions seen thirty seconds out at very nearly what they fetched.

        The live lot below has half an hour left. Read correctly it roughly
        doubles; read as though it were closing it hardly moves and stays in
        the cheap quarter. One fixture, two answers, and only one of them can
        be right. */
    for (let n = 0; n < 5; n++) {
        auctionSale('settled' + n, 'GB.SOV.UNATTRIBUTED.FULL', closed, 900 + n, 906 + n, 30)
    }

    /*  Bid at 620 with half an hour left. Against its metal that is about 18%
        UNDER - comfortably inside the cheap quarter. Doubled, it finishes far
        above the dear end. */
    const live = 'v1|rising|0'
    repository.saveListing({
        browseId: live, legacyId: 'rising lot', title: 'rising lot',
        buyingOptions: 'AUCTION', endTime: HALF_HOUR,
        imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
    }, now)
    repository.saveSnapshot(live, { price: 620, shipping: 0, observedAt: now, endTime: HALF_HOUR })
    repository.saveClassification(live, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }

    /*  The curve has to have learned this bucket, or the projection is
        withheld and the test is back to proving nothing. */
    const curve = opened.view.upliftCurve()
    assert.ok(curve.T_1H !== undefined && curve.T_1H.sufficient,
        'the fixture taught the curve nothing about this stretch of the clock')
    assert.ok(curve.T_60S !== undefined && curve.T_60S.sufficient,
        'the fixture taught the curve nothing about the final minute, so reading the wrong ' +
        'bucket would be indistinguishable from reading the right one')
    assert.ok(curve.T_1H.median > curve.T_60S.median * 1.5,
        'the two buckets are too close to tell apart: ' + curve.T_60S.median + ' vs ' +
        curve.T_1H.median)

    const path = '/?min=1&sale=auction&band=any'
    const body = (await fetchAll(opened, [path]))[path].body
    const row = chipRow(body, 'rising lot')

    /*  The printed number is unchanged and still says the bid is under spot -
        the owner asked for the number to stay put. Only the colour follows
        the projection. */
    assert.match(row, /class="chip[^"]*"[^>]*>-\d/,
        'the chip no longer prints the bid as under spot')
    /*  Not merely uncoloured - DEAR. The projection answers both directions,
        so a bid that reads as a bargain while heading past the dearest
        quarter is called what it will be rather than what it is. Nothing
        about the current bid could produce this verdict: it is 18% UNDER
        spot, the cheapest thing on the page. */
    assert.strictEqual(chipClass(row), 'dear',
        'a bid the tool\'s own record says will roughly double before the hammer was not ' +
        'called dear, so the projection is not deciding the verdict')
    db.close()
})

test('a price eBay withheld never makes a lot look cheap', async () => {
    /*  A Buy-It-Now lot whose only sales on record went through Best Offer:
        eBay publishes the asking price, not what was accepted, so every
        quantile is a ceiling. Above a ceiling is definitely above and red
        holds; below one is not necessarily below, so green is withheld. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const KEY = 'GB.SOV.BULLION.FULL'
    const add = (id, price, outcome) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: id, buyingOptions: 'FIXED_PRICE|BEST_OFFER',
            endTime: null, imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(browseId, { price, shipping: 0, observedAt: now })
        repository.saveClassification(browseId, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})
        if (outcome) {
            repository.saveOutcome(browseId, {
                endTime: now, sold: true, finalPrice: price, shipping: 0, bidCount: null,
                saleType: 'BEST_OFFER', censored: true, source: 'trading_getitem'
            })
        }
    }
    for (const [n, price] of [[0, 900], [1, 940], [2, 980], [3, 1040]]) { add('withheld' + n, price, true) }
    add('below the ceiling', 700, false)
    add('above the ceiling', 1400, false)

    const spotAt = SPOT.newSpotLookup(db, {})
    const opened = { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
    const path = '/?min=1&sale=bin&band=any'
    const body = (await fetchAll(opened, [path]))[path].body

    assert.strictEqual(chipClass(chipRow(body, 'below the ceiling')), '',
        'a lot was called cheap against prices eBay never published')
    assert.strictEqual(chipClass(chipRow(body, 'above the ceiling')), 'dear',
        'red was withheld too - above a ceiling IS above, and dropping that throws away the ' +
        'half of the comparison that still holds')
    db.close()
})

test('a view nobody offers falls back rather than falling over', async () => {
    /*  ?view= is in the URL, so it is whatever somebody typed or whatever a
        stale link carries. An unrecognised value used to index a table of
        titles and destructure undefined, which is a 500 on the front page -
        the one page that must always render. */
    const opened = scannerStore()
    const bad = ['/?view=nonsense', '/?view=', '/?view=__proto__', '/?view=constructor']
    /*  A repeated parameter is not malformed: URLSearchParams hands back the
        first value, so this asks for the sold list and gets it. Worth stating,
        because it is the one of these that should NOT fall back. */
    const repeated = '/?view=sold&view=nope'
    const pages = await fetchAll(opened, bad.concat([repeated]))

    for (const path of bad) {
        assert.strictEqual(pages[path].status, 200, path + ' did not render')
        assert.ok(!/TypeError|ReferenceError|is not a function/.test(pages[path].body),
            path + ' rendered an error')
        assert.ok(pages[path].body.includes('Auctions at or near spot'),
            path + ' did not fall back to the near-spot list')
    }
    assert.strictEqual(pages[repeated].status, 200)
    assert.ok(pages[repeated].body.includes('What has actually sold'),
        'a repeated parameter should take the first value, not fall back')
    opened.db.close()
})

/*
    The reference pages.

    Five folds used to sit on the front page under "The evidence behind these",
    each with a summary written as a sentence and a second sentence explaining
    the first - "How much auctions rise before the hammer / why an alert can
    fire while you can still act". The owner's verdict, verbatim: "it's the
    curse of AI putting grossly long winded titles and explanations in a UI."

    They are pages now, with names. The explanation moved inside them, where
    somebody who opened the page is asking for it.
*/
const REFERENCE = [
    ['/premiums', 'Premiums'],
    ['/types', 'Coin types'],
    ['/composition', 'Composition'],
    ['/uplift', 'Late bidding'],
    ['/gaps', 'Gaps']
]

test('each reference page exists and is called what it is', async () => {
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, REFERENCE.map(([path]) => path))

    for (const [path, title] of REFERENCE) {
        assert.strictEqual(pages[path].status, 200, path + ' does not render')
        assert.ok(pages[path].body.includes('<h1>' + title + '</h1>'),
            path + ' is not headed "' + title + '"')
        assert.ok(!/TypeError|ReferenceError|is not a function/.test(pages[path].body),
            path + ' rendered an error')
    }
    opened.db.close()
})

test('a reference title is a name, not a sentence', async () => {
    /*
        The rule the old summaries broke. A nav label and a page heading are
        read at a glance and have to survive being one item in a menu of four -
        so: no clause explaining the title, no verb, and short enough to sit in
        a dropdown.

        Asserted rather than described, because prose in a UI grows back.
    */
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, REFERENCE.map(([path]) => path))

    for (const [path, title] of REFERENCE) {
        assert.ok(title.split(/\s+/).length <= 2,
            title + ' is ' + title.split(/\s+/).length + ' words; a label is one or two')
        assert.ok(!/[,;:—-]/.test(title), title + ' carries a clause')

        /*  And the old sentence-shaped summaries are gone from the app
            entirely, not merely moved. */
        assert.ok(!pages[path].body.includes('why an alert can fire while you can still act'),
            'the explanation is still being used as a title on ' + path)
    }
    opened.db.close()
})

test('the front page no longer carries the evidence folds', async () => {
    /*  They were five collapsed <details> under a sixth heading, which is a
        page pretending to be a section. */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/']))['/'].body

    assert.ok(!body.includes('The evidence behind these'),
        'the fold stack is still on the scanner')
    assert.ok(!body.includes('How much auctions rise before the hammer'),
        'the long-winded summaries are still on the scanner')
    opened.db.close()
})

test('every reference page is reachable from the menu bar', async () => {
    /*  A page nothing links to is a page nobody finds. */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/']))['/'].body
    const nav = (body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]

    for (const [path, title] of REFERENCE) {
        assert.ok(nav.includes('href="' + path + '"'), path + ' is not in the menu bar')
        assert.ok(nav.includes('>' + title + '<'), title + ' is not the label used for it')
    }
    opened.db.close()
})

test('a reference page costs one assembly, not the scanner as well', async () => {
    /*  They are built from the same tracked-market data the scanner uses, and
        they return before it prices every live auction and evaluates every
        offer. Checked by what is NOT on the page: no summary strip, no scan
        table.

        /types is the one to watch, because it grew a filter row of its own
        and a filter row is what the scanner's work is FOR. It reads the same
        four parameters from the same url and applies them to tracked types
        rather than to live listings, so having one proves nothing about
        whether the pipeline ran - which is why the assertions below are about
        the pipeline's output and not about the controls. */
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, ['/gaps', '/types'])

    for (const [path, page] of Object.entries(pages)) {
        assert.ok(!page.body.includes('class="summary"'), path + ' built the summary strip')
        assert.ok(!page.body.includes('<table class="scan">'), path + ' built the scan table')
        assert.ok(!page.body.includes('id="offers"'), path + ' built the offers panel')
    }
    assert.ok(!pages['/gaps'].body.includes('class="filters"'),
        '/gaps has no filters and should not have grown any')
    opened.db.close()
})

/*
    THE REVIEW QUEUE AS A TABLE.

    This reverses a decision the code recorded a reason for: the queue was a
    list because an 84-character eBay title pushed a table sideways on a
    phone. The scanner met the same wall and answered it by stacking its rows
    under 620px rather than by giving up the table, and this reuses that
    stylesheet - so the assertions below are about the table existing on a
    desktop AND about the row keeping everything the list showed.
*/
test('the review queue is a table you can sort by its headers', async () => {
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    assert.ok(body.includes('<table class="scan queue">'),
        'the queue is not a table')
    assert.ok(body.includes('class="sortable"'), 'the queue table has no clickable column')

    /*  And the ordering in force is marked, or the header is a link that
        tells you nothing about where you are. Asked for by name, because the
        default ordering - least certain first - deliberately has no column:
        it ranks rows by how little the classifier trusted itself, which is
        not a field anybody would look up. */
    const dear = (await fetchAll(opened, ['/review?order=dearest']))['/review?order=dearest'].body
    assert.ok(dear.includes('class="sortable on"'),
        'no column is marked as the one the table is ordered by')

    /*  Every header link has to carry the coin and the sale filter, or
        ordering a column drops you into a different queue - the exact
        lost-parameter bug this page is written against. */
    const heads = body.split('<thead>')[1].split('</thead>')[0]
    const links = heads.match(/href="([^"]+)"/g) || []
    assert.ok(links.length >= 4, 'only ' + links.length + ' sortable columns')
    for (const link of links) {
        assert.ok(link.includes('coin=') && link.includes('sale='),
            'a column link drops the queue you are in: ' + link)
    }
    opened.db.close()
})

test('a queue column reorders the queue', async () => {
    const opened = twoSeriesStore()
    const paths = ['/review?sale=all&order=dearest', '/review?sale=all&order=cheapest']
    const pages = await fetchAll(opened, paths)

    const first = (body) => {
        const rows = body.split('<tbody>')[1]
        return rows.split('</tr>')[0].replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    }
    assert.notStrictEqual(first(pages[paths[0]].body), first(pages[paths[1]].body),
        'dearest-first and cheapest-first opened with the same row')
    opened.db.close()
})

test('the queue table keeps everything the list showed', async () => {
    /*  A table is a rearrangement, not a reduction. The row still has to
        carry the tick, the thumbnail, the pickers that say what the coin is,
        and both verdict buttons - dropping any of them to make the columns
        fit would be losing the page's whole job to its layout. */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/review']))['/review'].body
    const row = body.split('<tbody>')[1].split('</tr>')[0]

    assert.ok(row.includes('name="pick"'), 'no tick box: a bulk decision you cannot make')
    assert.ok(row.includes('<img'), 'no photograph')
    assert.ok(/name="p_[^"]+"/.test(row), 'no kind picker')
    assert.ok(/name="d_[^"]+"/.test(row), 'no denomination picker')
    assert.ok(/name="q_[^"]+"/.test(row), 'no quantity box')
    assert.ok(row.includes('name="genuine"') && row.includes('name="reject"'),
        'a row you can see is a row you cannot judge')
    assert.ok(row.includes('has filed this as'),
        'the row no longer says which group the coin was filed under')
    opened.db.close()
})

test('the three sections survive the table, each with its own form', async () => {
    /*  They are the page's argument - what is making a number wrong right
        now, what is merely uncertain, what was dropped on purpose - and each
        is its own form so a bulk decision cannot reach across a boundary the
        reviewer was not looking at. */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    for (const heading of ['Making a number wrong right now', 'Uncertain, but not being priced',
        'Deliberately excluded']) {
        assert.ok(body.includes(heading), 'the "' + heading + '" section is gone')
    }
    const tables = (body.match(/<table class="scan queue">/g) || []).length
    const forms = (body.match(/<form method="post" action="\/apply">/g) || []).length
    assert.strictEqual(forms, tables,
        tables + ' tables inside ' + forms + ' forms: a section is sharing another\'s')
    opened.db.close()
})

/*
    THE COIN TYPES PAGE.

    Was two tables, one per series, with no controls and no orderable column.
    The owner asked for one table with the scanner's filtering on it, and for
    the clearing figures to follow a format filter.
*/
test('the coin types page is one table, with the series as a column', async () => {
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/types']))['/types'].body

    const tables = (body.match(/<table/g) || []).length
    assert.strictEqual(tables, 1, 'the types page should be one table, not ' + tables)

    /*  UI-12 again, and it still has to hold: a second series must be on the
        page. It is a column now rather than a heading, so it is checked
        inside a cell rather than anywhere in the html - a series name in a
        <select> would pass the old check while the table showed neither. */
    const rows = body.split('<tbody>')[1]
    assert.ok(rows.includes('<td>British Gold Sovereigns</td>'), 'no sovereign row')
    assert.ok(/<td>Morgan[^<]*<\/td>/.test(rows), 'the second series has no row')
    opened.db.close()
})

/*
    THE CAP THAT MADE THE FILTER A LIE.

    seriesBlocks caps each series at PER_SERIES = 40 so the pages built on it
    pay for a bounded set. /types was built on the same list, and its first
    sentence is "every type this tool tracks" - on the live store, 80 of 746.

    The display half of that is arguable. The other half is not: the coin
    picker counts its options off the rows on hand, so a type below the cap
    was not further down the page, it was unreachable - not shown, and not
    offerable by the control meant to find it.
*/
test('a coin type past the cap is on the page, and in the filter', async () => {
    const opened = manyTypesStore(46)
    const body = (await fetchAll(opened, ['/types']))['/types'].body

    const rows = body.split('<tbody>')[1]
    const smallest = 'Sovereign \u00b7 Type 45'
    assert.ok(body.includes('Type 45'),
        'the 46th type of 46 is not on a page that says it shows every one')

    const shown = (rows.match(/<tr>/g) || []).length
    assert.strictEqual(shown, 46, 'the table has ' + shown + ' rows, not 46')

    /*  And the control can reach it, which is the part the cap really broke. */
    const picker = body.split('class="coin-picker"')[1].split('</form>')[0]
    assert.ok(picker.includes('Type 45'),
        'the coin picker cannot offer a type the table is showing')
    assert.ok(smallest.length > 0)
    opened.db.close()
})

/*  More coin types in one series than the per-series cap allows, each with a
    live shelf and no sales - which is the cheapest row that still qualifies,
    and the kind the cap cuts first. */
function manyTypesStore (types, prefix) {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const tag = prefix || 'TYPE'
    for (let t = 0; t < types; t++) {
        const key = 'GB.SOV.' + tag + '_' + t + '.FULL'
        /*  Descending listing counts, so the LAST type is the one the cap
            would cut - instruments() hands them back busiest first. */
        for (let n = 0; n < 3 + (types - t); n++) {
            const id = 'v1|' + tag + t + 'n' + n + '|0'
            repository.saveListing({
                browseId: id, legacyId: tag + t + 'n' + n, title: key + ' example ' + n,
                buyingOptions: 'FIXED_PRICE', endTime: null,
                imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
            }, now)
            repository.saveSnapshot(id, { price: 900 + n, shipping: 4, observedAt: now })
            repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        }
    }

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

/*
    THE SET IS HELD BETWEEN REQUESTS, SO IT HAS TO BE LET GO OF.

    Uncapping /types made it 5.8s cold, and marketsFor's stamp carries a
    minute bucket - so without a cache of its own the page paid that once a
    minute rather than once a sweep. It is therefore kept on the watermark,
    which puts it in the same class as scanCounts and inherits both of that
    cache's bugs unless they are tested for: a set that outlives the write
    that changed it, and one store answered from another's rows.
*/
test('a new coin type appears without waiting for a cache to expire', async () => {
    const opened = manyTypesStore(3)
    const before = (await fetchAll(opened, ['/types']))['/types'].body
    assert.ok(!before.includes('Type 9'), 'the fixture already has the type under test')

    const now = new Date().toISOString()
    const key = 'GB.SOV.TYPE_9.FULL'
    for (let n = 0; n < 4; n++) {
        const id = 'v1|late' + n + '|0'
        opened.repository.saveListing({
            browseId: id, legacyId: 'late' + n, title: key + ' example ' + n,
            buyingOptions: 'FIXED_PRICE', endTime: null,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        opened.repository.saveSnapshot(id, { price: 950 + n, shipping: 4, observedAt: now })
        opened.repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
    }

    const after = (await fetchAll(opened, ['/types']))['/types'].body
    assert.ok(after.includes('Type 9'),
        'a coin type the store now holds is missing from a page that says it shows every one')
    opened.db.close()
})

test('one store is never answered from another store rows', async () => {
    /*  One dashboard means one store in production, which is why a cache
        keyed on nothing never showed this - and the test suite runs several
        stores in one process, which is the same bug wearing a smaller hat.

        THE WATERMARKS ARE MADE TO COLLIDE, and that is the whole test. Two
        arbitrary stores have different watermarks, so dropping the store from
        the key still passes - the mark catches it, and the assertion proves
        nothing about the thing it names. These two hold the same counts and
        are stamped to the same instant, so only the store identity can tell
        them apart. */
    /*  A moment ago, not an arbitrary date: the spot reading has to stay
        recent enough to price a listing seen today, or both stores render
        empty and the assertions below pass for the wrong reason. */
    const stamp = new Date(Date.now() - 60000).toISOString()
    const align = (opened) => {
        opened.db.exec("UPDATE listing_instrument SET assigned_at = '" + stamp + "'")
        opened.db.exec("UPDATE spot SET observed_at = '" + stamp + "'")
    }

    const first = manyTypesStore(3)
    const second = manyTypesStore(3, 'OTHER')
    align(first)
    align(second)
    assert.strictEqual(second.repository.marketWatermark(), first.repository.marketWatermark(),
        'the two fixtures did not collide, so this proves nothing about the store key')

    await fetchAll(first, ['/types'])
    const body = (await fetchAll(second, ['/types']))['/types'].body

    assert.ok(!body.includes('GB.SOV.TYPE_0.FULL'),
        'the second store was served the first store rows')
    assert.ok(body.includes('GB.SOV.OTHER_0.FULL'), 'the second store own rows are missing')
    first.db.close()
    second.db.close()
})

test('a coin types column reorders the table', async () => {
    /*  twoSeriesStore is the wrong fixture for this and passed anyway: only
        the sovereign has resolved sales, so only one row has a clearing price
        at all, and a null sorts last in BOTH directions. Two priced rows, or
        this proves nothing. */
    const opened = twoPricedTypesStore()
    const paths = ['/types?order=clears', '/types?order=cheapest']
    const pages = await fetchAll(opened, paths)

    const firstRow = (body) => body.split('<tbody>')[1].split('</tr>')[0]
    const dear = firstRow(pages['/types?order=clears'].body)
    const cheap = firstRow(pages['/types?order=cheapest'].body)

    assert.ok(dear.includes('Sovereign (proof)'),
        'dearest-first did not open with the dearest type: ' + dear)
    assert.ok(cheap.includes('Sovereign (bullion)'),
        'cheapest-first did not open with the cheapest type: ' + cheap)
    /*  And the header says which one you are on, or the arrow is decoration. */
    assert.ok(pages['/types?order=clears'].body.includes('class="sortable on"'),
        'no column is marked as the one in force')
    opened.db.close()
})

/*  Two coin types in one series, priced 30 points apart, so an ordering has
    something to get wrong. */
function twoPricedTypesStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const sale = (tag, n, key, price) => {
        const id = 'v1|' + tag + n + '|0'
        repository.saveListing({
            browseId: id, legacyId: tag + n, title: key + ' example ' + n,
            buyingOptions: 'AUCTION', endTime: now,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(id, { price, shipping: 4, observedAt: now })
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(id, {
            endTime: now, sold: true, finalPrice: price, shipping: 4, bidCount: 7,
            saleType: 'AUCTION', censored: false, source: 'trading_getitem'
        })
    }
    for (let n = 0; n < 4; n++) {
        sale('bul', n, 'GB.SOV.BULLION.FULL', 820 + n)
        sale('prf', n, 'GB.SOV.PROOF.FULL', 1090 + n)
    }

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

/*
    THE FORMAT FILTER HAS TO MOVE THE NUMBER.

    fairByChannel was computed on every render of six pages and displayed on
    none, so a filter that read from it could look right and be wired to the
    blended figure - which on this fixture is auction-dominated and would sit
    within a point or two of the auction column. Hence a fixture where the two
    channels are 30 points apart: a wiring mistake cannot hide inside that.
*/
function twoChannelStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    const key = 'GB.SOV.BULLION.FULL'
    const sale = (n, price, saleType, censored) => {
        const id = 'v1|chan' + n + '|0'
        repository.saveListing({
            browseId: id, legacyId: 'chan' + n, title: key + ' example ' + n,
            buyingOptions: saleType === 'AUCTION' ? 'AUCTION' : 'FIXED_PRICE|BEST_OFFER',
            endTime: saleType === 'AUCTION' ? now : null,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(id, { price, shipping: 4, observedAt: now })
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
        repository.saveOutcome(id, {
            endTime: now, sold: true, finalPrice: price, shipping: 4,
            bidCount: saleType === 'AUCTION' ? 7 : null,
            saleType, censored, source: 'trading_getitem'
        })
    }

    /*  Metal is 0.2354 oz at GBP 3,290 = GBP 774. Auctions land just over it;
        the shelf clears a third above. Four of each, so both channels pass
        the three-sale minimum on their own. */
    for (let n = 0; n < 4; n++) { sale(n, 820 + n, 'AUCTION', false) }
    for (let n = 4; n < 8; n++) { sale(n, 1090 + n, 'FIXED_PRICE', false) }

    /*  And a shelf that has not sold, or there is no asking price and the
        spread is blank in every column - which is how the first version of
        this fixture passed a test about the spread moving. */
    for (let n = 8; n < 11; n++) {
        const id = 'v1|chan' + n + '|0'
        repository.saveListing({
            browseId: id, legacyId: 'chan' + n, title: key + ' example ' + n,
            buyingOptions: 'FIXED_PRICE', endTime: null,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(id, { price: 1400 + n, shipping: 4, observedAt: now })
        repository.saveClassification(id, [{ key, level: 0 }], 0.9, 'title', 0.2354, {})
    }

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('the format filter switches which sales the clearing figure comes from', async () => {
    const opened = twoChannelStore()
    const paths = ['/types', '/types?sale=bin', '/types?sale=all']
    const pages = await fetchAll(opened, paths)

    /*  Column 4 of the row - coin type, series, sales, clears at. Read as
        rendered rather than recomputed, because the bug this is for is a
        rendering one. */
    const clears = (body) => {
        const cells = body.split('<tbody>')[1].split('</tr>')[0].split('</td>')
        assert.ok(cells.length > 4, 'the types table has no row to read')
        return cells[3].slice(cells[3].lastIndexOf('>') + 1).trim()
    }
    const auction = clears(pages['/types'].body)
    const bin = clears(pages['/types?sale=bin'].body)

    const number = (text) => Number(text.replace(/[^0-9.-]/g, ''))
    assert.ok(number(bin) - number(auction) > 20,
        'auctions say ' + auction + ' and Buy-It-Now says ' + bin +
        ': the filter is not switching the channel')

    /*  THERE IS NO THIRD OPTION, AND THAT IS THE POINT.

        The scanner's format filter has a "Both" because it filters listings.
        This one filters a clearing PRICE, and channels.js opens by arguing
        that the average of two markets describes neither - which is why the
        clearing figure has been auction-only since it existed. A blend here
        would undo the reason rather than the implementation.

        `?sale=all` still has to resolve, because the scanner links to it and
        somebody will arrive carrying it. It falls back to auctions. */
    assert.strictEqual(pages['/types?sale=all'].status, 200, '?sale=all did not resolve')
    assert.strictEqual(clears(pages['/types?sale=all'].body), auction,
        '?sale=all should fall back to auctions, not invent a blend')
    const control = pages['/types'].body.split('class="seg"')[1].split('</span>')[0]
    assert.ok(!control.includes('>Both<'), 'a combined clearing figure is being offered')
    opened.db.close()
})

test('the spread moves with the clearing figure it is measured against', async () => {
    /*  market.js stores askClearingSpread against the AUCTION fair value,
        under a comment saying the spread must use the same clearing figure
        the page prints. Printing a Buy-It-Now figure and the stored spread
        beside it breaks that rule in the other direction: the column sits
        still while the number above it moves 30 points. */
    const opened = twoChannelStore()
    const paths = ['/types', '/types?sale=bin']
    const pages = await fetchAll(opened, paths)

    /*  Tags out first, THEN the text - the spread cell wraps its number in
        <strong>, so taking whatever follows the last '>' returned the empty
        string and every comparison here was 0 against 0. */
    const cell = (body, i) => body.split('<tbody>')[1].split('</tr>')[0]
        .split('</td>')[i].replace(/<[^>]*>/g, '').trim()
    const number = (text) => Number(text.replace(/[^0-9.-]/g, ''))

    /*  Cells: type, series, sales, clears at, p25-p75, asks, spread. */
    const auctionSpread = number(cell(pages['/types'].body, 6))
    const binSpread = number(cell(pages['/types?sale=bin'].body, 6))
    const auctionClears = number(cell(pages['/types'].body, 3))
    const binClears = number(cell(pages['/types?sale=bin'].body, 3))

    assert.notStrictEqual(auctionSpread, binSpread,
        'the spread did not move when the clearing figure under it did')
    /*  And it is the SAME subtraction in both, not merely a different one. */
    const asks = number(cell(pages['/types'].body, 5))
    assert.ok(Math.abs((asks - auctionClears) - auctionSpread) < 0.2,
        'the auction spread is not asks minus the auction clearing figure')
    assert.ok(Math.abs((asks - binClears) - binSpread) < 0.2,
        'the Buy-It-Now spread is not asks minus the Buy-It-Now clearing figure')
    opened.db.close()
})

test('a Buy-It-Now figure built on withheld prices says so', async () => {
    /*  eBay never publishes what an accepted Best Offer went for, so those
        rows are ceilings. They are kept - discarding them threw away half the
        Buy-It-Now corpus - and the cell has to say what it is showing. */
    const opened = twoChannelStore()
    opened.repository.saveOutcome('v1|chan4|0', {
        endTime: new Date().toISOString(), sold: true, finalPrice: 1094, shipping: 4,
        bidCount: null, saleType: 'BEST_OFFER', censored: true, source: 'trading_getitem'
    })

    const body = (await fetchAll(opened, ['/types?sale=bin']))['/types?sale=bin'].body
    const row = body.split('<tbody>')[1].split('</tr>')[0]
    assert.ok(row.includes('at most'),
        'a clearing figure with a withheld price in it is printed as though somebody paid it')
    /*  A spread measured against a ceiling is a floor, and says so. */
    assert.ok(row.includes('at least'),
        'the spread off a ceiling is printed as though it were exact')

    const auction = (await fetchAll(opened, ['/types']))['/types'].body
    assert.ok(!auction.split('<tbody>')[1].split('</tr>')[0].includes('at most'),
        'an auction figure is exact and must not be hedged')
    opened.db.close()
})

/*
    THE TOGGLE THAT ATE THE PAGE.

    The theme toggle is a link that sets a cookie and sends you back, so it has
    to know where back IS. It was built from the pathname alone, and two pages
    in this app REQUIRE a query parameter: /listings needs `key` and /teach
    needs `legacy`. Without one each renders an error page - so changing theme
    while reading a coin type's sold prices answered "No coin type given", and
    doing it on a teach page answered "That decision is no longer stored",
    which is not even true. The decision was fine; the link had dropped it.

    Everywhere else it was a quieter version of the same thing: your view,
    search, sort and metal filter all reset because none of them survived the
    round trip.
*/
const TOGGLE_KEEPS = [
    ['/listings?key=GB.SOV.BULLION.FULL', 'a coin type&apos;s sold prices'],
    ['/listings?key=GB.SOV.BULLION.FULL&sale=auction', 'a sale-type tab'],
    ['/?view=sold', 'the sold view'],
    ['/?view=sold&q=sovereign', 'a search inside a view'],
    ['/?sort=spot&metal=XAU', 'a sort and a metal filter'],
    ['/review?sort=oldest', 'the review queue&apos;s own ordering']
]

test('changing theme returns you to the page you were on, not its bare path', async () => {
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, TOGGLE_KEEPS.map(([path]) => path))

    for (const [path, what] of TOGGLE_KEEPS) {
        const body = pages[path].body
        assert.strictEqual(pages[path].status, 200, path + ' did not render')

        const nav = (body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]
        const back = /\/theme\?to=(?:dark|light)&amp;back=([^"]*)"/.exec(nav)
        assert.ok(back !== null, 'no theme link in the bar on ' + path)

        assert.strictEqual(decodeURIComponent(back[1]), path,
            'the toggle on ' + path + ' goes back to ' + decodeURIComponent(back[1]) +
            ', losing ' + what)
    }
    opened.db.close()
})

test('the two pages that need a parameter do not lose it to the toggle', async () => {
    /*  The severe half, asserted on the consequence rather than the link: follow
        where the toggle would send you and check you do not land on the error
        page. /listings without a key and /teach without a legacy id are both
        dead ends you cannot get out of except by starting again. */
    const opened = twoSeriesStore()
    const paths = ['/listings?key=GB.SOV.BULLION.FULL']
    const pages = await fetchAll(opened, paths)

    for (const path of paths) {
        const nav = (pages[path].body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]
        const back = decodeURIComponent(/back=([^"]*)"/.exec(nav)[1])
        const landed = (await fetchAll(opened, [back]))[back]

        assert.ok(!landed.body.includes('No coin type given'),
            'the toggle on ' + path + ' lands on the no-coin-type error page')
        assert.ok(!landed.body.includes('Nothing to generalise'),
            'the toggle on ' + path + ' lands on the nothing-to-generalise dead end')
    }
    opened.db.close()
})

test('exactly one menu row is marked as the page you are on', async () => {
    /*  `here()` matched a bare '/' against any scanner URL, so on ?view=sold two
        rows in two different menus each claimed to be where you were. */
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, ['/', '/?view=sold', '/?view=offers', '/gaps'])

    for (const [path, page] of Object.entries(pages)) {
        const nav = (page.body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]
        const current = (nav.match(/class="menu-row on"/g) || []).length
        assert.strictEqual(current, 1,
            path + ' marks ' + current + ' menu rows as current; exactly one is where you are')
    }
    opened.db.close()
})

/*
    ONE GESTURE, ONE APPEARANCE.

    The redesign gave the scanner a tick and a cross. Three other places kept
    the wide worded buttons they had always had - the sold table, the review
    queue and the drill-down - so the same decision looked like two different
    features depending which list you found the coin in, and the owner asked
    for the pair everywhere.

    Asserted as an absence as well as a presence: a new list is far more likely
    to copy the old wide button from a neighbouring function than to invent a
    third style, so what this really guards is that no worded verdict button
    comes back.
*/
const VERDICT_SURFACES = [
    ['/', 'the scanner'],
    ['/?view=sold', 'the sold list'],
    ['/?view=offers', 'the offers panel'],
    ['/review', 'the review queue'],
    ['/listings?key=GB.SOV.BULLION.FULL', 'the drill-down']
]

test('every verdict button in the app is the same tick and cross', async () => {
    const opened = twoSeriesStore()
    const pages = await fetchAll(opened, VERDICT_SURFACES.map(([path]) => path))

    let found = 0
    for (const [path, what] of VERDICT_SURFACES) {
        const body = pages[path].body
        assert.strictEqual(pages[path].status, 200, path + ' did not render')

        /*  Every button that records a verdict, whichever field it posts. */
        const buttons = body.match(/<button[^>]*name="(?:genuine|reject|bulk)"[^>]*>[\s\S]*?<\/button>/g) || []
        if (buttons.length === 0) { continue }
        found += buttons.length

        for (const button of buttons) {
            assert.ok(button.includes('<svg'),
                what + ' has a verdict button with no icon in it: ' + button.slice(0, 90))

            /*  The face carries the icon and NOTHING else. The batch buttons
                briefly read "cross selected", which is the AI-written clutter
                this UI keeps having stripped out of it; what a button acts on
                belongs in its tooltip. */
            const face = button.replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]*>/g, '').trim()
            assert.strictEqual(face, '',
                what + ' has a worded verdict button reading "' + face + '"')
        }
    }
    assert.ok(found >= 4, 'only ' + found + ' verdict buttons found across the app; ' +
        'this test is not reaching them')
    opened.db.close()
})

test('a batch button says what it acts on in its tooltip, not on its face', async () => {
    /*  It is the row pair, at the row's size. What it acts on is a tooltip and
        the hint beside it - putting it on the button gave "cross selected". */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/review']))['/review'].body

    const bulk = body.match(/<button[^>]*name="bulk"[^>]*>[\s\S]*?<\/button>/g) || []
    assert.strictEqual(bulk.length, 2, 'expected a pair of batch buttons, found ' + bulk.length)
    for (const button of bulk) {
        assert.match(button, /title="[^"]*everything ticked"/,
            'a batch button does not say what it acts on: ' + button.slice(0, 90))
        assert.ok(button.includes('icon-btn'),
            'a batch button is not the same icon button as the row pair')
    }
    opened.db.close()
})

/*
    THE MENU BAR MUST NOT PROMISE ROWS THE PAGE WILL NOT SHOW.

    The owner's report: the bar said 2 ending within the hour and the page was
    empty. They were two different populations. The bar counted every fresh
    live auction closing in the window; the page counted only those that had
    ALSO survived the near-spot cut, so any hour in which nothing cheap
    happened to be closing produced a number in the bar and nothing under it.

    The view is built from every fresh live auction now - a lot closing in ten
    minutes at 12% over spot is still the last chance to act on it, and its
    chip already says what it costs. This pins the two counts together.

    There was no test on this view at all before, which is how it shipped.
*/
function endingStore (offsetsHours) {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    /*  One Buy-It-Now lot, and it is load-bearing. `lastSweepAt` is
        MAX(last_seen) over listings with NO end time, so a store of pure
        auctions has no sweep clock at all - and FRESHNESS.isActionable then
        rejects every row, leaving the page empty for a reason that has
        nothing to do with what is being tested. */
    repository.saveListing({
        browseId: 'v1|anchor|0', legacyId: 'anchor', title: 'Gold Sovereign anchor',
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, now)
    repository.saveSnapshot('v1|anchor|0', { price: 900, shipping: 0, observedAt: now })
    repository.setListingSeries('v1|anchor|0', 'GB.SOV')
    repository.saveClassification('v1|anchor|0', [{ key: 'GB.SOV.BULLION.FULL', level: 0 }],
        0.9, 'title', 0.2354, {})

    /*  Also load-bearing: marketPage returns "Nothing tracked yet" when no
        coin type qualifies, and a type needs three listings to qualify. These
        close in a week, so they are in every count that has no window and in
        none of the windows under test. */
    for (let n = 0; n < 3; n++) {
        const filler = 'v1|filler' + n + '|0'
        repository.saveListing({
            browseId: filler, legacyId: 'filler' + n, title: 'Gold Sovereign filler ' + n,
            buyingOptions: 'AUCTION',
            endTime: new Date(Date.now() + 168 * 3600000).toISOString()
        }, now)
        repository.saveSnapshot(filler, { price: 2000, shipping: 5, bidCount: 1, observedAt: now })
        repository.setListingSeries(filler, 'GB.SOV')
        repository.saveClassification(filler, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }],
            0.9, 'title', 0.2354, {})
    }

    offsetsHours.forEach((hours, n) => {
        const browseId = 'v1|end' + n + '|0'
        repository.saveListing({
            browseId, legacyId: 'end' + n, title: 'Gold Sovereign ' + n,
            buyingOptions: 'AUCTION',
            endTime: new Date(Date.now() + hours * 3600000).toISOString(),
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        /*  Priced WELL ABOVE spot on purpose. Under the old code every one of
            these was invisible to the page and counted by the bar, which is
            the exact disagreement being pinned. */
        repository.saveSnapshot(browseId, { price: 2000, shipping: 5, bidCount: 2, observedAt: now })
        repository.setListingSeries(browseId, 'GB.SOV')
        repository.saveClassification(browseId, [{ key: 'GB.SOV.BULLION.FULL', level: 0 }],
            0.9, 'title', 0.2354, {})
    })

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('the ending-soon count in the bar is the number of rows on the page', async () => {
    /*  Lots at 0.5h, 3h, 8h and 20h out, all dear. The default window is six
        hours, so exactly two qualify. */
    const opened = endingStore([0.5, 3, 8, 20])
    const body = (await fetchAll(opened, ['/?view=ending']))['/?view=ending'].body

    const nav = (body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]
    const barCount = Number((/Ending soon<span class="n">(\d+)<\/span>/.exec(nav) || [])[1])
    const rows = (body.match(/<tr[^>]*>[\s\S]*?name="genuine"/g) || []).length

    assert.strictEqual(barCount, 2,
        'the bar counted ' + barCount + ' inside six hours; two lots are')
    assert.strictEqual(rows, barCount,
        'the bar promises ' + barCount + ' but the page shows ' + rows)
    opened.db.close()
})

test('a dear lot closing soon is still shown', async () => {
    /*  The heart of it. Every lot in this store is priced at 2000 against a
        sovereign's ~775 of gold, so none of them is anywhere near spot. */
    const opened = endingStore([0.5, 3])
    const body = (await fetchAll(opened, ['/?view=ending']))['/?view=ending'].body

    assert.ok(body.includes('Gold Sovereign'),
        'a lot closing within the hour was hidden because it was not cheap')
    opened.db.close()
})

test('the window changes what ending soon means', async () => {
    const opened = endingStore([0.5, 3, 8, 20])
    const paths = ['/?view=ending&within=1', '/?view=ending', '/?view=ending&within=12',
        '/?view=ending&within=24']
    const pages = await fetchAll(opened, paths)
    const shown = path => (pages[path].body.match(/<tr[^>]*>[\s\S]*?name="genuine"/g) || []).length

    assert.strictEqual(shown('/?view=ending&within=1'), 1, 'one lot closes inside an hour')
    assert.strictEqual(shown('/?view=ending'), 2, 'two close inside the default six hours')
    assert.strictEqual(shown('/?view=ending&within=12'), 3, 'three close inside twelve hours')
    assert.strictEqual(shown('/?view=ending&within=24'), 4, 'all four close inside a day')

    /*  And the control shows which one you are on. */
    assert.match(pages['/?view=ending&within=12'].body, /class="seg-opt on"[^>]*>12h</,
        'the window control does not mark the chosen window')
    opened.db.close()
})

test('an unknown window falls back rather than showing nothing', async () => {
    const opened = endingStore([0.5, 3, 8, 20])
    const pages = await fetchAll(opened, ['/?view=ending&within=99', '/?view=ending&within=abc'])
    for (const path of Object.keys(pages)) {
        const rows = (pages[path].body.match(/<tr[^>]*>[\s\S]*?name="genuine"/g) || []).length
        assert.strictEqual(rows, 2, path + ' did not fall back to the default window')
    }
    opened.db.close()
})

/*
    THE THREE FILTERS THE SCANNER NEVER HAD.

    Buy-It-Now was excluded in SQL, so 2,673 live lots were tracked and
    invisible - the owner asked for them, "especially stuff that is on the
    lower end of the overprice scale". The only price cut was the fixed 5%
    that defined the near-spot view. And there was no way to ask for one kind
    of coin at all.
*/
test('the scanner can be pointed at Buy-It-Now lots', async () => {
    const opened = twoSeriesStore()
    /*  band=any throughout. The fixture's fixed-price lots ask about 16% over
        spot, which is what a Buy-It-Now normally asks, so the default 5% band
        would empty this list for a reason that has nothing to do with the
        filter under test. */
    const pages = await fetchAll(opened,
        ['/?band=any', '/?sale=bin&band=any', '/?sale=all&band=any'])

    /*  twoSeriesStore lists its fixed-price lots as FIXED_PRICE|BEST_OFFER
        and its auctions as AUCTION, so the three views are distinguishable. */
    const rows = path => (pages[path].body.match(/<td class="pick-cell">/g) || []).length
    assert.ok(rows('/?sale=bin&band=any') > 0, 'no Buy-It-Now lot is reachable at all')
    assert.ok(rows('/?sale=all&band=any') > rows('/?band=any'),
        'both together showed no more lots than auctions alone')

    assert.match(pages['/?sale=bin&band=any'].body, /<h2[^>]*>Buy-It-Now lots/,
        'the heading still calls them auctions')
    /*  "checked" became "live" when the figure stopped being a fetch size
        and became a count of the shelf. The claim is unchanged: on the
        Buy-It-Now view the strip must not call them auctions. */
    assert.match(pages['/?sale=bin&band=any'].body, /Lots live/,
        'the summary strip still says auctions')
    assert.ok(!/Auctions live/.test(pages['/?sale=bin&band=any'].body),
        'the Buy-It-Now view labels its lots as auctions')
    opened.db.close()
})

test('the price band widens and narrows what counts as worth seeing', async () => {
    const opened = twoSeriesStore()
    const paths = ['/?band=under', '/', '/?band=mid', '/?band=any']
    const pages = await fetchAll(opened, paths)
    const rows = path => (pages[path].body.match(/<td class="pick-cell">/g) || []).length

    /*  Open-topped and ordered, not a partition: each band contains the one
        below it, so the counts can only rise. */
    assert.ok(rows('/?band=under') <= rows('/'), 'under spot is not inside within 5%')
    assert.ok(rows('/') <= rows('/?band=mid'), 'within 5% is not inside within 15%')
    assert.ok(rows('/?band=mid') <= rows('/?band=any'), 'within 15% is not inside any price')
    assert.ok(rows('/?band=any') > rows('/?band=under'),
        'every band shows the same rows, so the filter does nothing')

    assert.match(pages['/?band=any'].body, /<h2[^>]*>Auctions at any price/,
        'the heading does not say which band is showing')
    opened.db.close()
})

test('the coin picker offers only coins that are actually there', async () => {
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/?band=any']))['/?band=any'].body
    const picker = (/<form class="coin-picker"[\s\S]*?<\/form>/.exec(body) || [''])[0]

    assert.ok(picker !== '', 'there is no coin picker on the scanner')
    assert.ok(picker.includes('British Gold Sovereigns') || picker.includes('Morgan'),
        'the series select names no series: ' + picker.slice(0, 200))

    /*  A catalogue-driven picker would offer every denomination the packs
        define. This one is built from the rows on hand, so a size nobody is
        selling cannot be chosen and then answer with an empty page. */
    assert.ok(!picker.includes('QUINTUPLE'),
        'the picker offers a size no listing in this store has')
    opened.db.close()
})

test('choosing a coin narrows the list to it', async () => {
    const opened = twoSeriesStore()
    const paths = ['/?band=any', '/?band=any&series=GB.SOV', '/?band=any&series=US.MORGAN']
    const pages = await fetchAll(opened, paths)
    const rows = path => (pages[path].body.match(/<td class="pick-cell">/g) || []).length

    assert.ok(rows('/?band=any&series=GB.SOV') > 0, 'no sovereign survived its own filter')
    assert.ok(rows('/?band=any&series=US.MORGAN') > 0, 'no Morgan survived its own filter')
    assert.strictEqual(rows('/?band=any&series=GB.SOV') + rows('/?band=any&series=US.MORGAN'),
        rows('/?band=any'),
        'the two series do not add up to the unfiltered list, so a lot is in both or neither')

    /*  And a sovereign page says nothing about Morgans. */
    const sov = pages['/?band=any&series=GB.SOV'].body
    const table = (/<table class="scan">[\s\S]*?<\/table>/.exec(sov) || [''])[0]
    assert.ok(!/morgan/i.test(table), 'a Morgan is in the sovereign-filtered table')
    opened.db.close()
})

test('a filter nobody set is not a filter', async () => {
    /*  A junk parameter must not silently empty the page - it is dropped, and
        the list is the one you would have had. */
    const opened = twoSeriesStore()
    const paths = ['/?band=any', '/?band=any&series=../etc', '/?band=any&sale=nonsense']
    const pages = await fetchAll(opened, paths)
    const rows = path => (pages[path].body.match(/<td class="pick-cell">/g) || []).length

    assert.strictEqual(rows('/?band=any&series=../etc'), rows('/?band=any'),
        'a malformed series filtered the list instead of being ignored')
    assert.strictEqual(pages['/?band=any&sale=nonsense'].status, 200)
    opened.db.close()
})

/*
    THE OWNER'S QUESTION ABOUT THE STRIP: what is "median finish vs spot"
    telling me - sovereigns only? fulls? halfs? everything?

    Two things were wrong beneath it. The near-spot cell counted rows on
    SCREEN, so it could never exceed the forty the list shows however many
    qualified. And the median counted each sale once per level of the key
    hierarchy - `instruments(0, 3)` returns four levels and a listing is filed
    under every level it belongs to, so a sale filed four deep voted four
    times and the figure was a median over sale-key pairs, not over sales.
*/
/*  A store with MORE lots than the list shows, and each listing filed under
    several levels of the key hierarchy - the two conditions under which the
    strip's two faults are visible at all. The first fixture I wrote had
    neither, so both mutations passed against it. */
function deepStore (liveCount) {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const soon = new Date(Date.now() + 7200000).toISOString()

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    /*  Every listing filed at four levels, built by the catalogue rather than
        invented - keys the instrument table does not hold are not returned by
        instruments(0, 3) at all, so hand-written ones silently collapse the
        ladder to a single entry and the double-count cannot be reproduced.
        That is how the first version of this test passed against the bug. */
    const KEYS = [0, 1, 2, 3].map(level => ({
        key: INSTRUMENTS.keyAt({
            denomination: 'FULL', pool: 'BULLION', portrait: 'EDWARD_VII',
            year: 1905, mint: 'LONDON', gradeBand: 'UNC'
        }, level, SERIES.forKey('GB.SOV.BULLION.FULL').pack),
        level
    }))
    const add = (id, price, sold) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: 'Gold Sovereign ' + id,
            buyingOptions: 'AUCTION', endTime: soon,
            imageUrl: 'https://i.ebayimg.com/images/g/AAA/s-l225.jpg'
        }, now)
        repository.saveSnapshot(browseId, { price, shipping: 0, bidCount: 3, observedAt: now })
        repository.setListingSeries(browseId, 'GB.SOV')
        repository.saveClassification(browseId, KEYS, 0.9, 'title', 0.2354, {})
        if (sold) {
            repository.saveOutcome(browseId, {
                endTime: now, sold: true, finalPrice: price, shipping: 0, bidCount: 5,
                saleType: 'AUCTION', censored: false, source: 'trading_getitem'
            })
        }
        return browseId
    }

    /*  A Buy-It-Now so lastSweepAt has an anchor. */
    repository.saveListing({ browseId: 'v1|anchor|0', legacyId: 'anchor',
        title: 'Gold Sovereign anchor', buyingOptions: 'FIXED_PRICE', endTime: null }, now)
    repository.saveSnapshot('v1|anchor|0', { price: 800, shipping: 0, observedAt: now })

    for (let n = 0; n < liveCount; n++) { add('live' + n, 780 + n, false) }
    for (let n = 0; n < 6; n++) { add('sold' + n, 820 + n * 10, true) }

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('the near-spot figure counts lots, not rows on the screen', async () => {
    /*  55 qualifying lots against a list that shows 40. The figure used to be
        `shown.length`, so it could never say more than 40 however many there
        were - two cells side by side on different populations. */
    const opened = deepStore(55)
    const body = (await fetchAll(opened, ['/?band=any']))['/?band=any'].body

    const strip = (/<div class="summary">[\s\S]*?<div class="filters">/.exec(body) || [''])[0]
    const figure = Number((/cell-figure accent">(\d+)</.exec(strip) || [])[1])
    const rows = (body.match(/<td class="pick-cell">/g) || []).length

    assert.strictEqual(rows, 40, 'the list should be capped at 40, showed ' + rows)
    assert.ok(figure > 40,
        'the strip says ' + figure + ' with 55 lots qualifying - it is counting the ' +
        'rows on screen rather than the lots that matched')
    opened.db.close()
})

test('the median finish counts each sale once, not once per key level', async () => {
    /*  Every listing here is filed under four levels, so before the dedupe
        each of the six sales voted up to four times. */
    const opened = deepStore(4)
    const body = (await fetchAll(opened, ['/']))['/'].body

    const tip = (/title="([^"]*middle result of[^"]*)"/.exec(body) || [])[1]
    assert.ok(tip !== undefined, 'the median cell does not say what it is over')

    const claimed = Number(/middle result of (\d+)/.exec(tip)[1])
    const actual = opened.db.prepare(
        "SELECT COUNT(*) n FROM listing_outcome WHERE sold = 1 AND sale_type = 'AUCTION' AND censored = 0"
    ).get().n

    assert.strictEqual(actual, 6, 'the fixture should hold six sold auctions')
    assert.strictEqual(claimed, actual,
        'the median claims ' + claimed + ' sales from a store holding ' + actual +
        ' - it is counting each one once per level of the key hierarchy')
    assert.match(tip, /180 days/, 'the tooltip does not say what window it covers')
    opened.db.close()
})

test('every figure on the strip says what it is over', async () => {
    /*  The owner's complaint was that none of them did, and that they are all
        over different things - which they are: one is pre-filter and capped,
        three follow the filters, and one has no window at all. In tooltips,
        never in page prose - the standing rule for this UI. */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/']))['/'].body
    const strip = (/<div class="summary">[\s\S]*?<div class="filters">/.exec(body) || [''])[0]

    const labels = strip.match(/<div class="cell-label"[^>]*>/g) || []
    assert.strictEqual(labels.length, 5, 'expected five cells, found ' + labels.length)
    labels.forEach((label, i) => {
        assert.match(label, /title="[^"]{40,}"/,
            'cell ' + i + ' carries no explanation of what it counts: ' + label)
    })
    opened.db.close()
})

test('a coin type can be reached from the lot that belongs to it', async () => {
    /*
        THE OWNER COULD NOT FIND THIS PAGE, and it was there all along:
        /listings holds every sale behind a coin type, what it clears at, and
        the lots still live. The only way in was Reference, then Coin types,
        then finding the row in a table - three clicks from a menu nobody had
        reason to open, and nothing on the scanner linked to it at all.
    */
    const opened = twoSeriesStore()
    const body = (await fetchAll(opened, ['/?band=any']))['/?band=any'].body
    const table = (/<table class="scan">[\s\S]*?<\/table>/.exec(body) || [''])[0]

    const links = table.match(/href="\/listings\?key=[^"]+"/g) || []
    assert.ok(links.length > 0,
        'no row on the scanner links to the coin type it was identified as')

    /*  And the link goes somewhere real. */
    const key = decodeURIComponent(/key=([^"]+)/.exec(links[0])[1])
    const target = '/listings?key=' + encodeURIComponent(key)
    const landed = (await fetchAll(opened, [target]))[target]
    assert.strictEqual(landed.status, 200, target + ' does not render')
    assert.ok(!landed.body.includes('No coin type given'),
        'the link from a row lands on the no-coin-type error page')
    opened.db.close()
})

test('a coin type says when its sales happened', async () => {
    /*  Every clearing figure here is over 180 days with a 45-day half-life,
        and a type whose sales all closed 170 days ago rendered identically to
        one whose sales closed last week. The owner asked for the period. */
    const opened = twoSeriesStore()
    const path = '/listings?key=GB.SOV.BULLION.FULL'
    const body = (await fetchAll(opened, [path]))[path].body

    assert.match(body, /Priced from \d+ sales? between \d{4}-\d{2}-\d{2} and \d{4}-\d{2}-\d{2}/,
        'the page does not say what period its figures cover')

    /*  The span of the sales actually behind the figure, not the window they
        were drawn from - a 180-day window holding six days of sales is a
        six-day sample, and quoting the window would be the more flattering of
        two true statements. */
    assert.match(body, /180-day window/,
        'the page does not say the window the sample was drawn from either')
    opened.db.close()
})

test('a view never prints the word undefined', async () => {
    /*  Deleting the ending view's blurb left VIEW_BLURBS[scanView] undefined,
        and an undefined in a template literal renders as the word - which is
        what shipped, sitting under the heading. Checked on every view rather
        than the one that broke. */
    const opened = endingStore([0.5, 3])
    const paths = ['/', '/?view=ending', '/?view=sold', '/?view=offers']
    const pages = await fetchAll(opened, paths)

    for (const path of paths) {
        assert.ok(!/>\s*undefined\s*</.test(pages[path].body),
            path + ' renders the word "undefined" as content')
        assert.ok(!pages[path].body.includes('>null<'),
            path + ' renders the word "null" as content')
    }
    opened.db.close()
})

test('a control that is shown is a control that filters', async () => {
    /*  The price band was rendered on Ending soon and did nothing to it: the
        list was built before the band was applied, so a page reading "Within
        5%" listed lots at +14.3%. A control that does not do what it says is
        worse than no control.

        Ending soon DEFAULTS to any price, because that is what the view is
        for - but the control works when you use it. */
    const opened = endingStore([0.5, 3, 8, 20])
    const pages = await fetchAll(opened,
        ['/?view=ending&within=24', '/?view=ending&within=24&band=near'])
    const rows = path => (pages[path].body.match(/<td class="pick-cell">/g) || []).length

    /*  endingStore prices every lot at 2000 against about 775 of gold, so
        none is within 5% of spot. */
    assert.ok(rows('/?view=ending&within=24') > 0, 'the default ending view is empty')
    assert.strictEqual(rows('/?view=ending&within=24&band=near'), 0,
        'asking for lots within 5% of spot returned lots at 158% over it')

    /*  And the default is any price, so the control starts where the view
        means rather than hiding most of the list on arrival. */
    assert.match(pages['/?view=ending&within=24'].body, /class="seg-opt on"[^>]*>Any price</,
        'the ending view does not start on any price')
    opened.db.close()
})

/*
    THE COUNT IN THE BAR MUST MOVE WHEN YOU JUDGE A COIN.

    The owner's report: change several on the page, then judge another, and the
    number does not update. `scanCounts` was invalidated by a thirty-second
    timer and by nothing else - the POST path never cleared it - so a verdict
    was invisible in the bar until the timer happened to expire.

    That is the loop the router's own comments call load-bearing: a decision
    that does not change the front page is a decision the reader cannot trust
    they made. The watermark that already drops the market memo on a label now
    drops this too.
*/
test('the menu-bar count moves on the redirect after a verdict, not a timer later', async () => {
    /*  deepStore prices its lots at about 1.007 of their metal, so they are
        inside the near-spot band and the bar actually counts them.
        twoSeriesStore asks 16% over, which is what a Buy-It-Now asks and what
        makes that count zero - a fixture that cannot show the bug. */
    const opened = deepStore(5)

    const countIn = (body) => {
        const nav = (body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]
        return Number((/Auctions near spot<span class="n">(\d+)<\/span>/.exec(nav) || [])[1])
    }

    const before = countIn((await fetchAll(opened, ['/']))['/'].body)
    assert.ok(Number.isFinite(before) && before > 0,
        'the bar shows no near-spot count to begin with: ' + before)

    /*  Reject one of the coins the count is counting. */
    const victim = opened.db.prepare(`
        SELECT l.legacy_id AS id FROM listing l
        JOIN listing_instrument li ON li.browse_id = l.browse_id
        WHERE l.buying_options LIKE '%AUCTION%' LIMIT 1`).get().id
    const done = await post(opened, '/apply', { reject: victim, back: '/' })
    assert.strictEqual(done.status, 303, 'the verdict did not record')

    /*  Immediately - no waiting. Same clock, changed data. */
    const after = countIn((await fetchAll(opened, ['/']))['/'].body)
    assert.ok(after < before,
        'the bar still says ' + after + ' after rejecting a coin it was counting ' +
        '(was ' + before + ') - the count is on a timer rather than on the data')

    opened.db.close()
})

test('a filter link keeps every other filter', async () => {
    /*  The metal toggles and the view pills built their own URLs, so clicking
        Silver threw away the sort, the window, the sale type, the price band
        and the whole coin picker. Three builders for one job. */
    const opened = twoSeriesStore()
    const path = '/?view=ending&within=12&sale=all&band=mid&sort=spot&series=GB.SOV'
    const body = (await fetchAll(opened, [path]))[path].body
    const filters = (/<div class="filters">[\s\S]*?<\/div>\s*(?:<form|<h2)/.exec(body) || [''])[0]

    const links = (filters.match(/href="\/\?[^"]*"/g) || [])
        .map(h => h.replace(/^href="/, '').replace(/"$/, '').replace(/&amp;/g, '&'))
    assert.ok(links.length >= 4, 'expected several filter links, found ' + links.length)

    /*  Every link changes exactly one thing and keeps the rest. Checked on the
        parameters a click used to drop. */
    for (const link of links) {
        const carried = ['within=12', 'sale=all', 'band=mid', 'sort=spot', 'series=GB.SOV']
            .filter(pair => link.includes(pair.split('=')[0] + '='))
        assert.ok(carried.length >= 3,
            link + ' carries only ' + carried.length + ' of the five filters that were set')
    }
    opened.db.close()
})

/*
    THE COIN NO VERDICT COULD RESCUE.

    The owner's listing, verbatim:

        SCARCE GOLD 2POUND 1902 Edward VII Head Dragon London Spink 3967 UNC

    No pack claims it, because no pack looks for anything but the word
    "sovereign" or "sov". So classify() was never called - no denomination, no
    key, no guess - and the row's kind and denomination selects were built from
    a pack that did not exist, leaving two dropdowns containing nothing but
    their own placeholders.

    Worse than useless: marking it genuine ran RECLASSIFY.one, which hit the
    same gate and re-queued it with the same reason. The verdict was discarded
    on every sweep. Nothing the owner could do would stick.
*/
function strandedStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()
    const TITLE = 'SCARCE GOLD 2POUND 1902 Edward VII Head Dragon London Spink 3967 UNC Numisb517'

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')

    repository.saveListing({
        browseId: 'v1|stranded|0', legacyId: '287558264634', title: TITLE,
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, now)
    repository.saveSnapshot('v1|stranded|0', { price: 1450, shipping: 0, observedAt: now })
    /*  The state the collector leaves it in: no series, queued, unpriced. */
    repository.setListingSeries('v1|stranded|0', null)
    repository.queueForReview('v1|stranded|0', 'No tracked series recognises this', null, 0)

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}), TITLE }
}

test('an unrecognised coin offers a way to say what it is', async () => {
    const opened = strandedStore()
    /*  sale=all: the review page defaults to auctions and this lot is a
        Buy-It-Now, so the default tab hides it for a reason that has nothing
        to do with what is under test. */
    const path = '/review?coin=%3F&sale=all'
    const body = (await fetchAll(opened, [path]))[path].body

    assert.ok(body.includes('2POUND'), 'the stranded listing is not on the review page')
    assert.match(body, /<select name="s_287558264634"/,
        'no series control is offered on a row nothing could name')
    assert.match(body, /British Gold Sovereigns/,
        'the series control offers no series to choose')

    /*  And the Filed as column says the tool could not place it, rather than
        sitting empty. An unplaced coin is not a coin filed wrongly - it is
        one that joined no clearing figure at all, which is a different job
        for the reviewer, and a blank cell says neither. */
    const row = body.split('<tbody>')[1].split('</tr>')[0]
    assert.ok(row.includes('>no group<'),
        'a coin the tool could not place has an empty Filed as cell')
    opened.db.close()
})

test('a series chosen by hand survives the next reclassify', async () => {
    /*  THE HEART OF IT. Before, this assignment was undone by the very
        RECLASSIFY.one that /apply runs immediately after storing it. */
    const opened = strandedStore()

    const done = await post(opened, '/apply', {
        genuine: '287558264634', s_287558264634: 'GB.SOV',
        d_287558264634: 'DOUBLE', q_287558264634: '1', back: '/review'
    })
    assert.strictEqual(done.status, 303, 'the verdict did not record')

    const seriesNow = () => opened.db.prepare(
        'SELECT series FROM listing WHERE browse_id = ?').get('v1|stranded|0').series
    assert.strictEqual(seriesNow(), 'GB.SOV',
        'the series the reader chose was thrown away by the reclassify that /apply runs')

    /*  And again, the way an hourly sweep would. */
    const RECLASSIFY = require('../src/catalogue/reclassify.js')
    RECLASSIFY.one(opened.db, opened.repository, '287558264634', { allowedCountries: [] })
    assert.strictEqual(seriesNow(), 'GB.SOV',
        'a sweep undid the decision - which is what made this coin unrescuable')

    /*  Filed under a coin type, so it can finally carry a premium. */
    const keys = opened.db.prepare(
        'SELECT key FROM listing_instrument WHERE browse_id = ?').all('v1|stranded|0')
    assert.ok(keys.length > 0,
        'the coin is named but still filed under no type, so it is still unpriceable')
    assert.ok(keys.some(k => k.key.includes('DOUBLE')),
        'filed, but not as the double sovereign the reader said it was: ' +
        keys.map(k => k.key).join(', '))

    opened.db.close()
})

test('naming a series does not overrule a pack that recognised the title', async () => {
    /*  The label is a fallback, never an override. A pack that reads the title
        has read the same words the person did, and letting a stale label win
        would make a corrected title unfixable in the other direction. */
    const opened = strandedStore()
    const now = new Date().toISOString()
    /*  A title a pack really reads. twoSeriesStore's titles are keys, which
        no recogniser claims - its series come from setListingSeries - so it
        cannot tell an override from a fallback. */
    opened.repository.saveListing({
        browseId: 'v1|realmorgan|0', legacyId: '999', title: '1902 Morgan Silver Dollar',
        buyingOptions: 'FIXED_PRICE', endTime: null
    }, now)
    opened.repository.saveSnapshot('v1|realmorgan|0', { price: 40, shipping: 0, observedAt: now })

    await post(opened, '/apply', { genuine: '999', s_999: 'GB.SOV', back: '/review' })

    const series = opened.db.prepare(
        'SELECT series FROM listing WHERE legacy_id = ?').get('999').series
    assert.strictEqual(series, 'US.MORGAN',
        'a hand-chosen series overruled a pack that recognised the title')
    opened.db.close()
})

/*
    SEVERAL RULES FROM ONE REJECTION.

    The owner: "I'm forced to only choose one suggestion even if there are
    several when adding to ignore list."

    The cause was a redirect, not the rules. `induce` returns up to six
    proposals and the teach page rendered all of them - but each carried its
    own form, and accepting any one answered with '/rules', which has no route
    back to that listing. With no client script there was then no way to reach
    the other five.
*/
function teachStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    /*  A corpus, because a phrase needs support of two before it is offered
        at all, and must not match most of the store or it is dropped as too
        common. */
    const add = (n, title) => {
        const browseId = 'v1|t' + n + '|0'
        repository.saveListing({
            browseId, legacyId: 't' + n, title,
            buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString()
        }, now)
        repository.saveSnapshot(browseId, { price: 40, shipping: 0, observedAt: now })
        repository.setListingSeries(browseId, 'GB.SOV')
    }
    for (let n = 0; n < 24; n++) { add(n, 'Gold Sovereign ' + n + ' Victoria bullion coin') }
    /*  Two lots sharing several distinctive phrases, so more than one
        proposal clears the support threshold. */
    add(100, 'Princess Ann Gold One Eight Sovereign with titanium inset New Low Mintage')
    add(101, 'Princess Ann Gold One Eight Sovereign with titanium inset Low Mintage Proof')

    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

test('rejecting a coin offers every phrase at once, not one', async () => {
    const opened = teachStore()
    await post(opened, '/apply', { reject: 't100', back: '/review' })

    const path = '/teach?legacy=t100&back=%2Freview'
    const body = (await fetchAll(opened, [path]))[path].body

    const boxes = body.match(/<input type="checkbox" name="phrase" value="[^"]*"/g) || []
    assert.ok(boxes.length >= 2,
        'only ' + boxes.length + ' phrase can be chosen; the page should offer several')

    /*  One form, one Apply - not one form per proposal. */
    const forms = body.match(/<form method="post" action="\/rule"/g) || []
    assert.strictEqual(forms.length, 1,
        'the proposals are in ' + forms.length + ' separate forms, so only one can be submitted')
    opened.db.close()
})

test('adding several rules keeps you on the page, with the rest still offered', async () => {
    const opened = teachStore()
    await post(opened, '/apply', { reject: 't100', back: '/review' })

    const path = '/teach?legacy=t100&back=%2Freview'
    const first = (await fetchAll(opened, [path]))[path].body
    const phrases = (first.match(/name="phrase" value="([^"]*)"/g) || [])
        .map(m => /value="([^"]*)"/.exec(m)[1])
    assert.ok(phrases.length >= 2, 'need at least two proposals to test taking two')

    const chosen = phrases.slice(0, 2)
    const done = await post(opened, '/rule', {
        phrase: chosen, back: path, ['support:' + chosen[0]]: '2', ['support:' + chosen[1]]: '2'
    })

    assert.strictEqual(done.status, 303)
    assert.ok(done.location.startsWith('/teach'),
        'accepting a rule sent you to ' + done.location + ' - away from the other proposals')

    const rules = opened.repository.learnedRules().map(r => r.phrase)
    for (const phrase of chosen) {
        assert.ok(rules.includes(phrase), 'the rule for ' + JSON.stringify(phrase) + ' was not saved')
    }
    assert.strictEqual(rules.length, 2, 'expected two rules, got ' + rules.length)
    opened.db.close()
})

test('a rule already added is not offered again', async () => {
    const opened = teachStore()
    await post(opened, '/apply', { reject: 't100', back: '/review' })
    const path = '/teach?legacy=t100&back=%2Freview'

    const phrases = ((await fetchAll(opened, [path]))[path].body
        .match(/name="phrase" value="([^"]*)"/g) || [])
        .map(m => /value="([^"]*)"/.exec(m)[1])
    await post(opened, '/rule', { phrase: phrases[0], back: path, ['support:' + phrases[0]]: '2' })

    const again = (await fetchAll(opened, [path]))[path].body
    assert.ok(again.includes('Added.'),
        'a rule that has been added is still offered as though it had not')
    opened.db.close()
})

test('the rules page still adds a single hand-typed phrase', async () => {
    /*  The other two callers post one phrase with unkeyed fields. They must
        keep working, and must still land on /rules. */
    const opened = teachStore()
    const done = await post(opened, '/rule', {
        phrase: 'titanium', series: 'GB.SOV', support: '2', back: '/rules'
    })
    assert.strictEqual(done.status, 303)
    assert.ok(done.location.startsWith('/rules'),
        'a rule added from /rules went to ' + done.location)
    assert.ok(opened.repository.learnedRules().some(r => r.phrase === 'titanium'),
        'the hand-typed rule was not saved')
    opened.db.close()
})

/*
    THE SAME THING IN REVERSE.

    The owner: "Then I want to be able to do the same in reverse if I spot a
    listing that should be included."

    Every rule this tool had could only say "not that". Naming a series by
    hand rescues one listing; if the packs could not read that title they will
    not read the next one either, so the rescue had to be repeated for ever.
    An inclusion rule generalises it.
*/
test('rescuing a coin offers to generalise the rescue', async () => {
    const opened = strandedStore()

    const done = await post(opened, '/apply', {
        genuine: '287558264634', s_287558264634: 'GB.SOV', back: '/review'
    })
    assert.ok(done.location.startsWith('/teach'),
        'naming the series by hand offered nothing to generalise: ' + done.location)
    assert.ok(done.location.includes('include=1'),
        'the teach page was opened in the rejecting direction after a rescue')
    opened.db.close()
})

test('a coin the packs already read has nothing to teach', async () => {
    /*  The offer is made only where a series had to be supplied. */
    const opened = strandedStore()
    const now = new Date().toISOString()
    opened.repository.saveListing({
        browseId: 'v1|plain|0', legacyId: '555', title: '1905 Gold Sovereign',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString()
    }, now)
    opened.repository.saveSnapshot('v1|plain|0', { price: 800, shipping: 0, observedAt: now })

    const done = await post(opened, '/apply', { genuine: '555', back: '/review' })
    assert.ok(!done.location.startsWith('/teach'),
        'a coin the packs recognised was offered a rescue rule it does not need')
    opened.db.close()
})

test('an inclusion rule rescues the next coin like it, without a human', async () => {
    /*  THE POINT OF THE WHOLE THING. A second listing, never touched by
        anybody, classified by the rule learned from the first. */
    const opened = strandedStore()
    const now = new Date().toISOString()

    opened.repository.saveLearnedRule({
        phrase: '2pound', kind: 'INCLUDE', series: 'GB.SOV', support: 2, agreement: null
    })

    opened.repository.saveListing({
        browseId: 'v1|second|0', legacyId: '888',
        title: 'GOLD 2POUND 1887 Victoria Jubilee Head',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString()
    }, now)
    opened.repository.saveSnapshot('v1|second|0', { price: 1500, shipping: 0, observedAt: now })

    const RECLASSIFY = require('../src/catalogue/reclassify.js')
    RECLASSIFY.one(opened.db, opened.repository, '888', { allowedCountries: [] })

    const series = opened.db.prepare(
        'SELECT series FROM listing WHERE legacy_id = ?').get('888').series
    assert.strictEqual(series, 'GB.SOV',
        'the rule learned from one coin did not reach the next one like it')

    const keys = opened.db.prepare(
        'SELECT key FROM listing_instrument WHERE browse_id = ?').all('v1|second|0')
    assert.ok(keys.some(k => k.key.includes('DOUBLE')),
        'rescued, but not priced as the double sovereign it is: ' +
        (keys.map(k => k.key).join(', ') || 'no keys at all'))
    opened.db.close()
})

test('an inclusion rule never overrules a pack that read the title', async () => {
    const opened = strandedStore()
    const now = new Date().toISOString()
    opened.repository.saveLearnedRule({
        phrase: 'gold', kind: 'INCLUDE', series: 'GB.SOV', support: 9, agreement: null
    })
    opened.repository.saveListing({
        browseId: 'v1|morgan|0', legacyId: '777', title: '1902 Morgan Silver Dollar gold toned',
        buyingOptions: 'AUCTION', endTime: new Date(Date.now() + 3600000).toISOString()
    }, now)
    opened.repository.saveSnapshot('v1|morgan|0', { price: 40, shipping: 0, observedAt: now })

    const RECLASSIFY = require('../src/catalogue/reclassify.js')
    RECLASSIFY.one(opened.db, opened.repository, '777', { allowedCountries: [] })

    assert.strictEqual(
        opened.db.prepare('SELECT series FROM listing WHERE legacy_id = ?').get('777').series,
        'US.MORGAN',
        'a broad inclusion rule overruled a pack that recognised the title')
    opened.db.close()
})

test('the teach form writes an inclusion rule, not an exclusion', async () => {
    /*  The other tests write the rule straight into the store, so the form's
        own kind field was never exercised - and a mutation making /rule write
        every rule as NOT_TRACKED passed all of them. This posts what the page
        posts. */
    const opened = strandedStore()
    await post(opened, '/rule', {
        phrase: '2pound', kind: 'INCLUDE', series: 'GB.SOV', support: '2',
        back: '/teach?legacy=287558264634&include=1'
    })

    const rule = opened.repository.learnedRules().find(r => r.phrase === '2pound')
    assert.ok(rule !== undefined, 'the rule was not saved at all')
    assert.strictEqual(rule.kind, 'INCLUDE',
        'the form saved an inclusion rule as ' + rule.kind + ' - it would exclude the coin ' +
        'it was meant to rescue')
    assert.strictEqual(rule.series, 'GB.SOV',
        'an inclusion rule must name what it includes into, got ' + rule.series)
    opened.db.close()
})

/*
    A COLUMN YOU CAN CLICK.

    There was no <th> anywhere in this app containing a link. Ordering lived in
    a select at the top of the page, which works but means reading the list,
    looking away, and choosing from eight labels.

    There were also two conventions that did not interoperate - ?order= on the
    sold list, the queue and the drill-down, and ?sort=ending|spot on the
    scanner - so ordering one table could silently reset a filter set beside
    it. One parameter now.
*/
test('the scan table sorts from its own headers', async () => {
    const opened = deepStore(6)
    const body = (await fetchAll(opened, ['/?band=any']))['/?band=any'].body
    const head = (/<thead>[\s\S]*?<\/thead>/.exec(body) || [''])[0]

    const links = head.match(/<a class="sortable[^"]*" href="([^"]+)">([^<]*)</g) || []
    assert.ok(links.length >= 5,
        'only ' + links.length + ' columns are sortable; most of them should be')

    /*  And a column with nothing to order by stays plain. */
    assert.match(head, /<th class="verdict-cell"[^>]*>(?!<a)/,
        'the verdict column offers a sort it cannot do')
    opened.db.close()
})

test('clicking a column actually reorders the rows', async () => {
    const opened = deepStore(6)
    const cheap = '/?band=any&order=cheapest'
    const dear = '/?band=any&order=dearest'
    const pages = await fetchAll(opened, [cheap, dear])

    /*  Read from INSIDE the cell, not across the whole page. The bid cell
        carries the spot value in a data-spot attribute for the phone layout,
        so a pattern anchored on the tag and then scanning forward finds that
        attribute's number first and reports every row as identical - which is
        exactly how this test first "passed" with two identical lists. */
    const prices = (body) => (body.match(/<td class="figure bid"[\s\S]*?<\/td>/g) || [])
        .map(cell => {
            const text = cell.replace(/^<td[^>]*>/, '')
            return Number((/£([\d,.]+)/.exec(text) || [0, '0'])[1].replace(/,/g, ''))
        })

    const up = prices(pages[cheap].body)
    const down = prices(pages[dear].body)
    assert.ok(up.length >= 3, 'not enough priced rows to tell an order from a coincidence')
    assert.deepStrictEqual(up, up.slice().sort((a, b) => a - b), 'cheapest first is not sorted')
    assert.deepStrictEqual(down, down.slice().sort((a, b) => b - a), 'dearest first is not sorted')
    assert.notDeepStrictEqual(up, down, 'both orderings produced the same list: up=' + JSON.stringify(up) + ' down=' + JSON.stringify(down))
    opened.db.close()
})

test('sorting a column keeps the filters, and filtering keeps the sort', async () => {
    /*  The whole reason for one parameter. Ordering used to be built by a
        different URL builder from the filters, so each dropped the other. */
    const opened = deepStore(6)
    const path = '/?band=any&sale=all&metal=XAU&order=dearest'
    const body = (await fetchAll(opened, [path]))[path].body

    const head = (/<thead>[\s\S]*?<\/thead>/.exec(body) || [''])[0]
    const sortLinks = (head.match(/href="([^"]+)"/g) || [])
        .map(h => h.slice(6, -1).replace(/&amp;/g, '&'))
    assert.ok(sortLinks.length > 0, 'no sortable headers to check')
    for (const link of sortLinks) {
        assert.ok(link.includes('band=any'), 'a column link dropped the price band: ' + link)
        assert.ok(link.includes('sale=all'), 'a column link dropped the sale type: ' + link)
    }

    /*  And the other way: a filter link keeps the ordering. */
    const filters = (/<div class="filters">[\s\S]*?<\/div>\s*(?:<form|<h2)/.exec(body) || [''])[0]
    const filterLinks = (filters.match(/href="\/\?[^"]+"/g) || [])
        .map(h => h.slice(6, -1).replace(/&amp;/g, '&'))
    assert.ok(filterLinks.some(l => l.includes('order=dearest')),
        'no filter link carried the ordering')
    opened.db.close()
})

test('an old ?sort=spot link still works', async () => {
    /*  The scanner's two orderings moved into the shared registry. A bookmark
        must not answer with a different list. */
    /*  Prices and end times deliberately DISAGREE. deepStore gives every lot
        the same end time and rising prices, so ordering by either produces the
        same sequence and the test cannot tell a working fallback from a
        broken one - which is how it first passed against a mutation that
        removed the fallback entirely. */
    const opened = deepStore(0)
    const now = new Date().toISOString()
    const INSTRUMENTS2 = require('../src/catalogue/instruments.js')
    const pack = SERIES.forKey('GB.SOV.BULLION.FULL').pack
    const KEYS = [0, 1, 2, 3].map(level => ({
        key: INSTRUMENTS2.keyAt({
            denomination: 'FULL', pool: 'BULLION', portrait: 'EDWARD_VII',
            year: 1905, mint: 'LONDON', gradeBand: 'UNC'
        }, level, pack),
        level
    }))
    ;[[900, 1], [820, 5], [860, 3]].forEach(([price, hours], n) => {
        const browseId = 'v1|mix' + n + '|0'
        opened.repository.saveListing({
            browseId, legacyId: 'mix' + n, title: 'Gold Sovereign mix ' + n,
            buyingOptions: 'AUCTION',
            endTime: new Date(Date.now() + hours * 3600000).toISOString()
        }, now)
        opened.repository.saveSnapshot(browseId, { price, shipping: 0, bidCount: 2, observedAt: now })
        opened.repository.setListingSeries(browseId, 'GB.SOV')
        opened.repository.saveClassification(browseId, KEYS, 0.9, 'title', 0.2354, {})
    })

    const legacy = '/?band=any&sort=spot'
    const current = '/?band=any&order=vsspot'
    const byEnd = '/?band=any&order=ending'
    const pages = await fetchAll(opened, [legacy, current, byEnd])

    const ids = (body) => (body.match(/name="genuine" value="([^"]+)"/g) || []).join('|')
    assert.notStrictEqual(ids(pages[current].body), ids(pages[byEnd].body),
        'the fixture cannot tell the two orderings apart, so it proves nothing')
    assert.strictEqual(ids(pages[legacy].body), ids(pages[current].body),
        'an old sort=spot bookmark no longer produces the cheapest-vs-spot ordering')
    opened.db.close()
})
