'use strict'

const HTTP = require('node:http')
const RENDER = require('./render.js')
const IMAGES = require('./images.js')
const INSTRUMENTS = require('../catalogue/instruments.js')
const ALERT_RULES = require('../alerts/rules.js')
const LEARNED = require('../catalogue/learned.js')
const CLASSIFY = require('../catalogue/classify.js')
const RECLASSIFY = require('../catalogue/reclassify.js')
const PREMIUM = require('../analytics/premium.js')
const SERIES = require('../catalogue/series/index.js')
const FRESHNESS = require('../analytics/freshness.js')

const { escapeHtml, pct, gbp } = RENDER

/*  The headline metrics quote ONE coin type, so they have to say which
    metal that coin is measured against - "gold, £/oz" above a silver dollar
    would be quietly wrong in the most-read number on the page. */
const METAL_NAMES = { XAU: 'gold', XAG: 'silver', XPT: 'platinum', XPD: 'palladium' }

/*
    The local dashboard. Binds to loopback by default - it holds your
    buying intentions and there is no reason for it to be reachable from
    the network.
*/

/*
    Never serve one of these pages from a cache.

    Every page here is a live read of the store - prices that moved on the
    last sweep, a queue that shrinks as you work it, a rule you accepted ten
    seconds ago. There were no cache headers at all, which does not mean "do
    not cache": with no Cache-Control, no ETag and no Last-Modified, a browser
    falls back to heuristic caching and is entitled to reuse a response it
    already has. So a reload could legitimately show yesterday's premiums with
    nothing to say it was doing so.

    It cost a real hour: a deploy landed on the Pi, the server was verified to
    be serving the new markup, and the owner's browser kept showing the old
    page.

    no-store rather than no-cache, because no-cache still permits storing the
    response and revalidating - and there is no validator here to revalidate
    against. The pages are small and local; there is nothing to save.
*/
const HTML_HEADERS = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store, must-revalidate'
}

exports.start = function (opened, options) {

    const config = Object.assign({
        port: 34260,
        host: '127.0.0.1',
        /*  Where fetched thumbnails are kept. Null disables caching entirely,
            which is what the tests use: they must not write to a directory
            and they never fetch anything real. */
        imageCache: null
    }, options || {})

    const handler = (request, response) => {
        const url = new URL(request.url, 'http://' + config.host)

        const fail = (err) => {
            response.writeHead(500, HTML_HEADERS)
            response.end(RENDER.page('Error', '<h1>Something went wrong</h1><pre>' +
                escapeHtml(err.stack || err.message) + '</pre>', url.pathname))
        }

        if (request.method === 'POST') {
            /*  Bounded read. This binds to loopback and holds nothing but
                the owner's own decisions, but an unbounded body on a
                long-running process is a bad habit whatever the exposure. */
            const chunks = []
            let size = 0
            request.on('data', chunk => {
                size += chunk.length
                /*  A section form posts a denomination and a quantity for
                    every row it shows, so 250 rows is a few tens of KB - the
                    old 64KB cap would have silently truncated a bulk cull. */
                if (size > 2 * 1024 * 1024) { request.destroy(); return }
                chunks.push(chunk)
            })
            request.on('end', () => {
                try {
                    const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
                    const to = handlePost(opened, url.pathname, form)
                    /*  See Other, so a refresh after a decision does not
                        record it a second time. */
                    response.writeHead(303, { Location: to })
                    response.end()
                } catch (err) { fail(err) }
            })
            return
        }

        try {
            let html
            if (url.pathname === '/review') {
                html = reviewPage(opened, url)
            } else if (url.pathname === '/listings') {
                html = listingsPage(opened, url)
            } else if (url.pathname === '/img') {
                /*  Returns its own response - an image, not a page - so it
                    exits here rather than falling through to the HTML
                    writeHead below. */
                return IMAGES.handle(url, response, { cacheDir: config.imageCache })
            } else if (url.pathname === '/teach') {
                html = teachPage(opened, url)
            } else if (url.pathname === '/rule-confirm') {
                html = confirmRulePage(opened, url)
            } else if (url.pathname === '/rules') {
                html = rulesPage(opened, url)
            } else {
                html = marketPage(opened, url)
            }
            response.writeHead(200, HTML_HEADERS)
            response.end(html)
        } catch (err) { fail(err) }
    }

    const server = HTTP.createServer(handler)

    server.listen(config.port, config.host, () => {
        /*  Quiet for tests, which start this on an ephemeral port and would
            otherwise print a banner per request-set into the results. */
        if (config.quiet) { return }
        console.log('Coin Market dashboard: http://' + config.host + ':' + config.port)
        console.log('Press Ctrl+C to stop.')
    })

    /*
        A second address, for a reader that is not on this host's loopback.

        MetalHead runs in a container, and a container's "localhost" is its
        own, not the machine's. Proved rather than assumed: from inside that
        container the bridge gateway answers on ports that are bound to the
        host's LAN address and REFUSES 34260 - same bridge, same instant,
        different bind. So the network path is already open and the only
        thing missing is that this process is not listening where the
        container can see it.

        A SECOND listener rather than moving the first, because the first one
        is how the owner reaches this today over an SSH forward. Widening to
        0.0.0.0 would have done both in one line and is exactly what not to
        do: this app has no login of its own and its POST routes write, so it
        must not appear on the LAN.

        Failure here is deliberately NOT fatal. The bridge address does not
        exist on a laptop, and it changes if the docker network is recreated.
        The loopback listener is the one that must always come up, so a
        missing extra address is a warning and nothing more - the dashboard
        that works today keeps working even if this part is misconfigured.
    */
    const extras = []
    /*  Bound AFTER the primary is listening, and to the port it actually
        got. config.port is 0 in the tests, which means "any free port" - so
        binding the extras to config.port directly gave each of them a
        DIFFERENT random port, and the second address answered on a port
        nobody could have guessed. Live it would have worked by luck, because
        the port is fixed there. */
    server.once('listening', () => {
        const port = server.address().port
        for (const host of (config.alsoHosts || [])) {
            if (!host || host === config.host) { continue }
            const extra = HTTP.createServer(handler)
            extra.on('error', (err) => {
                /*  Dispose it. A server that failed to bind still holds a
                    handle, which keeps the process alive - harmless for a
                    daemon, but it stops `npm test` ever exiting and turns a
                    green suite into one that appears to hang. */
                try { extra.close() } catch (closeErr) { /* nothing to close */ }
                if (config.quiet) { return }
                console.log('  (not listening on ' + host + ': ' + err.code + ')')
            })
            extra.listen(port, host, () => {
                if (config.quiet) { return }
                console.log('  also on http://' + host + ':' + port)
            })
            /*  Never let an extra listener be the reason this process stays
                alive. The primary always holds the event loop, so an extra
                one serves for exactly as long as the service runs and not a
                moment longer - and a bind that neither succeeds nor fails
                (an unroutable address just sits there) cannot wedge a
                shutdown. That is what made `npm test` hang rather than
                finish, on a suite where every test had already passed. */
            extra.unref()
            extras.push(extra)
        }
    })

    /*  One close() shuts all of them. The caller is handed the primary
        server and reasonably expects closing it to stop the service; an
        extra listener left holding the port would make a restart fail with
        EADDRINUSE and look like something else entirely. */
    if (extras.length > 0) {
        const closePrimary = server.close.bind(server)
        server.close = (callback) => {
            for (const extra of extras) {
                try { extra.close() } catch (err) { /* already down */ }
            }
            return closePrimary(callback)
        }
    }

    return server
}

function marketPage (opened, url) {
    const { repository, view } = opened
    const minSample = Number(url.searchParams.get('min')) || 3

    /*
        Grouped by series, and capped WITHIN each one.

        The cap used to be global: instruments ordered by listing count and
        sliced to 40. With one coin that is a display choice; with two it is
        a silent eviction. 5,600 sovereign listings against a new series'
        first few hundred means every row of the newcomer falls off the
        bottom, and the page shows nothing at all for a coin it is tracking
        correctly. Not clutter - invisibility, and indistinguishable from the
        pack being broken.

        The series comes from the key rather than a column, because there are
        two of them and a few dozen rows: an index would be answering a
        question nobody is asking yet.
    */
    /*  40, which is what the global cap allowed a single series before this
        change - so a store with one coin in it shows exactly what it did.
        The table lives inside a collapsed fold, so length is cheap. */
    const PER_SERIES = 40
    const grouped = new Map()
    for (const row of repository.instruments(0, 3)) {
        if (row.listingCount < minSample) { continue }
        const found = SERIES.forKey(row.key)
        const id = found === null ? '?' : found.pack.id
        if (!grouped.has(id)) { grouped.set(id, { pack: found && found.pack, rows: [] }) }
        grouped.get(id).rows.push(row)
    }

    const curve = view.upliftCurve()

    /*  One block per series, each with its own cap and its own count of what
        the cap left out - a number that has to be visible, or a capped page
        and a complete one look identical. */
    const seriesBlocks = []
    for (const [id, group] of grouped) {
        const shownRows = group.rows.slice(0, PER_SERIES)
        const entries = shownRows.map(row => ({ row, market: view.forInstrument(row.key) }))
            .filter(e => e.market.fairValue.sufficient || e.market.liquidity.askSampleSize > 0)
        if (entries.length === 0) { continue }
        seriesBlocks.push({
            id,
            label: group.pack ? group.pack.label : id,
            metal: group.pack ? group.pack.metal : 'XAU',
            entries,
            hidden: group.rows.length - shownRows.length
        })
    }
    /*  Biggest series first, but every series present. */
    seriesBlocks.sort((a, b) => b.entries.length - a.entries.length)

    const markets = seriesBlocks.flatMap(b => b.entries)

    if (markets.length === 0) {
        return RENDER.page('Coin Market',
            '<h1>Coin Market</h1><p class="sub">Nothing tracked yet.</p>' +
            '<div class="card"><p>Run <code>node bin/cli.js demo</code> to see the tool working on a ' +
            'synthetic market, or configure eBay credentials and run a sweep.</p></div>', url.pathname)
    }

    /* Headline: the cost of paying the asking price, in money. */
    const headlineEntry = markets.find(e => e.market.fairValue.sufficient &&
        e.market.liquidity.askClearingSpread !== null) || markets[0]
    const headline = {
        entry: headlineEntry,
        metal: SERIES.metalForKey(headlineEntry.row.key)
    }
    const hm = headlineEntry.market
    const overpay = (hm.liquidity.askClearingSpread !== null && hm.spot !== null && hm.fineOz !== null)
        ? hm.liquidity.askClearingSpread * hm.fineOz * hm.spot.gbpPerOz
        : null

    const chartRows = markets
        .filter(e => e.market.fairValue.sufficient)
        .slice(0, 12)
        .map(e => ({
            label: INSTRUMENTS.displayName(e.row.key),
            p25: e.market.fairValue.p25,
            p50: e.market.fairValue.p50,
            p75: e.market.fairValue.p75,
            ask: e.market.liquidity.medianAskPremium,
            n: e.market.fairValue.n
        }))

    const instrumentRows = (entries) => entries.map(e => {
        const m = e.market
        const f = m.fairValue
        const l = m.liquidity
        return `<tr>
      <td><a href="/listings?key=${encodeURIComponent(e.row.key)}"
        title="See the individual listings behind these numbers, and dismiss any that are wrong"
        >${escapeHtml(INSTRUMENTS.displayName(e.row.key))}</a></td>
      <td class="mono">${f.n}</td>
      <td class="mono">${pct(f.p50)}</td>
      <td class="mono">${f.sufficient ? pct(f.p25) + ' – ' + pct(f.p75) : '—'}</td>
      <td class="mono">${pct(l.medianAskPremium)}</td>
      <td class="mono"><strong>${pct(l.askClearingSpread)}</strong></td>
      <td class="mono">${pct(l.sellThroughRate, 0)}</td>
      <td class="mono">${l.medianBidCount === null ? '—' : l.medianBidCount.toFixed(0)}</td>
      <td class="mono">${l.activeListings}</td>
      <td class="mono">${m.bidCeiling ? gbp(m.bidCeiling.maxBid) : '—'}</td>
    </tr>`
    }).join('')

    /*
        What has actually sold.

        Put in front of the instrument table rather than behind it: the
        clearing premium in that table is derived from exactly these rows, and
        a derived number is easier to trust when the thing it came from is
        visible above it.
    */
    /*  Per series: a format mix averaged across two markets describes
        neither. Computed after the blocks, so it covers exactly the series
        the page is showing. */
    const compositions = () => seriesBlocks.map(block => ({
        block,
        composition: repository.marketComposition(seriesBlocks.length > 1 ? block.id : null)
    }))
    /*
        FIFTEEN WAS TOO FEW, and the owner said so.

        These are the only prices in the tool that somebody actually paid -
        every clearing figure is built from them and nothing else - so seeing
        fifteen of them was seeing the least of the evidence. A hundred are
        fetched now and twenty-five shown, with the rest folded away: the fold
        is collapsed, and the thumbnails inside it are lazy, so the page costs
        no more to load than it did.
    */
    const SOLD_SHOWN = 25
    const SOLD_FETCHED = 100
    const sales = repository.recentSales(SOLD_FETCHED)
    /*  The real total, not the fetch. See soldCount. */
    const soldTotal = repository.soldCount()

    /*
        WHICH OF THESE ARE BUY-IT-NOW SALES, and what that is worth.

        Both halves are derived, because the first version of this note was
        derived in its trigger but hard-coded in its reason - it explained
        that no Buy-It-Now sale could be here because the resolver only asked
        about lots with an end time. COL-01 made that false within the day,
        and the note would have gone on asserting it. A disclosure whose
        reason cannot go stale is the only kind worth having.

        There are two honest states, and they are not the same:

        none at all - no Buy-It-Now lot has been resolved yet, so the
        clearing prices here are auction prices.

        none with a price - Buy-It-Now sales ARE being recorded, but every
        one so far went through Best Offer, and eBay does not publish what an
        accepted offer was: the lot simply ends showing its asking price.
        Nine of the first fifty-six resolved were exactly this. Treating them
        as sales at the asking price is the single easiest way to build a
        tool that lies to you confidently, so they are marked instead.
    */
    const binSales = sales.filter(sale => sale.saleType !== 'AUCTION')
    const binPriced = binSales.filter(sale => sale.censored !== 1)
    const noBuyItNowSales = sales.length > 0 && binSales.length === 0
    const noBuyItNowPrices = binSales.length > 0 && binPriced.length === 0

    /*  One form over both halves, so a decision can be made on a row inside
        the fold and a bulk tick can span the two. */
    const soldRow = (sale) => {
              /*
                  This table did its own arithmetic and got two things wrong.

                  It charged no buyer protection fee, so a 1968 sovereign that
                  cost its winner GBP 845.40 was reported at GBP 822.25 and
                  6.2% over spot when the true figure was 9.1% - MKT-01's
                  error, in the one place that never went through totalCost().

                  And it priced every sale against TODAY'S gold rather than
                  the gold price when the lot closed, so a premium changed
                  after the fact whenever spot moved. Every one of the 26
                  resolved outcomes has spot within tolerance at its own end
                  time, so there is nothing to gain by using today's.
              */
              /*  Its OWN metal. Without the second argument this asks for
                  gold, and every sold silver dollar reported about -97%: a
                  number so far out it read as a broken feed rather than a
                  wrong unit. spotAt refuses to substitute one metal for
                  another, so a gap in the silver feed leaves the cell blank
                  instead of quietly pricing it as gold. */
              const spotThen = opened.spotAt(sale.endedAt, sale.metal)
              const hammer = PREMIUM.listedCost(sale.finalPrice, sale.finalShipping)
              const paid = PREMIUM.totalCost(sale.finalPrice, sale.finalShipping)
              const premium = spotThen === null || !Number.isFinite(sale.fineOz) || sale.fineOz <= 0
                  ? null
                  : PREMIUM.premium(paid, sale.fineOz, spotThen.gbpPerOz)
              return '<tr>' +
                  /*  A WRONG SALE IS THE MOST EXPENSIVE WRONG ROW IN THE TOOL.
                      Every clearing figure, every fair value and every bid
                      ceiling is built from these and nothing else, so one
                      misfiled lot moves numbers the whole page is about - and
                      until now this was the one queue with no way to say so.
                      You could see it was wrong and had to go and find it
                      somewhere else to act. */
                  '<td>' + (sale.legacyId && !sale.verdict
                      ? '<input class="pick" type="checkbox" name="pick" value="' +
                        escapeHtml(sale.legacyId) + '" title="Select this sale for a bulk decision">'
                      : '<span class="pick-spacer"></span>') + '</td>' +
                  /*  The picture, on the one table that lacked it. These are
                      the most important rows in the tool - every clearing
                      figure is built from them and nothing else - and the
                      owner's own point stands here more than anywhere: the
                      thumbnails are as instructive as the titles. A coin you
                      can see is a comparable you can trust. */
                  '<td class="shot-cell">' + shot(sale.imageUrl, escapeHtml(sale.title || '')) + '</td>' +
                  '<td class="thin">' + escapeHtml(String(sale.endedAt || '').slice(0, 10)) + '</td>' +
                  '<td>' + (sale.itemWebUrl
                      ? '<a href="' + escapeHtml(sale.itemWebUrl) + '" target="_blank" rel="noopener">' +
                        escapeHtml(sale.title.slice(0, 58)) + '</a>'
                      : escapeHtml(sale.title.slice(0, 58))) + '</td>' +
                  /*  A censored sale went through Best Offer, and eBay
                      publishes only the asking price the listing ended on.
                      That is an UPPER bound on what changed hands, never the
                      figure itself, and the cell has to say so: the premium
                      column already refuses to guess, and a confident price
                      beside a blank premium reads as a display fault rather
                      than as the admission it is. */
                  '<td class="mono">' + (sale.censored === 1
                      ? '<span class="thin" title="The seller allowed offers on this lot. eBay ' +
                        'never says whether one was taken, so this is the asking price the ' +
                        'listing ended on and the buyer paid this or less. Most such lots sell ' +
                        'at the asking price; some do not, and nothing in eBay&#39;s API tells ' +
                        'the two apart.">at most ' +
                        gbp(paid) + '</span>'
                      : '<strong title="What the winner actually paid: ' +
                        gbp(hammer) + ' to the seller plus ' + gbp(paid - hammer) +
                        ' buyer protection fee to eBay. The premium beside it is measured on ' +
                        'this figure, against the price of its own metal when the lot closed.">' +
                        gbp(paid) + '</strong>') + '</td>' +
                  /*  HOW it sold, not just how contested it was. A bid count
                      is an auction idea; on a Buy-It-Now it is meaningless and
                      an em dash there reads as missing data rather than as a
                      different kind of sale. The owner could not tell the two
                      apart, which is the whole reason this cell changed. */
                  '<td class="mono">' + (sale.saleType === 'AUCTION'
                      ? (Number.isFinite(sale.finalBidCount) ? sale.finalBidCount : '—')
                      : sale.saleType === 'BEST_OFFER'
                          ? '<span class="badge" title="A Buy-It-Now whose seller accepted ' +
                            'offers. It may have sold at the asking price or below it, and eBay ' +
                            'publishes neither which nor how much.">Offers allowed</span>'
                          : '<span class="badge" title="Bought outright at the asking price. ' +
                            'A Buy-It-Now has no bids.">Buy-It-Now</span>') + '</td>' +
                  '<td class="mono">' + (sale.censored === 1
                      ? '<span class="thin">not published</span>'
                      : pct(premium)) + '</td>' +
                  /*  Reject only, and no denomination picker. The full
                      controls belong on the drill-down, where there is room
                      and where the denomination actually needs setting; here
                      the one question worth asking of a completed sale is
                      whether it is the coin it claims to be. */
                  '<td>' + soldControls(sale) + '</td>' +
                  '</tr>'
    }

    const soldTable = (rows) =>
        '<div class="card scroll"><table><thead><tr><th></th><th></th><th>Sold</th>' +
        '<th>Coin type</th><th>Price</th><th title="How it sold. A number is an ' +
        'auction and says how contested it was. A Buy-It-Now was bought outright at the ' +
        'asking price. Offers allowed means the seller took offers, so the lot went for ' +
        'that price or less and eBay will not say which.">How it sold</th>' +
        '<th>Premium over spot</th><th></th>' +
        '</tr></thead><tbody>' + rows.map(soldRow).join('') + '</tbody></table></div>'

    const salesHtml = sales.length === 0
        ? '<p class="thin">No completed sales resolved yet.</p>'
        : '<form method="post" action="/apply">' +
          '<input type="hidden" name="back" value="/">' +
          bulkBar(sales, 'A wrong sale here moves every clearing figure on the page, ' +
              'because they are all built from these rows and nothing else.') +
          soldTable(sales.slice(0, SOLD_SHOWN)) +
          (sales.length > SOLD_SHOWN
              ? '<details class="more"><summary>Show the other ' +
                (sales.length - SOLD_SHOWN) + ' completed sale' +
                (sales.length - SOLD_SHOWN === 1 ? '' : 's') + '</summary>' +
                soldTable(sales.slice(SOLD_SHOWN)) + '</details>'
              : '') +
          '</form>'

    /*
        Live opportunities: auctions on coins we can identify, priced at or
        near the spot value of their own gold.

        The previous definition wanted a projected final price, a sufficient
        fair value and a bid ceiling, and only looked inside the last two
        hours - between them those conditions meant no auction alert had ever
        fired in the tool's life, while the panel filled with Buy-It-Now lots
        whose only claim was sitting under a contaminated median. Every one
        the owner checked turned out not to be an opportunity.

        An auction opening at or under spot is worth seeing whether or not
        you bid: it can be bought at fair value, and watching where it
        finishes is how fair value gets measured in the first place. It needs
        no clearing history, which is the point - the tool has 26 sales, and
        a definition that needs a history is a definition that does nothing
        for months.
    */
    const NEAR_SPOT = 1.05
    /*  Judged against the last completed sweep, never the wall clock: 88.6%
        of all long gaps in this store begin at one collector outage, and a
        clock rule would have blanked these panels because of it. */
    const sweepAt = repository.lastSweepAt()
    const sort = url.searchParams.get('sort') === 'spot' ? 'spot' : 'ending'

    /*
        SPOT PER ROW, because this panel is not about one metal.

        It used to take a single gold price for the whole page and divide
        every lot by it. A GBP 74 silver dollar against gold reads 3% of its
        "spot value", so it sailed through a filter meant to admit things
        within 5% OF spot - and `sort=spot` then ranked every one of them
        above every sovereign. Measured on the live store: 217 of the 281
        admitted lots were Morgans, and the badge printed beside them said
        "+110%" because THAT number was already computed against silver. The
        panel was admitting on one metal and labelling on another.

        The single lookup was also a second, quieter bug: it sat behind
        `if (spot !== null)`, so a gap in the GOLD feed emptied the panel of
        silver coins too. Per row, a missing price for one metal costs only
        the rows made of it - and `.filter(Number.isFinite)` below already
        drops them, so no new branch is needed.
    */
    const now = new Date().toISOString()

    let opportunities = []
    let considered = 0
    {
        opportunities = repository.liveAuctions(500)
            .map(row => {
                const total = PREMIUM.totalCost(row.price, row.shipping)
                const spot = opened.spotAt(now, row.metal)
                /*  `metalValue`, not `gold` - it is silver half the time. */
                const metalValue = spot === null ? null : row.fineOz * spot.gbpPerOz
                return Object.assign({}, row, {
                    total,
                    metalValue,
                    ratio: metalValue > 0 ? total / metalValue : null
                })
            })
            .filter(row => Number.isFinite(row.ratio))
        considered = opportunities.length
        /*  An auction carries a real end time, so it cannot linger the way a
            Buy-It-Now can - but one the sweep has stopped seeing has usually
            been pulled, and telling you to bid on it is the same failure. */
        opportunities = opportunities.filter(row => FRESHNESS.isActionable(row.lastSeen, sweepAt))
        opportunities = opportunities
            .filter(row => row.ratio <= NEAR_SPOT)
            /*  A coin you have already judged not to be a sovereign is not an
                opportunity, whatever its price. */
            .filter(row => row.verdict !== LEARNED.VERDICT.NOT_SOVEREIGN)

        /*
            Ending soonest by default. The premium badge already tells you
            what a lot is worth; the ordering should tell you how long you
            have to act on it - a lot closing in twenty minutes is a decision
            now, and one closing on Thursday is not, whatever their prices.

            End times are ISO 8601 UTC and sort correctly as text, so no date
            parsing is needed. liveAuctions requires a non-null end_time.
        */
        opportunities.sort(sort === 'spot'
            ? (a, b) => a.ratio - b.ratio
            : (a, b) => String(a.endTime).localeCompare(String(b.endTime)))
    }

    const shown = opportunities.slice(0, 40)
    for (const row of shown) { row.sweepAt = sweepAt }

    /*  Keep any min= the owner arrived with, so switching the ordering does
        not silently widen the sample underneath them. */
    const sortParams = url.searchParams.get('min') ? { min: url.searchParams.get('min') } : {}
    const opportunitySort = shown.length === 0 ? '' : tabs('/', 'sort', [
        { value: 'ending', label: 'Ending soonest', isDefault: true },
        { value: 'spot', label: 'Cheapest against spot' }
    ], sort, sortParams)

    /*
        Buy-It-Now lots with a Best Offer button, asking close enough to
        where the coin actually clears that an offer might be taken.

        Kept apart from the auctions above on purpose: one is a thing to bid
        on and the other a thing to haggle over, and they need different
        nerve. The auction panel needs no clearing history; this one cannot
        exist without it, so it stays thin until the sales accumulate.
    */
    const offerEntries = []
    for (const entry of markets) {
        for (const alert of ALERT_RULES.evaluate(entry.market, curve, {})) {
            if (alert.rule !== 'BEST_OFFER_IN_REACH') { continue }
            offerEntries.push({
                alert,
                level: entry.row.level,
                key: entry.row.key,
                name: INSTRUMENTS.displayName(entry.row.key),
                liquidity: entry.market.liquidity,
                /*  So the row can state the offer in the same currency of
                    meaning as every other percentage on the site: premium
                    over the coin's own metal. */
                fineOz: entry.market.fineOz,
                spot: entry.market.spot
            })
        }
    }
    const offers = ALERT_RULES.dedupeByListing(offerEntries).slice(0, 20)

    const offerHtml = offers.length === 0
        ? '<p class="thin">Nothing to offer on right now. A lot only appears here when its coin ' +
          'type has enough completed sales to say where it clears &mdash; ' +
          markets.filter(e => e.market.fairValue.sufficient).length + ' of ' + markets.length +
          ' tracked types do today &mdash; and the ask is no more than a quarter above it.</p>'
        : '<form method="post" action="/apply">' +
          '<input type="hidden" name="back" value="/">' +
          bulkBar(offers.map(e => e.row),
              'A wrong coin here is worth more than a dismissal: it is setting ' +
              'the clearing price these offers are measured against.') +
          cappedQueue(offers, entry => {
              const a = entry.alert
              /*  Shaped for queueRow so the picture, the checkbox and the
                  verdict controls are the same ones as everywhere else -
                  UI-02: a wrong listing is dismissed where it is noticed. */
              const row = {
                  legacyId: a.legacyId, title: a.title, itemWebUrl: a.url,
                  imageUrl: a.imageUrl, price: a.askPrice, shipping: a.shipping,
                  buyingOptions: a.buyingOptions, instrumentKey: entry.key,
                  lastSeen: a.lastSeen, sweepAt, priced: 1, back: '/'
              }
              const days = entry.liquidity.medianDaysToSale
              const evidence = []
              /*  How long this type sits before it sells: a lot that has been
                  on the shelf for months is a seller who will listen. */
              if (Number.isFinite(days)) { evidence.push('typically ' + days.toFixed(0) + ' days to sell') }
              if (entry.liquidity.sellThroughRate !== null) {
                  evidence.push(pct(entry.liquidity.sellThroughRate, 0) + ' of them sell at all')
              }
              /*
                  Three numbers, three bases, and the row only shows two of
                  them - which is why the percentage read wrong.

                  The offer is an ITEM price, because that is what eBay's
                  offer box takes. The figure beside it on the row is the ask
                  WITH postage, like every other row on the site. So an offer
                  of GBP 813.64 sat next to an ask of GBP 853.05 and claimed
                  3.5%, while the two visible numbers say 4.6%. Both were
                  right about different things, which is worse than one being
                  wrong: nothing on screen let you tell which.

                  So the offer is now also stated with postage added, on the
                  same basis as the number beside it, and the percentage is
                  the one you can check by dividing them.
              */
              const postage = a.shipping || 0

              /*
                  THE PERCENTAGE HAD NO STATED BASIS, and the basis it used
                  was not the one the rest of the site uses.

                  Everywhere else a percentage on this site is premium over
                  spot. Here it was a discount off the seller's ask, rendered
                  in the same grey monospace with the bare word "under". The
                  owner read "0.5% under" as advice to lowball by half a
                  percent and reasonably asked why that number.

                  It was never advice. The offer is YOUR CEILING for this coin
                  type - the most it is worth paying given where the type
                  actually clears - so the gap to their ask is a by-product,
                  not a negotiating stance. A small gap does not mean make a
                  small offer; it means this lot is already priced near your
                  limit and there is little room in it. Leading with that
                  by-product buried the only figure that decides anything.

                  So the premium comes first, on the same basis as the ask
                  beside it and as every other percentage on the site, and the
                  gap follows saying plainly what it is measured against.
              */
              const offerAllIn = PREMIUM.totalCost(a.suggestedOffer, postage)
              const offerPremium = (entry.spot === null || entry.spot === undefined ||
                                    !Number.isFinite(entry.fineOz) || entry.fineOz <= 0)
                  ? null
                  : PREMIUM.premium(offerAllIn, entry.fineOz, entry.spot.gbpPerOz)

              const cell = '<span class="badge good" title="What to type into the offer box: ' +
                  'your ceiling for a ' + escapeHtml(entry.name) + ', less postage, with the ' +
                  'buyer protection fee eBay adds on top already taken out. ' +
                  gbp(a.suggestedOffer) + ' + ' + gbp(postage) + ' postage + fee = ' +
                  gbp(PREMIUM.totalCost(a.suggestedOffer, postage)) + ' all-in, against ' +
                  gbp(a.currentTotal) + ' all-in at the asking price.' +
                  (evidence.length ? ' ' + evidence.join('; ') + '.' : '') +
                  '">offer ' + gbp(a.suggestedOffer) + '</span> ' +
                  '<span class="thin mono">' +
                  (postage > 0 ? '+ ' + gbp(postage) + ' post &middot; ' : '') +
                  (offerPremium === null
                      ? ''
                      : '<span title="What this offer would cost you over the value of the gold ' +
                        'in the coin, postage and buyer protection fee included - the same measure ' +
                        'as every other percentage on this site.">' + pct(offerPremium) +
                        ' over spot</span> &middot; ') +
                  '<span title="How far your ceiling happens to sit below what they are asking. ' +
                  'This is a by-product of the offer, not the reason for it: the offer is your ' +
                  'ceiling for this coin type, so a small gap means the lot is already priced ' +
                  'near your limit.">' + pct(a.discount) + ' below their ask</span></span>'
              return queueRow(row, cell)
          }, 8, n => 'Show the other ' + n + ' offer' + (n === 1 ? '' : 's')) +
          '</form>'

    const opportunityVerdict = newPlausibilityCell(opened.spotAt)
    const opportunityHtml = shown.length === 0
        ? '<p class="thin">No live auction is currently at or near the spot value of its metal. ' +
          considered + ' were checked.</p>'
        : '<form method="post" action="/apply">' +
          '<input type="hidden" name="back" value="/">' +
          bulkBar(shown, 'Tick anything that is not what it says it is; it leaves this ' +
              'panel and every statistic at once.') +
          cappedQueue(shown, row => queueRow(row, opportunityVerdict(row)), 10,
              n => 'Show the other ' + n + ' auction' + (n === 1 ? '' : 's')) +
          '</form>'

    const censored = markets.reduce((sum, e) => sum + e.market.liquidity.censoredOutcomes, 0)
    const spotGaps = markets.reduce((sum, e) => sum + e.market.spotGaps, 0)

    /*  One table per series. A single table ordered by listing count would
        bury a new coin under an established one, which is the same eviction
        the cap used to cause - just further down the page instead of off it. */
    const TABLE_HEAD = `<thead><tr>
      <th>Coin type</th>
      <th title="Completed auction sales this figure is built from, over 180 days and weighted so a sale 45 days old counts half as much as today's. Under three and the clearing columns stay blank.">Sales</th>
      <th title="Where auctions actually clear, as a premium over the coin's gold content. Sold auctions only, and never accepted Best Offers, whose price eBay does not publish.">Clears at</th>
      <th title="The middle half of those clearing prices: a quarter of sales went below the first number, a quarter above the second. A wide band means the price depends on the coin, not the type.">p25&ndash;p75</th>
      <th title="What the Buy-It-Now shelf is asking right now, as a premium over gold. Fixed-price listings only - a running auction has no asking price, just a bid so far.">Asks</th>
      <th title="Asks minus Clears at, in percentage points. What paying a Buy-It-Now costs you over waiting for an auction - and the room you have to make an offer.">Spread</th>
      <th title="Of the lots that ENDED in the last 90 days, the share that sold. Low means the shelf is priced above what anyone will pay. A seller who relists doggedly pushes this down.">Sell-through</th>
      <th title="Median number of bids on auctions that got at least one, over 90 days. Auctions that ended with no bids at all are excluded, so this says how contested a lot is once bidding starts - not how often it starts.">Bids</th>
      <th title="Listings on sale right now: not ended, and seen by a sweep within the last 24 hours. Counts auctions as well as Buy-It-Now, so it is usually larger than the sample behind Asks.">Live</th>
      <th title="The most you should BID, from the clearing distribution at your target quantile. This is the number to type into eBay: the buyer protection fee eBay adds on top has already been taken out of it, so winning at this bid lands you on fair value rather than 2-5% above it. Blank when there are too few sales to say.">Bid up to</th>
    </tr></thead>`
    const compositionBlocks = compositions().map(({ block, composition }) => {
        const live = composition.liveBin + composition.liveAuction
        const completed = composition.auctionSold + composition.auctionUnsold
        return '<div class="card">' +
            (seriesBlocks.length > 1
                ? '<h3 style="margin:0 0 10px">' + escapeHtml(block.label) + '</h3>' : '') +
            RENDER.compositionChart(composition) +
            '<p class="thin" style="margin:14px 0 0">' +
            '<strong>Buy-It-Now outcomes are not observed at all.</strong> A Buy-It-Now listing ' +
            "is Good-'Til-Cancelled and carries no end time, so it never becomes eligible for " +
            'outcome resolution &mdash; every one of the ' + completed + ' completed lots here ' +
            'is an auction. So the clearing prices describe the auction market, the asking ' +
            'prices are ' + (live > 0 ? Math.round(100 * composition.liveBin / live) : 0) + '% ' +
            'Buy-It-Now, and the spread between them compares two markets rather than two ends ' +
            'of one.' +
            (composition.binVanished > 0
                ? ' <strong>' + composition.binVanished + '</strong> Buy-It-Now listings have ' +
                  'gone quiet without being resolved; each has either sold or been withdrawn ' +
                  'and we cannot yet tell which.'
                : '') +
            '</p></div>'
    }).join('')

    const instrumentTables = seriesBlocks.map(block =>
        (seriesBlocks.length > 1
            ? '<h3 style="margin:18px 0 8px">' + escapeHtml(block.label) + '</h3>'
            : '') +
        '<div class="card scroll"><table>' + TABLE_HEAD +
        '<tbody>' + instrumentRows(block.entries) + '</tbody></table></div>' +
        (block.hidden > 0
            /*  Named, not hidden. A capped table and a complete one look
                identical, and the ones left out are the smallest - which is
                where a coin type nobody has looked at yet would sit. */
            ? '<p class="thin" style="margin:-10px 0 14px">' + block.hidden +
              ' more coin type' + (block.hidden === 1 ? '' : 's') + ' in this series ' +
              (block.hidden === 1 ? 'is' : 'are') + ' tracked but not listed here; the ones with ' +
              'the most listings are shown first.</p>'
            : '')
    ).join('')

    const body = `
<h1>Coin Market</h1>
<p class="sub">What sovereigns actually sell for, measured against their gold content.</p>
${countryPicker(repository)}

<div class="card hero">
  <div>
    <div class="n">${overpay === null ? '—' : gbp(overpay)}</div>
    <div class="l">what paying the asking price costs you, per coin, versus where auctions clear
      — ${escapeHtml(INSTRUMENTS.displayName(headline.entry.row.key))}</div>
  </div>
  <div>
    <div class="n">${pct(hm.fairValue.p50)}</div>
    <div class="l">auctions clear at this premium over spot
      ${hm.fairValue.sufficient ? '(n=' + hm.fairValue.n + (hm.fairValue.band && hm.fairValue.band.wide ? ', thin sample' : '') + ')' : ''}</div>
  </div>
  <div>
    <div class="n">${pct(hm.liquidity.medianAskPremium)}</div>
    <div class="l">buy-it-now sellers ask this</div>
  </div>
  <div>
    <div class="n">${hm.spot === null ? '—' : gbp(hm.spot.gbpPerOz)}</div>
    <div class="l">${METAL_NAMES[headline.metal] || headline.metal}, £/oz, from your metals.dev feed</div>
  </div>
</div>


<div class="jump">
  <a href="#auctions">Auctions near spot <span class="n">${shown.length}</span></a>
  <a href="#offers">Open to an offer <span class="n">${offers.length}</span></a>
  <a href="#sold">Actually sold <span class="n">${sales.length}</span></a>
  <a href="#evidence">The evidence behind these</a>
  <a href="/review">Needs review</a>
</div>

<h2 id="auctions">Live auctions at or near spot (${shown.length})</h2>
<p class="thin">Auctions on coins the tool can identify, whose current bid is within 5% of the
spot value of the metal in them. Worth watching even if you do not bid: where one of these
finishes is how fair value gets measured.
${considered > 0 ? considered + ' live auctions were checked.' : ''}</p>
${opportunitySort}
${opportunityHtml}

<h2 id="offers">Buy-It-Now, open to an offer (${offers.length})</h2>
<p class="thin">Lots with a Best Offer button, asking no more than a quarter above where their coin
type actually clears. The Best Offer button says a seller will listen, not that the price is
keener &mdash; measured here, these lots ask a shade MORE than rigid Buy-It-Nows &mdash; so the
suggested figure comes from your own ceiling rather than from their asking price.</p>
${offerHtml}

<h2 id="sold">What has actually sold (${soldTotal})</h2>
<p class="thin">Completed auctions with a hammer price. Every clearing figure on this page is
built from these and nothing else &mdash; an asking price is an opinion, and this is what somebody
paid. ${soldTotal < 30
    ? 'There are not many yet: they only arrive as lots this tool was already watching come to a close.'
    : ''}${soldTotal > sales.length
    ? ' Showing the ' + sales.length + ' most recent.'
    : ''}</p>
${noBuyItNowSales
    ? '<p class="thin costnote"><strong>Every one of these is an auction.</strong> No Buy-It-Now ' +
      'sale has been resolved yet, so the clearing prices on this page are auction prices ' +
      '&mdash; the honest measure of what a coin fetches, but not the whole market.</p>'
    : ''}${noBuyItNowPrices
    ? '<p class="thin costnote"><strong>The Buy-It-Now sales here have no exact price.</strong> ' +
      'Every one of them allowed offers, and eBay never says whether an offer was taken &mdash; ' +
      'so each of those lots sold at its asking price or below it, with no way to tell which. ' +
      'They are marked <em>at most</em>. A plain Buy-It-Now, with no offers allowed, does carry ' +
      'an exact price and will appear here as one.</p>'
    : ''}
${salesHtml}

<h2 id="evidence" class="sub" style="margin:34px 0 4px">The evidence behind these</h2>

<details class="fold">
  <summary>Where each coin type clears, against what sellers ask
    <span class="why">the gap you are trying to buy inside</span></summary>
  <div class="card">${RENDER.premiumChart(chartRows)}</div>
</details>

<details class="fold">
  <summary>Every tracked coin type <span class="why">${markets.length} across ${seriesBlocks.length} series, with what to bid</span></summary>
  ${instrumentTables}
</details>

<details class="fold">
  <summary>What the tracked market is made of
    <span class="why">and the hole in it</span></summary>
  ${compositionBlocks}
</details>

<details class="fold">
  <summary>How much auctions rise before the hammer
    <span class="why">why an alert can fire while you can still act</span></summary>
  <div class="card">
    ${RENDER.upliftChart(curve)}
    <p class="thin">Learned from this tool's own snapshots. It is why an alert can fire while
    you can still act, instead of after the lot has gone.</p>
  </div>
</details>

<details class="fold">
  <summary>What this cannot see
    <span class="why">${censored} sales withheld${spotGaps > 0 ? ', ' + spotGaps + ' unpriced' : ''}</span></summary>
  <div class="card">
    <p class="thin" style="margin:0">
      <strong>${censored}</strong> ended listings are excluded from clearing prices because eBay never
      publishes what an accepted Best Offer sold for &mdash; counting those at list price would
      systematically overstate the market.
      ${spotGaps > 0 ? '<br><strong>' + spotGaps + '</strong> sales have no premium because the gold feed had a gap at the moment they closed; they are withheld rather than priced against a stale figure.' : ''}
    </p>
  </div>
</details>`

    return RENDER.page('Coin Market', body, url.pathname)
}

/*
    What the price implies about whether this is a sovereign at all.

    Gold has a floor, so a "gold sovereign" offered below its own metal
    content is not a coin needing a decision - it is something else wearing
    the word. Shared by the review queue and the drill-down.

    Where the classifier managed a best guess, its denomination gives the
    right spot to measure against. Where it did not, the quarter is used -
    the smallest sovereign struck - so the verdict is the conservative one.
*/
/*
    Takes the spot LOOKUP, not one price.

    It used to take a single figure - gold - and measure every row against
    it. With one series that was the same thing; with two it valued a Morgan
    dollar against the gold price, which reads about sixty-six times too
    dear, and fell back to a QUARTER SOVEREIGN's weight when it could not
    read a denomination. Both halves of the calculation belonged to a coin
    the row was not.

    So the metal and the fallback denomination now both come from the row's
    own series, and a row whose series has no spot data gets a blank rather
    than another metal's price.
*/
/*  A premium with its sign always shown, because the sign is the point:
    +30% and -30% are opposite findings and a bare "30%" is neither. Rounded
    to whole points - the precision beyond that is not real. */
function signedPct (premium) {
    if (premium === null || premium === undefined || !Number.isFinite(premium)) { return '—' }
    const points = Math.round(premium * 100)
    return (points > 0 ? '+' : (points < 0 ? '−' : '')) + Math.abs(points) + '%'
}

function newPlausibilityCell (spotAt) {
    const PLAUSIBILITY = require('../analytics/plausibility.js')
    const now = new Date().toISOString()

    return (row) => {
        const total = (row.price || 0) + (row.shipping || 0)

        /*  The row's own series, from whatever it carries: the listing's
            attribution, the key it was filed under, or the tool's best
            guess at one. */
        const key = row.instrumentKey || row.bestGuess || null
        const found = key === null ? null : SERIES.forKey(key)
        const pack = (found && found.pack) ||
            (row.series ? SERIES.get(row.series) : null) ||
            SERIES.defaultPack()

        const spot = spotAt(now, pack.metal)
        if (spot === null || spot === undefined) { return '' }

        let fineOz = Number.isFinite(row.fineOz) ? row.fineOz : null
        let measuredAgainst = 'the coin it is classified as'
        let assumed = false

        if (fineOz === null) {
            /*  The smallest denomination this SERIES mints, as a floor - a
                quarter sovereign is not a floor for a silver dollar. */
            const names = Object.keys(pack.denominations)
            const guessed = typeof key === 'string'
                ? key.split('.').find(part => pack.denominations[part] !== undefined)
                : undefined
            const smallest = names.reduce((a, b) =>
                pack.denominations[a].fineOz <= pack.denominations[b].fineOz ? a : b)
            const denomination = pack.denominations[guessed] || pack.denominations[smallest]
            fineOz = denomination.fineOz
            measuredAgainst = denomination.label
            assumed = guessed === undefined
        }

        /*  A running auction is judged differently: its current bid is not a
            claim about the coin, it is an opening position. */
        const running = /AUCTION/i.test(String(row.buyingOptions || '')) &&
            row.endTime !== null && row.endTime !== undefined &&
            new Date(row.endTime).getTime() > Date.now()

        /*  The key carries both the series and the pool, and the thresholds
            come from those: what counts as an odd price for a bullion
            sovereign is not what counts for a key-date silver dollar. */
        const v = PLAUSIBILITY.assess(total, fineOz, spot.gbpPerOz, {
            liveAuction: running,
            key,
            series: pack.id
        })
        if (v === null) { return '' }

        /*  The quarter fallback is a floor, and a floor only works downwards.
            Anything under a quarter's gold cannot be any sovereign, whatever
            the title says - that direction is sound. Upwards it is nonsense:
            an ordinary full sovereign measured against a quarter reads 400%
            and gets labelled "far above spot - rarity or error", which put
            that badge on 1,346 rows and made the column worth ignoring.

            So when the denomination is a guess, only the impossible verdict
            is reported. Saying nothing is better than saying something
            confident and wrong. */
        if (assumed && !v.underSpot) {
            return '<span class="thin">denomination unknown</span>'
        }
        const tone = v.impossible ? 'critical' : (v.verdict === 'AUCTION_UNDER_SPOT' ? '' : 'good')
        return '<span class="badge ' + tone + '" title="' +
            escapeHtml(v.detail + ' Measured against ' + measuredAgainst +
                (assumed ? ', the smallest this series mints, because the denomination is unknown.' : '.')) +
            /*  A premium, signed, not a percentage OF spot. Every other
                figure in the tool is a premium - clearing premium, asking
                premium, spread - so "130% of spot" was the one number a
                reader had to convert before it could be compared with the
                column next to it. */
            '">' + escapeHtml(v.label) + '</span> <span class="thin mono">' +
            signedPct(v.premium) + '</span>'
    }
}

/*
    Auction / Buy-It-Now, as three links. Shared by the review queue and the
    drill-down so the control looks and behaves the same in both, and so
    neither can drift into filtering on a different column from the other.
*/
/*  One tab strip, used by every filter and sort control on the site. The
    default option carries no query parameter, so a plain URL is always the
    default view rather than a redirect to a decorated one. */
function tabs (basePath, param, options, current, params) {
    return '<div class="tabs">' +
        options.map(option => {
            const query = Object.assign({}, params || {})
            if (!option.isDefault) { query[param] = option.value }
            else { delete query[param] }
            const search = Object.keys(query)
                .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
                .join('&')
            const href = basePath + (search === '' ? '' : '?' + search)
            /*  A tab label has room for a number and nothing else, so what
                the number MEANS goes in the tooltip rather than in prose
                beside the strip. */
            const title = option.title === undefined || option.title === null
                ? ''
                : ' title="' + escapeHtml(option.title) + '"'
            return option.value === current
                ? '<span class="tab on"' + title + '>' + escapeHtml(option.label) + '</span>'
                : '<a class="tab" href="' + escapeHtml(href) + '"' + title + '>' +
                  escapeHtml(option.label) + '</a>'
        }).join('') + '</div>'
}

/*
    A long list of lots, capped rather than truncated.

    The market page ran to 55 lot rows and 163KB, and the two panels worth
    acting on were 68% of that - stacked, so the second began roughly 3,900px
    below the first and the owner reached it with the browser's text search.
    The rows past the cap are still here and still inside the same form, so a
    bulk decision still covers them; they are just folded away.
*/
function cappedQueue (rows, render, visible, moreLabel) {
    const head = rows.slice(0, visible)
    const tail = rows.slice(visible)
    const card = list => '<div class="card"><div class="queue">' + list.map(render).join('') + '</div></div>'
    if (tail.length === 0) { return card(head) }
    return card(head) +
        '<details class="more"><summary>' + escapeHtml(moreLabel(tail.length)) + '</summary>' +
        card(tail) + '</details>'
}

/*
    Auctions first, and by default.

    An auction that ended is a price somebody paid; a Buy-It-Now that is
    still listed is a price somebody hoped for. The tool holds 106 resolved
    outcomes and every one of them is an auction, so the auction tab is the
    only view built entirely on evidence - which makes it the right thing to
    land on, not merely one option of three.

    The counts are what keep that honest. Buy-It-Now is 89% of the sovereign
    market by listing count, so opening on auctions hides most of what is on
    sale; a tab reading "Buy-It-Now (304)" says so on every page view, which
    a default with a bare label would not.
*/
const SALE_DEFAULT = 'auction'

function saleTabs (basePath, current, params, counts) {
    const n = (key) => counts === undefined || counts === null ||
        !Number.isFinite(counts[key]) ? '' : ' (' + counts[key] + ')'
    return tabs(basePath, 'sale', [
        { value: 'auction', label: 'Auctions' + n('auction'), isDefault: true },
        { value: 'bin', label: 'Buy-It-Now' + n('bin') },
        { value: 'all', label: 'Everything' + n('all') }
    ], current, params)
}

/*
    Which sale filter a URL is asking for.

    'all' has to be accepted EXPLICITLY now. tabs() drops the query parameter
    for whichever option is the default, so before this change a bare URL and
    ?sale=all were the same request; now a bare URL means auctions and
    "Everything" has to say so. Anything unrecognised falls to the default
    rather than to 'all', so a hand-edited URL cannot land on a view no tab
    is showing as current.
*/
function saleFrom (url) {
    const raw = url === undefined || url === null ? null : url.searchParams.get('sale')
    return ['auction', 'bin', 'all'].includes(raw) ? raw : SALE_DEFAULT
}

/*
    The one control a completed sale needs.

    Deliberately NOT `callControls`. That offers a denomination picker and a
    quantity spinner, which belong on the drill-down where a coin is being
    identified; a sale that has already happened is being CHECKED, and the
    only question worth a column here is whether it is the coin it claims to
    be. The market page was cut from 11,144px to 4,261px once already for
    exactly this kind of creep (UI-14), and eight controls per row across a
    hundred rows is how that comes back.

    A settled row shows what you said and offers to take it back, so a
    decision made here does not read as a row that ignored you.
*/
function soldControls (sale) {
    if (!sale.legacyId) { return '<span class="thin">&mdash;</span>' }
    const id = escapeHtml(sale.legacyId)
    if (sale.verdict) {
        const said = sale.verdict === LEARNED.VERDICT.TRACKED
            ? 'genuine'
            : SERIES.words(sale).notOne.toLowerCase()
        return '<span class="settled thin">' + escapeHtml(said) + '</span> ' +
            '<button class="plain" name="undo" value="' + id + '" ' +
            'title="Forget this decision">undo</button>'
    }
    return '<button class="no" name="reject" value="' + id + '" ' +
        'title="This is not the coin it says it is - remove it from every clearing figure">' +
        escapeHtml(SERIES.words(sale).notOne) + '</button>'
}

/*
    The two buttons that act on a ticked batch, named after the coin they act on.

    FOUR COPIES OF THIS EXISTED - the offers panel, the auctions panel, the
    review queue and the drill-down - identical but for a trailing sentence,
    and all four said "Not a sovereign" over whatever coin was actually on
    screen. Collapsing them is not tidiness: it is what makes the wording a
    property of the ROWS rather than of whoever wrote the fourth copy.

    The two front-page panels draw across every series by construction, so
    they get the mixed wording and that is the honest answer rather than a
    fallback. The review queue and the drill-down are each narrowed to one
    coin already, so both get better wording than they had, not merely
    non-sovereign wording.

    The VALUES are untouched and must stay untouched: they are TRACKED and
    NOT_TRACKED on the wire and in the store, and were migrated to those
    spellings long ago. Only the label a person reads is series-specific.
*/
function bulkBar (rows, hint) {
    const words = SERIES.words(rows)
    return '<div class="bulkbar">' +
        '<button class="no" name="bulk" value="' + LEARNED.VERDICT.NOT_TRACKED + '">' +
        escapeHtml(words.notOne) + ' &mdash; selected</button>' +
        '<button class="yes" name="bulk" value="' + LEARNED.VERDICT.TRACKED + '">' +
        'Genuine &mdash; selected</button>' +
        (hint ? '<span class="thin">' + hint + '</span>' : '') +
        '</div>'
}

/*
    Ending soonest first, which is the only order a bid can act on.

    Re-sorted HERE and never in the SQL, and the reason is the row limit.
    listingsForInstrument orders by `COALESCE(o.sold,0) DESC, live DESC,
    totalCost DESC` and takes 500: the dearest live lots are the ones
    admitted, and the dearest lot is the one most likely to be distorting the
    number this page exists to explain. Making end time the SQL key would
    silently change WHICH 500 rows come back and drop exactly those outliers
    - a sort that quietly edits the sample rather than reordering it.

    Untimed lots last, dearest-first among themselves. A Buy-It-Now is
    Good-'Til-Cancelled: putting it in the timed sequence invents a deadline
    it does not have, and putting it first leads with the least urgent lot in
    the list. This matches activeListings' own `ORDER BY end_time IS NULL,
    end_time ASC`.

    The null branches are explicit rather than load-bearing, and it is worth
    being exact about which. A bare String(a.endTime).localeCompare(...)
    happens to produce the same order on today's data: "null" sorts after
    "2026", so untimed lots land last anyway, and two untimed lots compare
    equal and keep the dearest-first order the SQL already gave them. So this
    is not guarding against a bug that exists - it is refusing to depend on
    two coincidences, that ISO years sort below the word "null" and that the
    incoming order happens to be the one wanted. Neither survives a change to
    the SQL ORDER BY, and neither is visible from the call site.

    Raw < and > rather than localeCompare on the timed branch, because
    localeCompare is locale-sensitive and ISO-8601 already sorts
    lexicographically in the order it means.
*/
function byEndingSoonest (a, b) {
    const at = a.endTime || null
    const bt = b.endTime || null
    if (at === null && bt === null) { return (b.totalCost || 0) - (a.totalCost || 0) }
    if (at === null) { return 1 }
    if (bt === null) { return -1 }
    return at < bt ? -1 : (at > bt ? 1 : 0)
}

/*  A live listing is judged on how it is offered, a completed one on how it
    actually sold. The review queue holds both. */
function matchesSale (row, sale) {
    if (sale !== 'auction' && sale !== 'bin') { return true }
    const wasAuction = row.saleType !== null && row.saleType !== undefined
        ? row.saleType === 'AUCTION'
        : /AUCTION/i.test(String(row.buyingOptions || ''))
    return sale === 'auction' ? wasAuction : !wasAuction
}

function reviewPage (opened, url) {
    /*  Say what the last click did. A batch decision is the one action here
        where you cannot see the result by looking at the row you pressed. */
    const appliedCount = url === undefined ? 0 : Number(url.searchParams.get('applied'))
    const appliedVerdict = url === undefined ? null : url.searchParams.get('verdict')
    const applied = Number.isFinite(appliedCount) && appliedCount > 0
        ? '<div class="card" style="border-color:var(--good)"><p style="margin:0">' +
          '<strong>' + appliedCount + '</strong> listing' + (appliedCount === 1 ? '' : 's') +
          ' marked ' + (appliedVerdict === LEARNED.VERDICT.TRACKED
              ? 'genuine' : SERIES.words(chosen).notOne.toLowerCase()) +
          '. <span class="thin">Each one is undoable from its own row.</span></p></div>'
        : ''

    /*  The whole queue, not a page of it - it is sorted by impact below and
        truncating before sorting would hide exactly the rows that matter. */
    /*  Fetch one more than we will admit to, so a full page can tell the
        difference between "that is all of them" and "that is where I
        stopped". A queue that silently ends 823 rows early is the same
        class of error as a listing silently dropped from the statistics -
        you cannot act on what you are not told is missing. */
    const QUEUE_LIMIT = 6000

    /*
        One coin at a time.

        A queue that alternates sovereigns and silver dollars cannot be
        worked through in one pass: every row makes you change what you are
        looking for, and the judgements are different judgements - a
        mintmark means one thing on one and another on the other.

        So the queue is always narrowed to a single series, and never
        silently: the tabs carry every series' count, so choosing one can
        never hide how much is waiting under another. The default is
        whichever has the most, because that is the pile worth starting on.
    */
    const sale = saleFrom(url)

    const seriesCounts = opened.repository.reviewCountsBySeries(sale)
    const requested = url === undefined ? null : url.searchParams.get('coin')
    /*
        Default to a real coin, never to the unattributed pile.

        '?' is usually the largest group and almost none of it is work: on
        the live store it was 3,206 rows of which 2,986 were already excluded
        by category or country and sit there only so a bad rule stays
        visible. Landing on that is landing on a page of jewellery and
        fishing reels. The tab is still there, with its count, for the 220
        that genuinely are a question.
    */
    /*  Biggest pile THE CURRENT FILTER WILL SHOW. seriesCounts is ordered
        by the filtered count, so this is the first real series - picking by
        the unfiltered total could land you on the largest queue and
        simultaneously its emptiest tab. */
    const realSeries = seriesCounts.filter(c => c.series !== '?')
    const fallback = (realSeries[0] || seriesCounts[0] || {}).series || null
    const chosen = seriesCounts.some(c => c.series === requested) ? requested : fallback

    /*  A single group needs no chooser - one tab is not a choice. */
    /*  Each filter carries the other. Without that, switching one silently
        resets the other: picking "auctions only" while looking at silver
        dollars dropped the coin and served sovereign auctions, which reads
        as the tab not working rather than as a lost parameter. */
    const seriesTabs = seriesCounts.length < 2 ? '' : tabs('/review', 'coin',
        seriesCounts.map(c => {
            const pack = c.series === '?' ? null : SERIES.get(c.series)
            return {
                value: c.series,
                /*  c.n, not c.total: the label must be the number of rows
                    the tab opens on. Under the auction default the two are
                    an order of magnitude apart. */
                label: (pack ? pack.label : 'Not attributed') + ' (' + c.n + ')',
                title: c.n === c.total
                    ? c.total + ' waiting under this coin'
                    : c.n + ' of ' + c.total + ' waiting under this coin match the ' +
                      'current sale filter',
                /*  No default tab: a bare /review shows the biggest pile,
                    and the tab for it is the one marked current, so the URL
                    and the page always agree about what you are looking at. */
                isDefault: false
            }
        }), chosen, { sale })

    const fetched = opened.repository.reviewQueue(QUEUE_LIMIT + 1, chosen)
    const truncated = fetched.length > QUEUE_LIMIT
    const rows = truncated ? fetched.slice(0, QUEUE_LIMIT) : fetched
    const verdictCell = newPlausibilityCell(opened.spotAt)

    const filtered = rows.filter(r => matchesSale(r, sale))

    /*  Free here, unlike on the drill-down: this page fetches the queue
        unfiltered and narrows it in JS, so the other tabs' sizes are already
        in hand. Counted over `rows` rather than the store, so the labels
        describe the same set the sections are drawn from - including when
        the 6,000-row cap has bitten. */
    const queueSaleCounts = {
        all: rows.length,
        auction: rows.filter(r => matchesSale(r, 'auction')).length,
        bin: rows.filter(r => matchesSale(r, 'bin')).length
    }
    /*  Back to the queue you were actually working through, both filters
        intact. Landing on a different one after every verdict is the same
        lost-parameter bug as the tabs, one click later. */
    const backParams = []
    if (chosen !== null) { backParams.push('coin=' + encodeURIComponent(chosen)) }
    /*  ALWAYS stated, never omitted-when-default. The old form dropped
        the parameter for 'all'; now that a bare URL means auctions, dropping
        it would send you from the Everything view back into the auction view
        after every verdict - the same lost-parameter bug the tabs had, one
        click later. */
    backParams.push('sale=' + encodeURIComponent(sale))
    const back = '/review' + (backParams.length === 0 ? '' : '?' + backParams.join('&'))

    const excluded = filtered.filter(r => (r.reason || '').startsWith('EXCLUDED'))
    const uncertain = filtered.filter(r => !(r.reason || '').startsWith('EXCLUDED'))

    /*  The ones still counted in a market number lead, because they are the
        only ones that can be making the front page wrong. */
    const affecting = uncertain.filter(r => r.priced)
    const inert = uncertain.filter(r => !r.priced)

    /*
        One form per section, so a decision can cover many rows.

        The intended pass is: tick down the left-hand edge, hit one button to
        cull; then go back over what is left setting denomination and quantity
        where the row asks for it; then tick and accept. The per-row buttons
        still work for one-offs, and the bar is repeated at the foot so a long
        section does not mean scrolling back up to act on it.
    */
    /*  The queue is already narrowed to one coin by the tab above it, so
        this names that coin rather than the mixed wording the front page
        needs. `chosen` is the series id, or null on the unattributed tab -
        where the mixed wording is exactly right. */
    const bar = (where) => bulkBar(chosen, where === 'top'
        ? 'Tick down the left, then one click. Anything you have not ticked is untouched.'
        : '')

    const list = (items, empty, cap) => {
        if (items.length === 0) { return '<p class="thin">' + empty + '</p>' }
        const shown = items.slice(0, cap || 250)
        return '<form method="post" action="/apply">' +
            '<input type="hidden" name="back" value="' + escapeHtml(back) + '">' +
            bar('top') +
            '<div class="card"><div class="queue">' +
            shown.map(r => queueRow(r, verdictCell(r))).join('') +
            '</div>' +
            (items.length > shown.length
                ? '<p class="thin" style="margin:12px 0 0">Showing the first ' + shown.length +
                  ' of ' + items.length + '.</p>'
                : '') +
            '</div>' +
            (shown.length > 6 ? bar('bottom') : '') +
            '</form>'
    }

    const settled = filtered.filter(r => r.verdict).length

    /*  Every count and every empty state on this page is computed over the
        filtered rows, so each of them is a claim about the current tab and
        not about the queue. Under the old 'Everything' default the two were
        the same thing and the prose could say "nothing is awaiting a
        decision"; on an auction-defaulted page that sentence would report an
        all-clear having looked at 11% of the queue. Naming the population in
        one place keeps the three empty states honest together. */
    const only = sale === 'auction' ? ' at auction' : (sale === 'bin' ? ' at Buy-It-Now' : '')
    const among = sale === 'all' ? '' : ' on this tab'

    return RENDER.page('Needs review - Coin Market', `
<h1>Needs review</h1>
<p class="sub">Listings the classifier would not price without a human decision. Every statistic
in this tool is computed over what survives this filter, so it is shown rather than hidden.${
    sale === 'all' ? '' : ' You are looking at the ' + (sale === 'auction'
        ? 'auctions' : 'Buy-It-Now lots') + ' only &mdash; the tabs below carry the rest.'}</p>
${seriesTabs}
${applied}

<div class="card">
  <p class="thin" style="margin:0">Click a photo to see it large. Mark one and it is settled for
  good &mdash; the decision is stored against the coin, survives a relist, outranks every rule in
  the classifier, and the collector applies it to listings it finds tomorrow. Reject one and you
  are then offered a rule that generalises it, with the count of what it would catch and what it
  would break &mdash; scoped to this coin, so a good reason to reject
  ${escapeHtml(SERIES.words(chosen).one === SERIES.MIXED_WORDS.one
      ? 'one coin' : 'a ' + SERIES.words(chosen).one)} can never empty another series.${seriesTabs === '' ? '' : ' One coin at a time: the tabs above carry the size of ' +
  'every queue' + (sale === 'all' ? '' : ' on this tab') + ', so working through one never ' +
  'hides another.'}
  ${settled > 0 ? '<strong>' + settled + '</strong> of the listings below are already settled.' : ''}</p>
</div>

<div class="card">
  ${saleTabs('/review', sale, chosen === null ? {} : { coin: chosen }, queueSaleCounts)}
  <p class="thin" style="margin:10px 0 0">A live lot is filtered on how it is offered, a
  completed one on how it actually sold. The queue opens on auctions because that is where the
  tool has outcomes to learn from &mdash; every resolved sale it holds is one. ${sale === 'bin'
      ? 'No Buy-It-Now lot has a recorded outcome yet &mdash; they carry no end time, so the tool never learns whether they sold.'
      : ''}</p>
</div>

<h2>Making a number wrong right now (${affecting.length}${only})</h2>
<p class="thin">Flagged as uncertain, but still counted in the market statistics. These are the
ones behind anything that looks wrong on the front page.${sale === 'all' ? '' :
    ' Counted over this tab only &mdash; a lot sold the other way can be making a number wrong ' +
    'too, and it is on the tab above.'}</p>
${list(affecting, 'Nothing uncertain is currently being priced' + among + '.')}

<h2>Uncertain, but not being priced (${inert.length}${only})</h2>
${list(inert, 'Nothing else awaiting a decision' + among + '.', 150)}

<h2>Deliberately excluded (${excluded.length}${only})</h2>
<p class="thin">Mounts, copies, cases and multi-coin lots. If something here looks wrongly
dropped, mark it genuine &mdash; that overrides the rule that dropped it, which is the failure
mode worth watching for: a bad rule quietly eating half the market.</p>
${list(excluded, 'Nothing excluded' + among + '.', 150)}
${truncated ? '<p class="thin warn">The queue is longer than this page reads &mdash; only the first ' + QUEUE_LIMIT + ' rows were fetched, so the counts above are floors rather than totals.</p>' : ''}
`, url.pathname)
}

/* ---------------------------------------------------------- countries */

/*
    Where you are willing to buy from.

    Stored rather than hard-coded because it is a preference, not a fact, and
    an expensive one either way: narrowing it to GB removes about 1,400
    listings from the statistics and widening it brings them back. The counts
    are rendered next to each box so the cost is visible before it is paid.

    An empty list means no filtering at all, which is what a fresh store gets
    if nobody has chosen - see EXCLUSIONS.screenLocation for why that default
    matters.
*/
const COUNTRY_SETTING = 'allowedCountries'

const COUNTRY_NAMES = {
    GB: 'United Kingdom', AU: 'Australia', US: 'United States', IE: 'Ireland',
    FR: 'France', DE: 'Germany', IT: 'Italy', ES: 'Spain', NL: 'Netherlands',
    CA: 'Canada', NZ: 'New Zealand', CY: 'Cyprus', JP: 'Japan', CZ: 'Czechia',
    RO: 'Romania', PL: 'Poland', BE: 'Belgium', AT: 'Austria', CH: 'Switzerland'
}

/*  Defaults to the UK, because that is the market the owner buys in. This is
    an application default with a control on the page, not a library one -
    EXCLUSIONS.screenLocation still filters nothing unless it is handed a
    list, so the safety net stays under anything that forgets to ask. */
const DEFAULT_COUNTRIES = ['GB']

function allowedCountries (repository) {
    const stored = repository.setting(COUNTRY_SETTING, null)
    return Array.isArray(stored) ? stored : DEFAULT_COUNTRIES
}

function countryPicker (repository) {
    const chosen = allowedCountries(repository)
    const counts = repository.countryCounts()
        .filter(row => row.country !== '??')
        .slice(0, 18)

    const unknown = repository.countryCounts().find(row => row.country === '??')

    const boxes = counts.map(row => {
        const name = COUNTRY_NAMES[row.country] || row.country
        const on = chosen.includes(row.country)
        return '<label><input type="checkbox" name="country" value="' + escapeHtml(row.country) + '"' +
            (on ? ' checked' : '') + '> ' + escapeHtml(name) +
            ' <span class="thin">' + row.listings + '</span></label>'
    }).join('')

    const summary = chosen.length === 0
        ? 'Every country &mdash; nothing is filtered out.'
        : 'Only ' + chosen.map(c => escapeHtml(COUNTRY_NAMES[c] || c)).join(', ') + '.'

    return `<details class="card"${chosen.length === 0 ? '' : ''}>
  <summary>Where you will buy from &mdash; ${summary}</summary>
  <form method="post" action="/countries">
    <p class="thin" style="margin:10px 0 0">Tick the countries to keep. The number beside each is
    how many tracked listings it holds. Untick everything to stop filtering.
    ${unknown && unknown.listings > 0
        ? '<br><strong>' + unknown.listings + '</strong> listings have no country recorded yet ' +
          '(stored before the field existed); they are never filtered out, and fill in as the ' +
          'collector re-sees them.'
        : ''}</p>
    <div class="countries">${boxes}</div>
    <button class="yes">Apply</button>
    <span class="thin">Reclassifies everything &mdash; a few seconds.</span>
  </form>
</details>`
}

/* ------------------------------------------------------- one listing */

/*
    One row of the work queue, shared by the review page and the drill-down
    from a market number - a listing you can see is wrong should be
    dismissable from wherever you noticed it, with the same controls.

    Built as a list rather than a table because eBay titles run to 84
    characters and a column wide enough for one pushed the whole page
    sideways.
*/


/*  eBay serves the same photo at several widths off one URL. We store the
    225px thumbnail; 500px is 40KB and is plenty to tell a coin from a
    fishing reel. Verified against the CDN rather than assumed. */
function largerImage (url) {
    if (typeof url !== 'string' || url === '') { return null }
    return url.replace(/\/s-l\d+\.(jpg|jpeg|png|webp)$/i, '/s-l500.$1')
}

/*
    The reason, short enough to sit on one line.

    These run to 170 characters - longer than the titles, and the real
    driver of the width that made the queue scroll sideways. The full text
    goes in a tooltip rather than being thrown away, because a rule that
    dropped something wrongly is only diagnosable if you can read why.
*/
function compactReason (reason) {
    if (typeof reason !== 'string' || reason === '') { return null }
    const full = reason
    let short = reason.replace(/^EXCLUDED:\s*/, '')

    const offCategory = short.match(/^Not listed in a coin category \((.+)\)$/)
    if (offCategory !== null) {
        short = 'wrong category: ' + (leafCategory(offCategory[1]) || offCategory[1])
    }
    if (short.length > 58) { short = short.slice(0, 55).trimEnd() + '…' }
    return { short, full }
}

function leafCategory (path) {
    if (typeof path !== 'string' || path === '') { return null }
    const parts = path.split('>').map(p => p.trim()).filter(p => p.length > 0)
    return parts.length === 0 ? null : parts[parts.length - 1]
}

/*
    What the classifier decided this coin is, read back off the instrument
    key it was filed under.
*/
/*
    The denominations THIS coin can be, from its own pack.

    A module constant held the five sovereign denominations - FULL, HALF,
    QUARTER, DOUBLE, QUINTUPLE - and every row of every series got them. So a
    Morgan row offered five sizes of sovereign and never `DOLLAR`, which is
    not merely wrong wording: without a denomination the tool has no fine
    weight for the coin and therefore no premium, ever. The dropdown asked a
    question it would not accept the answer to.

    Ordered by the pack so an existing series keeps the order it had; a pack
    that says nothing gets its own declaration order.
*/
function denominationsFor (hint) {
    const pack = SERIES.get(hint) ||
        (typeof hint === 'string' ? (SERIES.forKey(hint) || {}).pack : null) || null
    if (pack === null || !pack.denominations) { return [''] }
    const order = pack.denominationOrder || Object.keys(pack.denominations)
    return [''].concat(order.filter(d => pack.denominations[d]))
}

/*
    Which denomination the classifier already worked out, read off the key.

    Positional rather than by matching against a list of names: the key IS
    `<series>.<pool>.<denomination>...`, so `forKey().rest[1]` is the answer
    for any series without anyone maintaining a vocabulary of every coin size
    the tool has ever known.
*/
function detectedDenomination (row) {
    const key = row.bestGuess || row.instrumentKey || null
    if (typeof key !== 'string') { return null }
    const found = SERIES.forKey(key)
    if (found === null) { return null }
    const denomination = found.rest[1]
    return denomination && found.pack.denominations &&
        found.pack.denominations[denomination] ? denomination : null
}

function callControls (row) {
    if (!row.legacyId) { return '<span class="thin">&mdash;</span>' }
    const id = escapeHtml(row.legacyId)

    if (row.verdict) {
        const said = row.verdict === LEARNED.VERDICT.SOVEREIGN
            ? 'You said: genuine' +
                (row.labelledQuantity > 1 ? ' ×' + row.labelledQuantity : '') +
                (row.labelledDenomination
                    ? ' (' + escapeHtml(String(row.labelledDenomination).toLowerCase()) + ')' : '')
            : 'You said: ' + escapeHtml(SERIES.words(row).notOne.toLowerCase())
        return '<span class="settled">' + said + '</span> ' +
            '<button class="plain" name="undo" value="' + id + '" title="Forget this decision">undo</button>'
    }

    /*  Pre-selected to whatever the classifier already worked out, so the
        common case needs no interaction at all: clicking Genuine submits the
        denomination it already had. The dropdown only asks a question when it
        reads "denomination?", which is exactly when there is one to answer. */
    const detected = detectedDenomination(row)
    const options = denominationsFor(row.series || row.instrumentKey || row.bestGuess)
        .map(d => '<option value="' + d + '"' + (d === (detected || '') ? ' selected' : '') + '>' +
            (d === '' ? 'denomination?' : escapeHtml(d.toLowerCase())) + '</option>')
        .join('')

    /*  Field names carry the listing id, because one form now covers the
        whole section: the handler reads the denomination and quantity
        belonging to each row it is acting on, whether that is this one row or
        every ticked one. */
    return '<select name="d_' + id + '">' + options + '</select>' +
        '<input class="qty" type="number" name="q_' + id + '" min="1" max="99" value="1" ' +
        'title="How many of the same coin are in this lot. Leave at 1 unless it is a multiple.">' +
        '<button class="yes" name="genuine" value="' + id + '">Genuine</button>' +
        /*  The short form. "Not a sov" was the only abbreviation in the app
            and it named one coin; the pack's own `notOne` is the right length
            already for both series that exist ("Not a sovereign", "Not a
            silver dollar") and reads properly for any that follow. */
        '<button class="no" name="reject" value="' + id + '">' +
        escapeHtml(SERIES.words(row).notOne) + '</button>'
}

/*  A <details> rather than a hover, because hovering opened the preview
    while the pointer was merely on its way somewhere and it covered the
    title underneath. Click to open, click to close, and it stays put while
    you read it. No JavaScript: <summary> is focusable and toggles on Enter
    or Space, so it is keyboard-workable too.

    Shared, because UI-03 asks for the same picture on every page that lists
    a lot and a second copy of this would drift from the first. */
function shot (imageUrl, caption) {
    /*  SAME ORIGIN, both sizes. Linking straight to eBay's CDN meant the
        pictures were a third-party request, and through the login proxy they
        stopped arriving - blank space, no broken icon, and still blank in a
        private window. Served from here there is no third party left to
        block. `proxied` returns null for anything not on the allowlist, in
        which case the original is used and behaves exactly as it did. */
    const thumbSrc = IMAGES.proxied(imageUrl) || imageUrl
    const bigSrc = IMAGES.proxied(largerImage(imageUrl)) || largerImage(imageUrl)
    const big = bigSrc
    const thumb = thumbSrc
        ? '<img src="' + escapeHtml(thumbSrc) + '" alt="" loading="lazy" decoding="async">'
        : '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">'
    if (!big) { return '<div class="q-shot">' + thumb + '</div>' }
    return '<details class="q-shot" style="--shot:url(&quot;' + escapeHtml(big) + '&quot;)">' +
        '<summary title="Click for a larger picture">' + thumb + '</summary>' +
        '<div class="q-big">' + (caption ? '<div class="cap">' + caption + '</div>' : '') + '</div>' +
        '</details>'
}

function queueRow (row, verdictCell) {
    /*  A completed sale is quoted at what it fetched, not at whatever it was
        asking the last time we looked. The asking price of a lot that has
        already sold is history; the hammer price is the measurement. */
    const sold = row.sold === 1 && Number.isFinite(row.finalPrice)
    const total = sold
        ? row.finalPrice + (row.finalShipping || 0)
        : (row.price || 0) + (row.shipping || 0)

    const meta = []
    const reason = compactReason(row.reason)
    if (reason !== null) {
        meta.push('<span class="badge" title="' + escapeHtml(reason.full) + '">' +
            escapeHtml(reason.short) + '</span>')
    }
    if (row.priced) { meta.push('<span class="badge">counted in the statistics</span>') }
    /*  Not twice. "wrong category: Costume Jewellery" already names it. */
    const leaf = leafCategory(row.categoryPath)
    if (leaf !== null && (reason === null || !reason.short.endsWith(leaf))) {
        meta.push(escapeHtml(leaf))
    }
    /*  Only when it is known and not the home market - a GB badge on every
        row would be noise, and a blank one on the 5,400 rows stored before
        this column existed would look like a finding. */
    if (row.itemCountry && String(row.itemCountry).toUpperCase() !== 'GB') {
        meta.push('<span class="badge critical">in ' + escapeHtml(String(row.itemCountry).toUpperCase()) + '</span>')
    }
    if (row.conditionLabel) { meta.push(escapeHtml(row.conditionLabel)) }
    if (row.buyingOptions) { meta.push(escapeHtml(String(row.buyingOptions).toLowerCase().replace(/[|,]/g, ' / ').replace(/_/g, ' '))) }
    /*  Auction-only, and present on just 7.6% of the queue for that reason -
        its absence says "not an auction" rather than "we failed to fetch
        it", so it is emitted only when there is something to say. */
    const bids = sold && Number.isFinite(row.finalBidCount) ? row.finalBidCount : row.bidCount
    if (Number.isFinite(bids)) {
        meta.push(bids + (bids === 1 ? ' bid' : ' bids'))
    }
    if (sold && row.endedAt) {
        meta.push('sold ' + escapeHtml(String(row.endedAt).slice(0, 10)))
    }
    /*  How current this is. A Buy-It-Now lot has no end time and its outcome
        is never resolved, so how recently a sweep saw it is the only thing
        that says it still exists - and that belongs on the row rather than
        in the filtering alone. */
    if (!sold) {
        const seen = FRESHNESS.describe(row.lastSeen)
        if (seen !== null) {
            const stale = !FRESHNESS.isActionable(row.lastSeen, row.sweepAt)
            meta.push(stale
                ? '<span class="badge critical" title="The hourly sweep has stopped seeing this lot, ' +
                  'which usually means it has ended or been pulled. eBay does not tell us when a ' +
                  'Buy-It-Now ends, so this is the only signal there is.">' + escapeHtml(seen) + '</span>'
                : '<span class="thin">' + escapeHtml(seen) + '</span>')
        }
    }
    /*  How long is left to act. On the opportunities panel this is the
        difference between a lot you can think about and one you cannot. */
    if (!sold && row.endTime) {
        const minutes = Math.round((new Date(row.endTime).getTime() - Date.now()) / 60000)
        if (Number.isFinite(minutes) && minutes > 0) {
            meta.push(minutes < 60 ? '<strong class="warn">ends in ' + minutes + ' min</strong>'
                : (minutes < 60 * 36 ? 'ends in ' + Math.round(minutes / 60) + 'h'
                    : 'ends in ' + Math.round(minutes / 1440) + 'd'))
        }
    }
    /*  eBay never publishes what an accepted Best Offer went for, so these
        are shown and excluded rather than counted at the list price - which
        would systematically overstate every clearing figure. */
    if (row.censored === 1) {
        meta.push('<span class="badge">price not published</span>')
    }
    /*  A high ask that nobody has taken for weeks is priced badly, not
        priced rarely - which is a judgement the owner makes from exactly
        this, so it belongs on the row. */
    if (row.firstSeen) {
        const days = Math.floor((Date.now() - new Date(row.firstSeen).getTime()) / 86400000)
        if (Number.isFinite(days) && days >= 1) {
            meta.push('seen ' + days + (days === 1 ? ' day' : ' days'))
        }
    }
    if (Number.isFinite(row.sellerFeedbackPct)) {
        meta.push('seller ' + row.sellerFeedbackPct.toFixed(1) + '%' +
            (Number.isFinite(row.sellerFeedbackCnt) ? ' (' + row.sellerFeedbackCnt + ')' : ''))
    }

    /*  The full category path in the caption, because it is the single most
        useful thing for judging a listing at a glance and it is too long
        for the row. */
    const caption = escapeHtml(row.categoryPath || '')

    /*  The tick box leads the row, so a cull is one pass straight down the
        left-hand edge without the mouse leaving that column. */
    const pick = row.legacyId && !row.verdict
        ? '<input class="pick" type="checkbox" name="pick" value="' + escapeHtml(row.legacyId) + '" ' +
          'title="Select this listing for a bulk decision">'
        : '<span class="pick-spacer"></span>'

    return `<div class="q">
  ${pick}
  ${shot(row.imageUrl, caption)}
  <div class="q-main">
    <div class="q-title">${row.itemWebUrl
        ? '<a href="' + escapeHtml(row.itemWebUrl) + '" target="_blank" rel="noopener">' + escapeHtml(row.title) + '</a>'
        : escapeHtml(row.title)}</div>
    <div class="q-meta">${meta.join('<span aria-hidden="true">·</span>')}</div>
  </div>
  <div class="q-side">
    <div class="q-price"><span class="mono">${sold ? 'sold ' : ''}${total > 0 ? gbp(total) : '—'}</span>
      ${verdictCell === undefined ? '' : verdictCell}</div>
    <div class="verdict">${callControls(row)}</div>
  </div>
</div>`
}

/* -------------------------------------------- the listings behind one number */

/*
    Drill-down from a market statistic to the lots that produced it.

    The front page shows aggregates and the review queue is keyed on doubt,
    not on which coin type a listing landed in - so a listing you could see
    was wrong from the market page had nowhere to be dismissed from. The
    same verdict controls appear here, and a decision returns you here
    rather than to the review queue.
*/
function listingsPage (opened, url) {
    const { repository, view } = opened
    const key = url.searchParams.get('key')
    if (key === null || key === '') {
        return RENDER.page('Listings - Coin Market',
            '<h1>No coin type given</h1><p class="sub"><a href="/">Back to the market</a>.</p>', url.pathname)
    }

    const sale = saleFrom(url)
    const FETCH = 500
    const rows = repository.listingsForInstrument(key, FETCH, sale)
    const verdictCell = newPlausibilityCell(opened.spotAt)
    /*  This page deliberately shows everything, including lots the sweep has
        stopped seeing - it is the route to a listing that classified wrongly
        and never reached the review queue. So the departed ones are badged
        rather than hidden, which is the opposite of the actionable panels. */
    const sweepAt = repository.lastSweepAt()
    for (const row of rows) {
        row.sweepAt = sweepAt
        /*  The drill-down knows the instrument from the URL, so the controls
            can pre-select the denomination here too. */
        row.instrumentKey = key
    }

    const name = INSTRUMENTS.displayName(key)
    const market = view.forInstrument(key)
    const saleCounts = repository.saleCountsForInstrument(key)

    /*
        Show only the figure whose population matches the tab you are on.

        The asking median is built from FIXED_PRICE listings alone
        (liquidity.js:44) and the clearing figure from sold auctions alone
        (liquidity.js:36). Both are correct; the bug was printing the
        Buy-It-Now one under an auctions-only view, which is the exact
        cross-pollution this page's filter exists to prevent - and it became
        the DEFAULT view with this change, so it could not wait.

        forInstrument stays corpus-wide and unfiltered. Passing a sale filter
        into it is how two definitions of one number get born: it is shared
        with the front page, the alert rules and the offline report, and
        market.js:130-143 still carries the scar from the last time, when the
        page printed "Clears at: -" beside "Spread: 40.3%". Nothing here
        changes a number; it changes which one is shown and what it is called.

        fairValue.p50 rather than liquidity.medianClearingPremium: the
        decay-weighted p50 needs three sales and blanks below that, while the
        plain median has no minimum and will happily report a whole market
        from one lot. That was the second of the two medians behind the
        original bug.
    */
    /*
        Whether the fetch saw everything, which the new ordering made into a
        question worth asking.

        listingsForInstrument admits rows by `COALESCE(o.sold,0) DESC, live
        DESC, totalCost DESC` and stops at FETCH. While the live section was
        also displayed dearest-first, admission order and display order were
        the same thing, so a cap could only ever hide the tail of what you
        were already reading. Ordering the live section by end time breaks
        that: the rows admitted are still the DEAREST, so on a capped fetch
        "ending soonest" means soonest of the dearest - and a cheap lot
        closing in ten minutes can be missing from a list whose whole promise
        is that the top of it is what you can still bid on.

        Detected rather than assumed: saleCounts is uncapped and rows is not,
        so the comparison is exact and costs nothing. No key is truncated on
        the live store today - the largest fetches 480 of 500 - but that is a
        reason to say so when it happens, not a reason to leave the promise
        unqualified.

        Not fixed by making end time a SQL key: that admits the soonest and
        drops the dearest, and the dearest lot is the one most likely to be
        distorting the premium this page exists to explain. The two cannot
        both be guaranteed from one capped fetch, so the page says which one
        it has.
    */
    const capped = saleCounts[sale] > rows.length

    const metalName = METAL_NAMES[market.metal] || market.metal
    const askTile = '<div><div class="n">' + pct(market.liquidity.medianAskPremium) + '</div>' +
        '<div class="l">median <strong>asking</strong> premium over ' + escapeHtml(metalName) +
        ' content, across live Buy-It-Now lots</div></div>'
    const clearTile = '<div><div class="n">' +
        (market.fairValue.sufficient ? pct(market.fairValue.p50) : '&mdash;') + '</div>' +
        '<div class="l">median premium auctions actually <strong>cleared</strong> at over ' +
        escapeHtml(metalName) + ' content' +
        (market.fairValue.sufficient ? '' : ' &mdash; needs three sales to say') +
        '</div></div>'
    const bidsTile = Number.isFinite(market.liquidity.medianBidCount)
        ? '<div><div class="n">' + market.liquidity.medianBidCount + '</div>' +
          '<div class="l">median bids on auctions that got any</div></div>'
        : ''

    /*  Everything shows the union, not the intersection. The bids figure
        is auction-only by nature, which is a reason to label it, not a
        reason to make it unreachable from the view whose whole point is to
        show everything. */
    const statTiles = sale === 'auction'
        ? clearTile + bidsTile
        : (sale === 'bin' ? askTile : clearTile + askTile + bidsTile)

    /*  What the counts on this page are counting. On a filtered tab
        "12 completed sales" is 12 completed AUCTIONS, and saying so is what
        lets a filter-scoped count sit honestly beside a corpus-scoped
        metric. */
    const saleNoun = sale === 'auction' ? ' at auction' : (sale === 'bin' ? ' at Buy-It-Now' : '')

    /*  Live and ended are counted separately so this page agrees with the
        Live column that led you here. Ended lots still matter - they feed
        the clearing price - but they are not what the front page's live
        figures are made of. */
    /*  Sold, live, and ended-unsold are three different kinds of evidence and
        the first is worth more than the other two together: it is the only
        number in the store that somebody actually paid. An asking price is an
        opinion; an unsold lot is an opinion that was refused. */
    const sold = rows.filter(r => r.sold === 1)
        .sort((a, b) => String(b.endedAt || '').localeCompare(String(a.endedAt || '')))
    const live = rows.filter(r => r.sold !== 1 && r.live === 1).sort(byEndingSoonest)
    const unsold = rows.filter(r => r.sold !== 1 && r.live !== 1)

    /*  Whether "ending soonest" is even a thing to say. On the auction tab
        every lot has an end time; on the Buy-It-Now tab none of them do, and
        the list is dearest-first exactly as it always was. Derived rather
        than written down, so the blurb cannot go stale against the filter. */
    const timed = live.filter(r => r.endTime).length
    const liveOrdering = timed === 0
        ? 'Dearest first'
        : (timed === live.length ? 'Ending soonest first' : 'Ending soonest first, undated last')

    /*  The number that justifies this page existing. Of the live listings
        counted into an instrument, most were never flagged for review at
        all - they classified confidently and wrongly - so the review queue
        could not reach them from any direction. */
    const unflagged = live.filter(r => !r.reason).length
    const settled = rows.filter(r => r.verdict).length

    /*  Capped, and says so. A list that silently stops is a list you would
        wrongly believe you had worked through.

        The cap costs little in either ordering, but for different reasons.
        Dearest-first puts the lots most likely to be distorting the number
        at the top; ending-soonest puts the only lots you can still act on at
        the top. What the cap drops is what the SECTION is ordered by, so the
        note has to name that ordering rather than assume one. */
    const CAP = 200
    /*  One coin type by definition - the key IS the coin. */
    const bar = bulkBar(key, '')

    const list = (items, ordering) => '<form method="post" action="/apply">' +
        '<input type="hidden" name="back" value="' +
        escapeHtml('/listings?key=' + encodeURIComponent(key) + '&sale=' + sale) + '">' +
        bar +
        '<div class="card"><div class="queue">' +
        items.slice(0, CAP).map(r => queueRow(r, verdictCell(r))).join('') + '</div>' +
        (items.length > CAP
            ? '<p class="thin" style="margin:12px 0 0">Showing the first ' + CAP +
              ' of ' + items.length + ', ' +
              escapeHtml((ordering || 'dearest first').toLowerCase()) + '.' +
              /*  items.length counts the FETCH, not the store. Presenting a
                  fetch artefact as a total is how "of 474" reads as the
                  whole market when it is 474 of a capped 500. */
              (capped
                  ? ' This coin type has ' + saleCounts[sale] + ' lots on this tab; the page ' +
                    'fetched the dearest ' + rows.length + ' of them.'
                  : '') +
              '</p>'
            : (capped
                ? '<p class="thin" style="margin:12px 0 0">This coin type has ' +
                  saleCounts[sale] + ' lots on this tab; the page fetched the dearest ' +
                  rows.length + ' of them.</p>'
                : '')) + '</div>' + bar + '</form>'

    return RENDER.page(name + ' - Coin Market', `
<h1>${escapeHtml(name)}</h1>
<p class="sub">Every listing counted under this coin type. Anything here that is not this coin is
moving the numbers on the front page.${sale === 'all' ? '' :
    ' Showing the ' + (sale === 'auction' ? 'auctions' : 'Buy-It-Now lots') +
    ' only &mdash; ' + saleCounts[sale === 'auction' ? 'bin' : 'auction'] +
    ' lots are on the other tab.'}</p>

<div class="card hero">
  <div><div class="n">${sold.length}</div><div class="l">completed sales${saleNoun}
    &mdash; the evidence everything else is measured against</div></div>
  <div><div class="n">${live.length}</div><div class="l">live${saleNoun} counted here</div></div>
  ${statTiles}
  <div><div class="n">${unflagged}</div>
    <div class="l">of them never flagged for review &mdash; they classified confidently, so this
      page is the only way to reach them</div></div>
  ${settled > 0 ? '<div><div class="n">' + settled + '</div><div class="l">you have judged' +
    saleNoun + '</div></div>' : ''}
</div>

<div class="card">
  ${saleTabs('/listings', sale, { key }, saleCounts)}
  <p class="thin" style="margin:10px 0 0">A completed lot is filtered on how it actually sold, a
  live one on how it is offered. Note that no Buy-It-Now lot has a recorded outcome &mdash; they
  carry no end time, so the tool never learns whether they sold.</p>
</div>

<h2>Sold &mdash; what someone actually paid (${sold.length})</h2>
<p class="thin">The only prices here that are not somebody's opinion. Everything the tool says a
coin is worth is built from these, so a wrong one costs more than a wrong asking price.
Most recent first.</p>
${sold.length === 0
    ? '<p class="thin">No completed sales under this coin type yet. They arrive as auctions this ' +
      'tool was already watching close, so the count only grows with time on the market.</p>'
    : list(sold, 'most recent first')}

<h2>On sale now (${live.length})</h2>
<p class="thin">${liveOrdering} &mdash; ${timed === 0
    ? 'within one coin type the dearest lot is also the highest premium, and a lot priced far ' +
      'from its neighbours is both the most likely to be wrong and the most visible when it is'
    : (capped
        ? 'ordered within the ' + rows.length + ' dearest lots this page fetched, which is not ' +
          'the same as the soonest overall &mdash; a cheap lot closing shortly can be outside ' +
          'that sample'
        : 'the top of this list is the part you can still bid on')}. Click a photo to see it large.
If the coin is real but the denomination is wrong, set it in the dropdown and mark it genuine
rather than dismissing it.</p>
${live.length === 0
    ? '<p class="thin">Nothing live under this coin type' +
      (sale === 'all' ? '' : ' on this tab') + '.</p>'
    : list(live, liveOrdering)}

${unsold.length === 0 ? '' : `<h2>Ended without selling (${unsold.length})</h2>
<p class="thin">The asking price was refused. Useful for the sell-through rate, and worth
nothing at all as a clearing price.</p>
${list(unsold, 'dearest first')}`}

<p style="margin-top:18px"><a href="/">Back to the market</a></p>
`, url.pathname)
}

/* ------------------------------------------------ recording a decision */

/*
    Only ever our own pages. The value comes back through a form field, and
    a redirect target taken from input without checking is how an open
    redirect happens - even on a loopback-only service, it is not a habit
    worth having.
*/
function safeBack (value) {
    if (typeof value !== 'string' || !value.startsWith('/')) { return '/review' }
    if (value.startsWith('//')) { return '/review' }
    const path = value.split('?')[0]
    return ['/review', '/listings', '/rules', '/'].includes(path) ? value : '/review'
}

/*
    Every write goes through here and every write reclassifies. The loop is
    only a loop if the front page changes when you make a call - a decision
    that needs a command run afterwards to take effect is a decision most
    people will stop making.
*/
function handlePost (opened, pathname, form) {
    const { db, repository } = opened

    /*
        One decision, or a whole ticked batch of them.

        Both come through here because both come from the same form: the
        section is one form so a cull can be a single click, and a per-row
        button is just a batch of one that also carries its own denomination.
    */
    if (pathname === '/apply') {
        const back = safeBack(form.get('back'))

        const undo = form.get('undo')
        if (undo) {
            repository.unlabel(undo)
            RECLASSIFY.one(db, repository, undo, { allowedCountries: allowedCountries(repository) })
            return back
        }

        const single = form.get('genuine') || form.get('reject')
        const verdict = form.get('genuine')
            ? LEARNED.VERDICT.SOVEREIGN
            : (form.get('reject') ? LEARNED.VERDICT.NOT_SOVEREIGN : form.get('bulk'))

        if (!LEARNED.VERDICT[verdict]) { return back }

        /*  A per-row button acts on its own row whether or not anything is
            ticked; the bar acts on the ticks. Silently including the ticks in
            a single-row click would be a nasty surprise. */
        const ids = single ? [single] : form.getAll('pick')
        if (ids.length === 0) { return back }

        const chosen = allowedCountries(repository)
        let applied = 0
        for (const legacyId of ids) {
            const title = repository.titleFor(legacyId)
            if (title === null) { continue }
            repository.label({
                legacyId,
                title,
                verdict,
                /*  Each row carries its own fields, so a batch accept still
                    honours a denomination or quantity set on any row in it -
                    the second pass and the third can be the same pass. */
                denomination: verdict === LEARNED.VERDICT.SOVEREIGN
                    ? (form.get('d_' + legacyId) || null)
                    : null,
                quantity: verdict === LEARNED.VERDICT.SOVEREIGN
                    ? Number(form.get('q_' + legacyId)) || 1
                    : 1
            })
            RECLASSIFY.one(db, repository, legacyId, { allowedCountries: chosen })
            applied++
        }

        /*  A single rejection is worth generalising, and offering that is the
            whole point of the teach page. A batch of thirty is not - there is
            no one title it came from. */
        if (single && verdict === LEARNED.VERDICT.NOT_SOVEREIGN) {
            return '/teach?legacy=' + encodeURIComponent(single) + '&back=' + encodeURIComponent(back)
        }
        return back + (back.includes('?') ? '&' : '?') + 'applied=' + applied +
            '&verdict=' + encodeURIComponent(verdict)
    }

    if (pathname === '/label') {
        const verdict = form.get('verdict')
        const legacyId = form.get('legacyId')
        if (!legacyId || !LEARNED.VERDICT[verdict]) { return '/review' }

        repository.label({
            legacyId,
            title: form.get('title') || '',
            verdict,
            /*  A denomination is only meaningful alongside "genuine", and
                an empty select must not be stored as a correction. */
            denomination: verdict === LEARNED.VERDICT.SOVEREIGN ? (form.get('denomination') || null) : null,
            quantity: verdict === LEARNED.VERDICT.SOVEREIGN ? Number(form.get('quantity')) || 1 : 1
        })
        /*  One coin, not all five thousand. A verdict cannot affect any
            listing but this one's, and a full rebuild per click is slow
            enough on a Pi that people stop clicking. */
        RECLASSIFY.one(db, repository, legacyId, { allowedCountries: allowedCountries(repository) })

        /*  Back where the decision was made. A junk listing noticed on a
            market number should not dump you on the review page, or working
            through one coin type means losing your place every time. */
        const back = safeBack(form.get('back'))
        return verdict === LEARNED.VERDICT.NOT_SOVEREIGN
            ? '/teach?legacy=' + encodeURIComponent(legacyId) + '&back=' + encodeURIComponent(back)
            : back
    }

    if (pathname === '/countries') {
        /*  getAll, because an unticked box sends nothing at all - the empty
            list is a real choice here ("do not filter"), not a missing one. */
        const chosen = form.getAll('country')
            .map(c => String(c).toUpperCase())
            .filter(c => /^[A-Z]{2}$/.test(c))
        repository.setSetting(COUNTRY_SETTING, chosen)
        RECLASSIFY.run(db, repository, { allowedCountries: chosen })
        return '/'
    }

    if (pathname === '/unlabel') {
        const legacyId = form.get('legacyId')
        if (legacyId) {
            repository.unlabel(legacyId)
            RECLASSIFY.one(db, repository, legacyId, { allowedCountries: allowedCountries(repository) })
        }
        return safeBack(form.get('back'))
    }

    if (pathname === '/rule') {
        const phrase = (form.get('phrase') || '').trim()
        if (phrase.length === 0) { return '/rules' }

        /*  Count what was being priced before and after, so the page you land
            on can say what the click actually did rather than leaving you to
            go and look. A rule you did not mean to accept is only a problem
            if you cannot tell that you accepted it. */
        const priced = () => db.prepare(
            'SELECT COUNT(DISTINCT browse_id) AS n FROM listing_instrument').get().n
        const before = priced()

        /*  Scoped to the series it was learned from unless explicitly
            widened. null means every series, and is the only value here that
            cannot be undone by noticing later - see ruleScopeControl. */
        const everySeries = form.get('allSeries') === '1'
        repository.saveLearnedRule({
            phrase,
            kind: LEARNED.VERDICT.NOT_TRACKED,
            series: everySeries ? null : (form.get('series') || SERIES.DEFAULT_ID),
            support: Number(form.get('support')) || null,
            agreement: form.get('agreement') === '' ? null : Number(form.get('agreement'))
        })
        RECLASSIFY.run(db, repository, { allowedCountries: allowedCountries(repository) })

        return '/rules?just=' + encodeURIComponent(phrase) + '&dropped=' + (before - priced())
    }

    if (pathname === '/rule/delete') {
        const id = Number(form.get('id'))
        if (Number.isFinite(id)) {
            repository.deleteLearnedRule(id)
            RECLASSIFY.run(db, repository, { allowedCountries: allowedCountries(repository) })
        }
        return '/rules'
    }

    return '/review'
}

/* ------------------------------------------------- generalising a call */

/*
    What one phrase would do, counted the way the rule will actually be applied.

    Scoped, because the rule is. `learned.compile` tests a rule only against
    the pack that claimed the listing, so a GB.SOV rule can no more touch a
    Morgan than it can touch a postage stamp - and a preview that counted
    Morgans would report damage that cannot happen. Measured on the live
    store, "harrington & byrne" matches 8 titles of which 2 are Morgans: the
    unscoped count called it 3 breaks where a sovereign rule breaks 2.

    A NULL series is NOT "might be either". `series` is set from
    SERIES.recognise BEFORE classification runs (discover.js:150-157), so
    NULL means no pack claimed the title and it went to the review queue
    without ever meeting a learned rule. 85% of the store is in that state
    and none of it is priced. Those listings are unreachable by any rule,
    which is worth counting and saying out loud rather than folding into a
    number: "proof" matches 1,401 titles and 581 of them cannot be touched,
    so a preview reporting 1,401 promises a clear-out it will not deliver.
*/
function ruleEffect (repository, phrase, seriesId) {
    const pack = SERIES.get(seriesId) || SERIES.defaultPack()
    const test = LEARNED.phrasePattern(phrase)

    const matched = repository.titleCorpus().filter(row => test.test(row.title))
    const inScope = matched.filter(row => row.series === pack.id)
    const breaks = inScope.filter(row => row.priced)

    const conflicts = repository.labels()
        .filter(l => l.verdict === LEARNED.VERDICT.SOVEREIGN && test.test(l.title) &&
            (l.series || SERIES.DEFAULT_ID) === pack.id)

    return {
        phrase,
        series: pack.id,
        support: inScope.length,
        breaks: breaks.length,
        breakSamples: breaks.slice(0, 30).map(b => b.title),
        samples: inScope.slice(0, 6).map(m => m.title),
        conflicts: conflicts.map(c => c.title),
        /*  Matches this rule will not reach: other packs' coins, and titles
            no pack claimed. Shown, not silently dropped. */
        unreachable: matched.length - inScope.length
    }
}

/*
    What this rule will and will not touch.

    A rule is scoped to the series it was learned from unless you say
    otherwise, and saying otherwise is a checkbox rather than a default
    because the two readings are a sentence apart and worlds apart in
    consequence. "Britannia" is a perfectly good reason to reject a
    SOVEREIGN and a catastrophic reason to reject a BRITANNIA - and once a
    rule is unscoped there is nothing to tell the two apart. The damage
    would land months later, when a Britannia pack is added and quietly
    stays empty.
*/
function ruleScopeControl (seriesId) {
    const pack = SERIES.get(seriesId) || SERIES.defaultPack()
    return '<input type="hidden" name="series" value="' + escapeHtml(pack.id) + '">' +
        '<label class="scope" title="Leave this unticked unless the phrase describes something ' +
        'that is not a coin at all. A rule scoped to one series can be widened later; an ' +
        'unscoped rule that empties a series you add next year gives you nothing to trace it ' +
        'back to.">' +
        '<input type="checkbox" name="allSeries" value="1"> apply to every coin, not just ' +
        escapeHtml(pack.label) +
        '</label>'
}

function proposalCard (p, back, legacyId, seriesId) {
    const pack = SERIES.get(seriesId) || SERIES.defaultPack()
    const risky = p.breaks > 0 || p.conflicts.length > 0
    const consequence = p.breaks === 0
        ? ', <strong>none</strong> of which are currently priced as ' +
          escapeHtml(SERIES.words(pack).plural) + '.'
        : ', and would stop pricing <strong class="warn">' + p.breaks +
          '</strong> that count towards the market statistics today.'

    /*  A rule that breaks nothing can be taken in one click. A rule that
        would remove real coins from the statistics gets a confirmation page
        naming every one of them - the difference between those two cases is
        the whole reason `breaks` is measured.

        The series rides on the LINK, not on a lookup at the other end. The
        confirmation page is also reachable from /rules with a hand-typed
        phrase, which has no label to derive a series from - so ?series= is
        the one thing both callers can supply. Dropping it here is how a rule
        proposed from a Morgan title got written against sovereigns. */
    const action = risky
        ? '<a class="confirm" href="/rule-confirm?phrase=' + encodeURIComponent(p.phrase) +
          '&amp;legacy=' + encodeURIComponent(legacyId) + '&amp;back=' + encodeURIComponent(back) +
          '&amp;series=' + encodeURIComponent(pack.id) +
          '">Review what this would remove&hellip;</a>'
        : '<form method="post" action="/rule" style="margin-top:10px">' +
          '<input type="hidden" name="back" value="' + escapeHtml(back) + '">' +
          '<input type="hidden" name="phrase" value="' + escapeHtml(p.phrase) + '">' +
          '<input type="hidden" name="support" value="' + p.support + '">' +
          ruleScopeControl(seriesId) +
          '<button class="yes">Accept this rule</button></form>'

    const conflictNote = p.conflicts.length > 0
        ? ' It also contradicts <strong class="warn">' + p.conflicts.length +
          '</strong> you have already called genuine, so the phrase is too broad.'
        : ''

    return '<div class="proposal">' +
        '<div class="p">Drop everything containing <span class="phrase">' +
        escapeHtml(p.phrase) + '</span></div>' +
        '<p class="thin" style="margin:6px 0 0">Matches <strong>' + p.support +
        '</strong> tracked listing' + (p.support === 1 ? '' : 's') + consequence + conflictNote + '</p>' +
        '<ul>' + p.samples.map(x => '<li>' + escapeHtml(x) + '</li>').join('') + '</ul>' +
        action +
        '</div>'
}

function teachPage (opened, url) {
    const { repository } = opened
    const legacyId = url.searchParams.get('legacy')
    const labels = repository.labels()
    const label = labels.find(l => l.legacyId === legacyId)
    const back = safeBack(url.searchParams.get('back'))

    if (label === undefined) {
        return RENDER.page('Teach - Coin Market',
            '<h1>Nothing to generalise</h1><p class="sub">That decision is no longer stored. ' +
            '<a href="/review">Back to the review queue</a>.</p>', url.pathname)
    }

    const proposals = LEARNED.induce(label, repository.titleCorpus(), labels)

    /*
        Safe and unsafe are shown differently, not merely ranked differently.

        The reason a listing is wrong is often not in its title at all - a
        genuine sovereign photographed in a pendant reads like any other
        sovereign. Every phrase on offer then describes the coin rather than
        the fault, and one stray click could drop every sovereign with
        "george" in its title. So a rule that would remove nothing from the
        statistics gets a button, and a rule that would remove something gets
        a confirmation page instead of one.
    */
    const safe = proposals.filter(p => p.breaks === 0 && p.conflicts.length === 0)
    const risky = proposals.filter(p => p.breaks > 0 || p.conflicts.length > 0)

    const nothingSafe = '<div class="card">' +
        '<p style="margin:0"><strong>Nothing here generalises safely.</strong></p>' +
        '<p class="thin" style="margin:8px 0 0">Every phrase in this title also appears on coins ' +
        'that are being priced normally &mdash; which usually means the reason this listing is ' +
        'wrong is not in its words at all. A sovereign photographed in a pendant reads like any ' +
        'other sovereign. Your decision on this one listing still stands; it just does not ' +
        'generalise.</p></div>'

    const safeHtml = safe.length > 0
        ? safe.map(p => proposalCard(p, back, legacyId, label.series)).join('')
        : nothingSafe

    const riskyHtml = risky.length === 0 ? '' : '<details>' +
        '<summary>' + risky.length + ' other phrase' + (risky.length === 1 ? '' : 's') +
        ' would also match, but ' + (risky.length === 1 ? 'it removes' : 'they remove') +
        ' coins from the statistics</summary>' +
        '<p class="thin">These need checking rather than clicking. Each one opens a page ' +
        'listing exactly what it would stop pricing.</p>' +
        risky.map(p => proposalCard(p, back, legacyId, label.series)).join('') +
        '</details>'

    return RENDER.page('Teach - Coin Market',
        '<h1>Should that apply to others?</h1>' +
        '<p class="sub">You marked <em>' + escapeHtml(label.title) + '</em> as not ' +
        escapeHtml((SERIES.get(label.series) || SERIES.defaultPack()).label.toLowerCase()) + '. ' +
        'Here is what that decision could generalise to.</p>' +
        '<div class="card"><p class="thin" style="margin:0">Accepting a rule does not delete ' +
        'anything. Every listing it drops still shows in the review queue with the rule named as ' +
        'the reason, marking one genuine overrides it, and any rule can be removed from ' +
        '<a href="/rules">what you\'ve taught it</a>. Take none of these and the single decision ' +
        'still stands.</p></div>' +
        safeHtml + riskyHtml +
        '<p style="margin-top:18px"><a href="' + escapeHtml(back) +
        '">No rule &mdash; just this listing</a></p>', url.pathname)
}

/*
    The confirmation step for a rule that would remove real coins.

    Named listings, not a count. "Would stop pricing 97" is a number people
    click past; "would stop pricing 1911 Gold Sovereign George V London" is
    not.
*/
/*
    What a rule would do, before you commit to it.

    Reached two ways now: from a proposal the inducer offered, and from a
    phrase typed by hand on /rules. That second caller is why the series
    arrives as a QUERY PARAMETER rather than being looked up from the label -
    a typed phrase has no label at all, and re-deriving it would have left
    the same hole one function along.
*/
function confirmRulePage (opened, url) {
    const { repository } = opened
    const phrase = url.searchParams.get('phrase')
    const back = safeBack(url.searchParams.get('back'))
    const legacyId = url.searchParams.get('legacy') || ''
    const seriesId = url.searchParams.get('series') || null

    if (phrase === null || phrase === '') {
        return RENDER.page('Confirm - Coin Market', '<h1>No rule given</h1>', url.pathname)
    }

    const effect = ruleEffect(repository, phrase, seriesId)
    const pack = SERIES.get(seriesId) || SERIES.defaultPack()
    const harmless = effect.breaks === 0 && effect.conflicts.length === 0

    const conflictBlock = effect.conflicts.length === 0 ? ''
        : '<h2>You called these genuine</h2><div class="card"><ul>' +
          effect.conflicts.map(c => '<li class="warn">' + escapeHtml(c) + '</li>').join('') +
          '</ul></div>'

    const more = effect.breaks > effect.breakSamples.length
        ? '<li><em>and ' + (effect.breaks - effect.breakSamples.length) + ' more</em></li>'
        : ''

    /*
        Three cases, not one.

        This page used to shout "would remove coins that are being priced"
        unconditionally, which was fine when every visitor arrived from a
        proposal the inducer had already judged risky. A typed phrase can
        match nothing at all - "hattons" is exactly the kind of phrase the
        inducer never offers - and a page that cries damage when there is
        none is a page you learn to click past, which destroys the warning
        in the case that matters.
    */
    let heading, summary, breakBlock, button
    if (effect.support === 0) {
        heading = 'Nothing matches this yet'
        summary = 'No listing in the store contains <span class="phrase">' +
            escapeHtml(phrase) + '</span> right now. Saving it is still worth doing if you ' +
            'expect it later &mdash; the rule is applied to everything the collector finds ' +
            'from here on, so it blocks the next drop rather than this one.'
        breakBlock = ''
        button = '<button class="yes">Add this rule</button>'
    } else if (harmless) {
        heading = 'This rule catches ' + effect.support + ', and breaks nothing'
        summary = 'Dropping everything containing <span class="phrase">' + escapeHtml(phrase) +
            '</span> matches ' + effect.support + ' listing' + (effect.support === 1 ? '' : 's') +
            ', and <strong>none</strong> of them is currently priced.'
        breakBlock = effect.samples.length === 0 ? ''
            : '<h2>What it catches</h2><div class="card"><ul class="thin">' +
              effect.samples.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + '</ul></div>'
        button = '<button class="yes">Add this rule</button>'
    } else {
        heading = 'This rule would remove coins that are being priced'
        summary = 'Dropping everything containing <span class="phrase">' + escapeHtml(phrase) +
            '</span> matches ' + effect.support + ' tracked listing' +
            (effect.support === 1 ? '' : 's') + '.'
        breakBlock = '<h2>Priced today, would stop (' + effect.breaks + ')</h2>' +
            '<div class="card"><ul class="thin">' +
            effect.breakSamples.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + more +
            '</ul></div>'
        button = '<button class="no">Yes, apply it anyway</button>'
    }

    const damage = harmless || effect.support === 0 ? ''
        : '<div class="card"><p style="margin:0"><strong class="warn">' + effect.breaks +
          '</strong> of them count towards the market statistics right now and would stop.' +
          (effect.conflicts.length > 0
              ? ' <strong class="warn">' + effect.conflicts.length +
                '</strong> of them you have already called genuine.'
              : '') +
          '</p><p class="thin" style="margin:8px 0 0">This is reversible &mdash; removing the ' +
          'rule from <a href="/rules">what you\'ve taught it</a> puts every one of them back. ' +
          'But it is worth reading the list first.</p></div>'

    /*  What the rule cannot do. A phrase almost always matches titles
        outside the series it is being saved against - other packs' coins,
        and the large unclaimed pile - and a rule reaches none of them. Left
        unsaid, the counts on this page read as a promise the rule will not
        keep, and the tool looks broken a week later when the same titles are
        still in the queue. */
    const outOfScope = effect.unreachable === 0 ? ''
        : '<p class="thin">' + effect.unreachable + ' other listing' +
          (effect.unreachable === 1 ? '' : 's') + ' also contain' +
          (effect.unreachable === 1 ? 's' : '') + ' this phrase but ' +
          (effect.unreachable === 1 ? 'is' : 'are') + ' not ' +
          escapeHtml(pack.label.toLowerCase()) + ', so this rule leaves ' +
          (effect.unreachable === 1 ? 'it' : 'them') + ' alone. Tick the box below to ' +
          'widen it to every coin.</p>'

    /*  Back to wherever you came from. Cancelling to /teach?legacy= with no
        legacy id lands on "Nothing to generalise", which is a dead end for
        anyone who typed the phrase themselves. */
    const cancel = legacyId === ''
        ? '<a href="' + escapeHtml(back) + '">Cancel</a>'
        : '<a href="/teach?legacy=' + encodeURIComponent(legacyId) + '&amp;back=' +
          encodeURIComponent(back) + '">Cancel</a>'

    return RENDER.page('Confirm - Coin Market',
        '<h1>' + heading + '</h1>' +
        '<p class="sub">' + summary + ' Scoped to <strong>' + escapeHtml(pack.label) +
        '</strong> unless you widen it below.</p>' +
        outOfScope + damage + conflictBlock + breakBlock +
        '<form method="post" action="/rule" style="display:flex; gap:10px; align-items:center">' +
        '<input type="hidden" name="back" value="' + escapeHtml(back) + '">' +
        '<input type="hidden" name="phrase" value="' + escapeHtml(phrase) + '">' +
        '<input type="hidden" name="support" value="' + effect.support + '">' +
        ruleScopeControl(seriesId) +
        button + cancel + '</form>', url.pathname)
}

/* ----------------------------------------------------- what it learned */

/*
    Block a phrase the inducer never offered you.

    Every rule until now came from rejecting a listing, which means the tool
    only ever proposed phrases it had already seen go wrong. A dealer whose
    listings are individually plausible - correct metal, correct weight, an
    honest description of an overpriced modern proof - never produces a
    rejection, so its name is never a candidate. The owner knows the name
    anyway. This is the way to say it.

    A GET, not a POST, and it lands on the confirmation page rather than
    saving. With no client-side JavaScript in this tool, "show me what this
    would do before I commit" IS a round trip, and /rule-confirm already is
    one. It also means a typed phrase and an induced one converge on the same
    preview and the same commit button, instead of a second path that has to
    be kept honest separately.

    On /rules rather than /teach because /teach needs a legacy id from a
    listing you just judged, which is exactly what someone blocking a dealer
    by name does not have.
*/
function blocklistForm () {
    const options = SERIES.all().map(p =>
        '<option value="' + escapeHtml(p.id) + '"' +
        (p.id === SERIES.DEFAULT_ID ? ' selected' : '') + '>' +
        escapeHtml(p.label) + '</option>').join('')

    return '<h2>Block a phrase yourself</h2>' +
        '<div class="card">' +
        '<form method="get" action="/rule-confirm" style="display:flex; gap:10px; ' +
        'align-items:center; flex-wrap:wrap">' +
        '<input type="hidden" name="back" value="/rules">' +
        '<input type="text" name="phrase" required placeholder="hattons" ' +
        'style="flex:1 1 220px" ' +
        'title="Matched against the listing TITLE, case-insensitively, as whole words. ' +
        'It is not a seller filter: eBay usernames are stored as a one-way hash and the ' +
        'raw name is never kept, so this catches a dealer only when they put their name ' +
        'in the title.">' +
        '<select name="series" title="A rule applies to the coin you scope it to and no ' +
        'other. You can widen it to every coin on the next page.">' + options + '</select>' +
        '<button class="yes">See what this would do&hellip;</button>' +
        '</form>' +
        '<p class="thin" style="margin:10px 0 0">Nothing is saved yet &mdash; the next page ' +
        'names every listing the rule would stop pricing, and you can back out there. ' +
        'Matching is on the <strong>title text</strong>, so a dealer is caught only when ' +
        'their name is in it.</p>' +
        '</div>'
}

function rulesPage (opened, url) {
    const { repository } = opened
    const rules = repository.learnedRules()
    const labels = repository.labels()
    const corpus = repository.titleCorpus()

    /*
        How often the pipeline reaches your conclusion on its own.

        Measured with the labels withheld but the learned rules in place, so
        it answers "would this have needed me?". It is not an out-of-sample
        score: a rule accepted from a label will always reproduce that
        label, and the number is flattered by exactly that much. It is still
        the right thing to watch, because it only moves when the rules start
        covering calls they were not built from.
    */
    const learned = LEARNED.compile(rules)
    const decided = labels.filter(l => l.verdict !== LEARNED.VERDICT.UNSURE)
    const agreed = decided.filter(l => {
        const result = CLASSIFY.classify({ title: l.title }, { learned })
        const machineSaysNot = result.excluded !== null
        return machineSaysNot === (l.verdict === LEARNED.VERDICT.NOT_SOVEREIGN)
    }).length

    const ruleRows = rules.length === 0
        ? '<p class="thin">No rules yet. They come from the review queue: reject a coin and you ' +
          'are offered the rule that generalises it.</p>'
        : '<div class="card scroll"><table><thead><tr><th>Rule</th>' +
          '<th title="Which coin this rule was learned about. A rule scoped to one series ' +
          'never touches another - which is what stops a good reason to reject one coin ' +
          'from quietly emptying a series you add later.">Applies to</th>' +
          '<th>Matches now</th>' +
          '<th>When accepted</th><th></th></tr></thead><tbody>' +
          rules.map(rule => {
              const test = LEARNED.phrasePattern(rule.phrase)
              /*  Counted the way the rule is applied. A scoped rule reaches
                  only the pack that claimed the listing, so a series-blind
                  count here would credit a sovereign rule with Morgans it
                  cannot touch - and this column is what the owner reads to
                  decide whether a rule is working. */
              const now = corpus.filter(row => test.test(row.title) &&
                  (rule.series === null || rule.series === undefined ||
                   row.series === rule.series)).length
              /*  An unscoped rule is the one worth being able to see. It
                  applies to coins this tool does not track yet, so it is the
                  only kind that can do damage nobody connects to a click. */
              const pack = rule.series ? SERIES.get(rule.series) : null
              const scope = rule.series === null || rule.series === undefined
                  ? '<span class="badge critical" title="This rule applies to every coin the ' +
                    'tool tracks, including ones added later.">every coin</span>'
                  : escapeHtml(pack ? pack.label : rule.series)
              return `<tr>
    <td>drop titles containing <span class="phrase">${escapeHtml(rule.phrase)}</span></td>
    <td class="thin">${scope}</td>
    <td class="mono">${now}</td>
    <td class="mono thin">${rule.createdAt ? escapeHtml(String(rule.createdAt).slice(0, 10)) : '—'}</td>
    <td><form method="post" action="/rule/delete" style="display:inline">
      <input type="hidden" name="id" value="${rule.id}">
      <button class="plain">remove</button></form></td>
  </tr>`
          }).join('') + '</tbody></table></div>'

    const byVerdict = {
        genuine: labels.filter(l => l.verdict === LEARNED.VERDICT.SOVEREIGN).length,
        not: labels.filter(l => l.verdict === LEARNED.VERDICT.NOT_SOVEREIGN).length
    }

    /*
        What the last click did, with the undo next to it.

        The worry this answers is a rule accepted by accident - the phrase is
        named, the number of listings it removed from the statistics is
        stated, and putting them back is one button rather than a hunt
        through a table.
    */
    const just = url === undefined ? null : url.searchParams.get('just')
    const dropped = url === undefined ? null : Number(url.searchParams.get('dropped'))
    const justRule = just === null ? undefined : rules.find(r => r.phrase === just.toLowerCase())

    const banner = justRule === undefined ? '' : `<div class="card" style="border-color:var(--good)">
  <p style="margin:0">Rule added: drop everything containing
    <span class="phrase">${escapeHtml(justRule.phrase)}</span>.
    ${Number.isFinite(dropped) && dropped > 0
      ? '<strong>' + dropped + '</strong> listing' + (dropped === 1 ? '' : 's') +
        ' stopped counting towards the market statistics.'
      : 'Nothing that was being priced stopped counting.'}</p>
  <form method="post" action="/rule/delete" style="margin-top:10px">
    <input type="hidden" name="id" value="${justRule.id}">
    <button class="no">Undo &mdash; remove this rule</button>
  </form>
</div>`

    return RENDER.page("What you've taught it — Coin Market", `
<h1>What you've taught it</h1>
${banner}
<p class="sub">Your decisions, and the rules they generalised into. Everything here is
reversible and nothing here is a black box — each rule is the phrase you accepted.</p>

<div class="card hero">
  <div><div class="n">${labels.length}</div><div class="l">coins you have judged
    — ${byVerdict.genuine} genuine, ${byVerdict.not} rejected</div></div>
  <div><div class="n">${rules.length}</div><div class="l">rules generalised from them</div></div>
  <div><div class="n">${decided.length === 0 ? '—' : Math.round(100 * agreed / decided.length) + '%'}</div>
    <div class="l">of your calls the classifier now reaches on its own, with your labels withheld</div></div>
</div>

<h2>Rules</h2>
${ruleRows}

${blocklistForm()}

<h2>Your decisions (${labels.length})</h2>
${labels.length === 0
    ? '<p class="thin">Nothing judged yet.</p>'
    : '<div class="card scroll"><table><thead><tr><th>Listing</th><th>Your call</th><th>When</th>' +
      '</tr></thead><tbody>' + labels.slice(0, 200).map(l => `<tr>
  <td>${escapeHtml(l.title)}</td>
  <td>${l.verdict === LEARNED.VERDICT.SOVEREIGN
      ? '<span class="badge good">genuine' + (l.denomination ? ' · ' + escapeHtml(String(l.denomination).toLowerCase()) : '') + '</span>'
      : '<span class="badge critical">' +
        escapeHtml(SERIES.words(l.series).notOne.toLowerCase()) + '</span>'}</td>
  <td class="mono thin">${escapeHtml(String(l.labelledAt).slice(0, 10))}</td>
</tr>`).join('') + '</tbody></table></div>'}

<h2>Why this and not a model</h2>
<div class="card">
  <p class="thin" style="margin:0">A statistical classifier trained on a few hundred labels
  would be weaker than these rules and could not tell you why it dropped anything. Here every
  exclusion traces back to a phrase you accepted, and every phrase back to a coin you judged.
  The labels are the durable part: if a model is ever worth training, it trains on these
  without you having to judge anything twice.</p>
</div>
`, url.pathname)
}
