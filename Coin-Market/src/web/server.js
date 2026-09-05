'use strict'

const HTTP = require('node:http')
const RENDER = require('./render.js')
const IMAGES = require('./images.js')
const STATIC = require('./static.js')
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
/*
    Which theme this reader has chosen, if any.

    Read straight off the Cookie header rather than through a parser: one
    name, one value, two possible values, and a dependency-free tool does not
    take on a cookie library to read `theme=dark`. Anything else - absent,
    malformed, a value nobody set - returns null, and null means the page
    stamps nothing and prefers-color-scheme decides.
*/
function themeFrom (request) {
    const header = (request && request.headers && request.headers.cookie) || ''
    const found = /(?:^|;\s*)theme=(dark|light)(?:;|$)/.exec(header)
    return found === null ? null : found[1]
}

/*
    Set it, and go back where you came from.

    A GET that changes something is normally a mistake - a crawler can walk
    it, a prefetch can trip it. This one is deliberate and safe: the only
    thing it changes is which colours the reader sees, it is idempotent, and
    it belongs to the browser that asked rather than to any stored data. The
    alternative, a POST form, would put a submit button in the menu bar of
    every page.

    `back` goes through the same safeBack allow-list the verdict forms use,
    so this cannot be turned into an open redirect.
*/
function setTheme (url, response) {
    const to = url.searchParams.get('to')
    const theme = to === 'dark' || to === 'light' ? to : null
    const back = safeBack(url.searchParams.get('back'))

    const headers = { Location: back }
    if (theme !== null) {
        /*  A year, and Lax rather than Strict: arriving from a link in
            MetalHead is a cross-site navigation, and Strict would drop the
            cookie exactly there - the reader's theme would forget itself
            every time they came in through the login. */
        headers['Set-Cookie'] = 'theme=' + theme +
            '; Path=/; Max-Age=31536000; SameSite=Lax'
    }
    response.writeHead(302, headers)
    response.end()
}

/*
    The numbers the menu bar carries.

    The bar is on every page, and three of its five figures are the ones the
    scanner itself computes - so they are worked out here once and both
    callers read the same answer. A menu that disagreed with the list it opens
    would be worse than a menu with no numbers at all.

    MEMOISED, briefly. Counting lots at or near spot means pricing every live
    auction against its own metal, which is the front page's own work; doing
    it again on /review and /rules would make every page pay for a subtitle.
    Thirty seconds is far fresher than the data behind it - the collector
    sweeps hourly - and the pages themselves stay `no-store`, because a stale
    count in a menu is a different thing from a stale price in a table.
*/
/*  Within five per cent of the metal in it. Shared by the scanner and by the
    count in the menu that opens it, so the two cannot drift apart. */
const NEAR_SPOT = 1.05

const SCAN_TTL_MS = 30000
let scanCache = null

function scanCounts (opened, nowMs) {
    const at = nowMs === undefined ? Date.now() : nowMs
    if (scanCache !== null && at - scanCache.at < SCAN_TTL_MS) { return scanCache.value }

    const value = { nearSpot: null, offers: null, endingHour: null, sold: null, review: null }
    try {
        const { repository } = opened
        const now = new Date(at).toISOString()
        const sweepAt = repository.lastSweepAt()

        const live = repository.liveAuctions(500)
            .map(row => {
                const spot = opened.spotAt(now, row.metal)
                const metalValue = spot === null ? null : row.fineOz * spot.gbpPerOz
                const total = PREMIUM.totalCost(row.price, row.shipping)
                return { row, ratio: metalValue > 0 ? total / metalValue : null }
            })
            .filter(entry => Number.isFinite(entry.ratio))
            .filter(entry => FRESHNESS.isActionable(entry.row.lastSeen, sweepAt))

        value.nearSpot = live.filter(entry => entry.ratio <= NEAR_SPOT).length

        /*  Within the hour, off the same rows: an auction carries a real end
            time, so this needs no second query. */
        const hour = at + 3600000
        value.endingHour = live.filter(entry => {
            const ends = Date.parse(entry.row.endTime)
            return Number.isFinite(ends) && ends > at && ends <= hour
        }).length

        value.sold = repository.soldCount()
        value.review = repository.reviewAffectingCount()
    } catch (err) {
        /*  A bar that cannot count is still a bar. This runs on every page,
            so a failure here would take every page down for the sake of a
            number beside a menu item. */
    }

    scanCache = { at, value }
    return value
}

/*  The spot rates the bar shows, per gram rather than per ounce: a coin's
    weight is quoted in grams everywhere except the metal markets, and the
    figure is there to be compared against a listing. */
const GRAMS_PER_TROY_OUNCE = 31.1034768

function spotRates (opened) {
    const now = new Date().toISOString()
    const parts = []
    for (const [metal, label] of [['XAG', 'Ag'], ['XAU', 'Au']]) {
        const spot = opened.spotAt(now, metal)
        if (spot === null) { continue }
        parts.push(label + ' ' + RENDER.gbp(spot.gbpPerOz / GRAMS_PER_TROY_OUNCE) + '/g')
    }
    return parts.length === 0 ? null : parts.join(' · ')
}

/*
    Which list the scanner is showing.

    The mock replaces three stacked panels with one table and a row of pills,
    which is a real change to how the page works: near-spot lots, lots open to
    an offer and completed sales used to be visible at once and are now one at
    a time. The owner chose it deliberately - each list gets the width and the
    density the dense-row design was drawn for, instead of three panels each
    apologising for the other two.

    A bare `/` is the near-spot list, so the URL people already have keeps
    meaning what it meant.
*/
const VIEWS = ['nearSpot', 'offers', 'sold', 'ending']

/*
    The page the reader is actually on, query and all.

    The theme toggle round-trips through the server - it is a link that sets a
    cookie and comes back, because `script-src 'none'` leaves nothing else -
    so this is what it has to come back TO. Built from the pathname alone it
    discarded every parameter the page was showing, and on two pages that is
    not a lost filter but a dead end: /listings and /teach both REQUIRE a
    query parameter and render an error page without one. Changing theme while
    reading a coin type's sales answered "No coin type given", and doing it on
    a teach page answered "That decision is no longer stored", which is not
    even true.

    Folded into the pathname rather than passed beside it. `page` and `menuBar`
    already take four positional arguments and half the call sites pass three,
    so a fifth parameter would have landed in the `view` slot at every one of
    them - a silent wrong-argument bug in twelve places to fix a missing one.
    `menuBar` splits the path back off for the one comparison that needs it.
*/
function whereYouAre (url) {
    return url.pathname + url.search
}


function viewFrom (url) {
    const asked = url === undefined ? null : url.searchParams.get('view')
    return VIEWS.includes(asked) ? asked : 'nearSpot'
}

/*  Which metals to show. Both by default; the pair is a filter, not a choice,
    so turning both off shows both rather than nothing - an empty page is
    never what somebody meant by unticking a box. */
function metalsFrom (url) {
    const raw = url === undefined ? null : url.searchParams.get('metal')
    const asked = (raw || '').split(',').filter(m => m === 'XAU' || m === 'XAG')
    return asked.length === 0 ? ['XAU', 'XAG'] : asked
}

/*  "Updated 2 min ago", rendered once.

    The mock has this ticking. Without script it is accurate at load and
    honest afterwards, which is the better half of the trade: it is measured
    off the last completed sweep, so it says when the DATA was refreshed
    rather than when the page was opened. */
function agoLabel (iso, nowMs) {
    const at = Date.parse(iso)
    if (!Number.isFinite(at)) { return 'never scanned' }
    const minutes = Math.max(0, Math.round(((nowMs === undefined ? Date.now() : nowMs) - at) / 60000))
    if (minutes < 1) { return 'updated just now' }
    if (minutes < 60) { return 'updated ' + minutes + ' min ago' }
    const hours = Math.round(minutes / 60)
    return 'updated ' + hours + (hours === 1 ? ' hour ago' : ' hours ago')
}

/*  The middle value of a list, without pulling in the analytics module for
    one figure. Sorted copy, so the caller's array keeps its own order. */
function medianOf (values) {
    const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
    if (sorted.length === 0) { return null }
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
}

/*  The reference pages, by path. Short names: these were folds on the front
    page whose summaries read like sentences, and a nav label is not the place
    to argue a point. */
const REFERENCE_PATHS = {
    '/premiums': 'premiums',
    '/types': 'types',
    '/composition': 'composition',
    '/uplift': 'uplift',
    '/gaps': 'gaps'
}

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
            /*  Stamped like every other page. This was the one that was not,
                so the error page - the one moment you are already annoyed -
                arrived in the opposite theme to the rest of the app. */
            response.end(RENDER.stampTheme(
                RENDER.page('Error', '<h1>Something went wrong</h1><pre>' +
                    escapeHtml(err.stack || err.message) + '</pre>', whereYouAre(url)),
                themeFrom(request)))
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
            } else if (STATIC.handles(url.pathname)) {
                /*  The stylesheet and the fonts. BEFORE the page router, and
                    that ordering is the whole point: the chain below ends in
                    an unconditional `else` that renders the market page, so
                    until this branch existed a request for /style.css was
                    answered with the front page, as text/html, status 200 -
                    a broken stylesheet that looked like a working one. */
                return STATIC.handle(url.pathname, response)
            } else if (url.pathname === '/theme') {
                /*  Dark or light, without a line of script.

                    The design asks for a toggle that persists and that
                    respects prefers-color-scheme on a first visit. With
                    `script-src 'none'` there is no localStorage to reach, so
                    the choice is a cookie: this link sets it and sends the
                    reader back where they were. No cookie means no
                    data-theme attribute, which means the operating system
                    decides - the first-visit behaviour the design wants,
                    arrived at by doing nothing. */
                return setTheme(url, response)
            } else if (url.pathname === '/teach') {
                html = teachPage(opened, url)
            } else if (url.pathname === '/rule-confirm') {
                html = confirmRulePage(opened, url)
            } else if (url.pathname === '/rules') {
                html = rulesPage(opened, url)
            } else if (REFERENCE_PATHS[url.pathname] !== undefined) {
                /*  Five short pages built from the same tracked-market
                    assembly the scanner uses, which is why they go through
                    marketPage rather than having a function each. */
                html = marketPage(opened, url, REFERENCE_PATHS[url.pathname])
            } else {
                html = marketPage(opened, url)
            }
            response.writeHead(200, HTML_HEADERS)
            response.end(RENDER.stampTheme(html, themeFrom(request)))
        } catch (err) { fail(err) }
    }

    /*  Served pages link the stylesheet; nothing else in the process does.
        Set here rather than passed to all eleven page() calls, and set only
        when a server actually starts - which is why `report build`, running
        in its own process without one, still inlines the sheet into the file
        it produces. */
    RENDER.useStylesheet('/style.css?v=' + STATIC.version())

    /*  What the bar needs and a page shell cannot know. Registered on the
        server only: `report build` has no navigation and no server behind
        the links it would contain. */
    RENDER.useChrome(() => ({
        rates: spotRates(opened),
        counts: scanCounts(opened)
    }))

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

/*  `reference` names one of the five reference pages, or is absent for the
    scanner. One function because they are one query: every reference page is
    built from the same tracked-market assembly the front page already does,
    and splitting them would mean doing it twice. */
function marketPage (opened, url, reference) {
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

    /*  Built only if something asks for it.

        Five of the six pages this function serves never show the uplift chart
        and never evaluate an alert - /gaps renders one paragraph - and this is
        the most expensive thing here on a cold cache. Eager, /gaps spent 1.9s
        of a 4.9s render on a curve nobody was going to see.

        A thunk rather than a hoisted call, because the two callers are far
        apart and one of them is inside the alert loop; memoised, because that
        loop asks per entry. */
    let curveMemo = null
    const curveOf = () => {
        if (curveMemo === null) { curveMemo = view.upliftCurve() }
        return curveMemo
    }

    /*  One block per series, each with its own cap and its own count of what
        the cap left out - a number that has to be visible, or a capped page
        and a complete one look identical. */
    const seriesBlocks = []
    for (const [id, group] of grouped) {
        const shownRows = group.rows.slice(0, PER_SERIES)
        /*  One watermark for the whole block rather than one per coin
            type - see marketsFor. */
        const blockMarkets = view.marketsFor(shownRows.map(r => r.key))
        const entries = shownRows.map(row => ({ row, market: blockMarkets.get(row.key) }))
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
            'synthetic market, or configure eBay credentials and run a sweep.</p></div>', whereYouAre(url))
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
        composition: view.compositionFor(seriesBlocks.length > 1 ? block.id : null)
    }))

    /*  The reference pages are built from these and nothing else, so they
        are defined before the scanner does its own work - pricing every
        live auction and evaluating every offer to answer a question about
        composition would be most of a page load spent on nothing. */
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

    /*
        THE REFERENCE PAGES.

        These five were folds stacked under a heading called "The evidence
        behind these" on the front page, each with a summary written like a
        sentence - "How much auctions rise before the hammer / why an alert can
        fire while you can still act". The owner's verdict was fair: a title
        that needs a subtitle to explain the title is not a title. They are
        pages now, and they are called what they are.

        The explanation did not go away; it moved inside, where somebody who
        opened the page is asking for it. A nav label is not the place to
        argue a point.
    */
    const REFERENCE = {
        premiums: {
            title: 'Premiums',
            lead: 'Where each coin type actually clears, against what sellers are asking. ' +
                'The gap between the two is the room you have to buy inside.',
            body: () => '<div class="card">' + RENDER.premiumChart(chartRows) + '</div>'
        },
        types: {
            title: 'Coin types',
            lead: 'Every type this tool tracks, with where it clears and the most worth bidding.',
            body: () => instrumentTables
        },
        composition: {
            title: 'Composition',
            lead: 'What the tracked market is made of &mdash; and what is missing from it.',
            body: () => compositionBlocks
        },
        uplift: {
            title: 'Bid uplift',
            lead: 'How far an auction climbs between the last quiet hour and the hammer, ' +
                'learned from this tool\'s own snapshots. It is why an alert can reach you ' +
                'while there is still time to act.',
            body: () => '<div class="card">' + RENDER.upliftChart(curveOf()) + '</div>'
        },
        gaps: {
            title: 'Gaps',
            lead: 'Sales this tool holds but will not price, and why.',
            body: () => '<div class="card"><p class="thin" style="margin:0">' +
                '<strong>' + censored + '</strong> ended listings stay out of every clearing ' +
                'price: eBay never publishes what an accepted Best Offer sold for, and counting ' +
                'those at their asking price would overstate the whole market.' +
                (spotGaps > 0
                    ? '<br><br><strong>' + spotGaps + '</strong> sales carry no premium because ' +
                      'the metals feed had a gap at the moment they closed. They are withheld ' +
                      'rather than priced against a stale figure.'
                    : '') +
                '</p></div>'
        }
    }

    if (reference !== undefined && REFERENCE[reference] !== undefined) {
        const page = REFERENCE[reference]
        return RENDER.page(page.title + ' - Coin Market',
            '<h1>' + escapeHtml(page.title) + '</h1>' +
            '<p class="sub">' + page.lead + '</p>' + page.body(),
            whereYouAre(url))
    }

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
    /*  Which list, and which metals, decided before anything is filtered so
        every count on the page describes the same set the table is drawn
        from. */
    const scanView = viewFrom(url)
    const metals = metalsFrom(url)
    const inMetals = (row) => row.metal === undefined || row.metal === null ||
        metals.includes(row.metal)

    const SOLD_FETCHED = 100
    const allSales = repository.recentSales(SOLD_FETCHED)

    /*
        ONE SEARCH FOR THE WHOLE PAGE, not three boxes.

        The front page carries three tables of different things - live
        auctions, lots open to an offer, completed sales - and the question a
        person actually has is about a coin, not about a table. Typing
        "proof" should narrow all three, so the page answers "what is
        happening with proofs" rather than making you ask it three times.

        The ordering is per-table, because the tables are ordered by
        different quantities and always have been: the opportunities panel
        has its own ending-soonest tabs, and this is the sold table's.
    */
    const SOLD_SORTS = ['newest', 'oldest', 'dearest', 'cheapest', 'title']
    const pageTerms = searchTerms(url)
    const soldControlled = applyRowControls(allSales, url, SOLD_SORTS, 'newest')
    const sales = soldControlled.rows

    const pageSearch = controlStrip('/', url, {
        /*  The view rides along, or searching from the sold list would submit
            you back to near-spot - the same lost-parameter fault the coin
            tabs and the back link were both written to avoid. `min` too,
            since it decides how much of the page the search is filtering. */
        carry: Object.assign(
            scanView === 'nearSpot' ? {} : { view: scanView },
            url.searchParams.get('min') ? { min: url.searchParams.get('min') } : {}),
        allowed: SOLD_SORTS,
        fallback: 'newest'
    })
    const pageNarrowed = pageTerms.length === 0
        ? ''
        /*  It used to say "across every table on this page", which was true
            when there were three of them stacked. There is one now, behind
            the pills, so the sentence would have been describing a page that
            no longer exists. */
        : '<p class="thin">Showing rows matching ' +
          pageTerms.map(t => '<code>' + escapeHtml(t) + '</code>').join(' ') +
          '. The other views are searched too.</p>'
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
          '<input type="hidden" name="back" value="' + escapeHtml(whereYouAre(url)) + '">' +
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

    const scanned = opportunities.filter(row => matchesSearch(row, pageTerms)).filter(inMetals)
    const shown = scanned.slice(0, 40)

    /*  Under spot by five per cent or more - the lots the design paints in
        the accent, because they are the ones worth acting on rather than
        merely worth watching. */
    const underSpot = scanned.filter(row => Number.isFinite(row.ratio) && row.ratio <= 0.95).length

    /*  Closing within the hour. Off the same rows, because an auction carries
        a real end time and needs no second query. */
    const inAnHour = Date.now() + 3600000
    const endingSoon = scanned.filter(row => {
        const ends = Date.parse(row.endTime)
        return Number.isFinite(ends) && ends > Date.now() && ends <= inAnHour
    })
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
        for (const alert of ALERT_RULES.evaluate(entry.market, curveOf(), {})) {
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
    const offers = ALERT_RULES.dedupeByListing(offerEntries)
        .filter(entry => matchesSearch(entry.alert, pageTerms))
        .slice(0, 20)

    const offerHtml = offers.length === 0
        ? '<p class="thin">Nothing to offer on right now. A lot only appears here when its coin ' +
          'type has enough completed sales to say where it clears &mdash; ' +
          markets.filter(e => e.market.fairValue.sufficient).length + ' of ' + markets.length +
          ' tracked types do today &mdash; and the ask is no more than a quarter above it.</p>'
        : '<form method="post" action="/apply">' +
          '<input type="hidden" name="back" value="' + escapeHtml(whereYouAre(url)) + '">' +
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
          '<input type="hidden" name="back" value="' + escapeHtml(whereYouAre(url)) + '">' +
          bulkBar(shown, 'Tick anything that is not what it says it is; it leaves this ' +
              'panel and every statistic at once.') +
          cappedQueue(shown, row => queueRow(row, opportunityVerdict(row)), 10,
              n => 'Show the other ' + n + ' auction' + (n === 1 ? '' : 's')) +
          '</form>'


    /*
        Where auctions actually finish, against the metal in the coin.

        The one figure on the strip the tool did not already have. Taken over
        every sold auction in every tracked coin type rather than per type,
        because the strip is describing the scan as a whole - and a median of
        medians would weight a coin type with three sales the same as one
        with three hundred.
    */
    const medianFinish = medianOf(markets.flatMap(entry =>
        (entry.market.outcomes || [])
            .filter(o => o.sold && o.saleType === 'AUCTION' && !o.censored)
            .map(o => o.clearingPremium)))

    const reviewWaiting = repository.reviewAffectingCount()

    /*  Ending soonest or cheapest against spot, as a segmented control
        rather than the pill tabs it used to be. Same two orderings, same two
        parameters - only the shape changed. */
    const sortHref = (value) => {
        const params = []
        if (scanView !== 'nearSpot') { params.push('view=' + scanView) }
        if (value !== null) { params.push('sort=' + value) }
        if (metals.length === 1) { params.push('metal=' + metals[0]) }
        return '/' + (params.length === 0 ? '' : '?' + params.join('&amp;'))
    }
    const viewSort = '<span class="seg">' +
        '<a class="seg-opt' + (sort === 'ending' ? ' on' : '') + '" href="' + sortHref(null) +
        '">Ending soonest</a>' +
        '<a class="seg-opt' + (sort === 'spot' ? ' on' : '') + '" href="' + sortHref('spot') +
        '">Cheapest vs spot</a></span>'

    /*  What each list is and why it is worth looking at. The near-spot text
        is the one that was already here; the others are the blurbs that used
        to sit above the panels this view replaced. */
    const VIEW_BLURBS = {
        nearSpot: 'Auctions on coins the tool can identify, whose current bid is within 5% of ' +
            'the spot value of the metal in them. Worth watching even if you do not bid: where ' +
            'one of these finishes is how fair value gets measured.' +
            (considered > 0 ? ' ' + considered + ' live auctions were checked.' : ''),
        offers: 'Lots with a Best Offer button, asking no more than a quarter above where their ' +
            'coin type actually clears. The button says a seller will listen, not that the price ' +
            'is keener &mdash; measured here, these lots ask a shade MORE than rigid ' +
            'Buy-It-Nows &mdash; so the suggested figure comes from your own ceiling rather than ' +
            'from their asking price.',
        sold: 'Completed sales with a price. Every clearing figure on this page is built from ' +
            'these and nothing else &mdash; an asking price is an opinion, and this is what ' +
            'somebody paid.' + (soldTotal < 30
                ? ' There are not many yet: they only arrive as lots this tool was already ' +
                  'watching come to a close.' : '') +
            (soldTotal > sales.length ? ' Showing the ' + sales.length + ' most recent.' : ''),
        ending: 'The auctions above that close within the hour. This is the last chance to act ' +
            'on one, and the only list here where waiting costs you the lot.'
    }
    const viewBlurb = VIEW_BLURBS[scanView]

    const VIEW_BODIES = {
        nearSpot: shown.length === 0
            ? opportunityHtml
            : scanTable(shown, opportunityVerdict, sweepAt, whereYouAre(url)),
        /*  The offers panel keeps its own row renderer: its whole point is
            the suggested figure and what it is measured against, which is a
            second price column the scanner table does not have. */
        offers: offerHtml,
        sold: (noBuyItNowSales
            ? '<p class="thin costnote"><strong>Every one of these is an auction.</strong> No ' +
              'Buy-It-Now sale has been resolved yet, so the clearing prices on this page are ' +
              'auction prices &mdash; the honest measure of what a coin fetches, but not the ' +
              'whole market.</p>'
            : '') + (noBuyItNowPrices
            ? '<p class="thin costnote"><strong>The Buy-It-Now sales here have no exact ' +
              'price.</strong> Every one of them allowed offers, and eBay never says whether an ' +
              'offer was taken &mdash; so each of those lots sold at its asking price or below ' +
              'it, with no way to tell which. They are marked <em>at most</em>. A plain ' +
              'Buy-It-Now, with no offers allowed, does carry an exact price and will appear ' +
              'here as one.</p>'
            : '') + salesHtml,
        ending: endingSoon.length === 0
            ? '<p class="thin">Nothing closes in the next hour. The soonest is in the near-spot ' +
              'list, ordered by how long you have left.</p>'
            : scanTable(endingSoon, opportunityVerdict, sweepAt, whereYouAre(url))
    }
    const viewBody = VIEW_BODIES[scanView]

    /*
        THE SCANNER.

        One table behind four pills, replacing three stacked panels. Each
        view has its own title, its own blurb and its own rows, and only one
        is on the page at a time - which is what lets the rows be as dense as
        the design draws them instead of three panels each apologising for
        the other two.
    */
    const VIEW_TITLES = {
        nearSpot: ['Auctions at or near spot', shown.length],
        offers: ['Buy-It-Now, open to an offer', offers.length],
        sold: ['What has actually sold', soldTotal],
        ending: ['Auctions ending within the hour', endingSoon.length]
    }
    const [viewTitle, viewCount] = VIEW_TITLES[scanView]

    const pill = (id, label, count) =>
        '<a class="btn ' + (id === scanView ? 'btn-primary' : 'btn-secondary') + ' pill" href="' +
        (id === 'nearSpot' ? '/' : '/?view=' + id) + '">' + escapeHtml(label) +
        (Number.isFinite(count) ? ' <span class="n">' + count + '</span>' : '') + '</a>'

    /*  Silver and gold are links rather than checkboxes: a checkbox needs a
        form and a submit, and the whole row is otherwise navigation. They
        wear the design system's radio dot so the row reads as one set of
        controls. Clicking one toggles it in the URL. */
    const metalToggle = (code, label) => {
        const on = metals.includes(code)
        const next = on ? metals.filter(m => m !== code) : metals.concat([code])
        const query = next.length === 0 || next.length === 2
            ? '' : '&amp;metal=' + next.join(',')
        return '<a class="radio' + (on ? ' on' : '') + '" href="' +
            (scanView === 'nearSpot' ? '/?' : '/?view=' + scanView) + query.replace(/^&amp;/, '') +
            '"><span class="dot"></span>' + escapeHtml(label) + '</a>'
    }

    const body = `
<div class="page-head">
  <div>
    <h6 class="kicker">Coin market &middot; live scan</h6>
    <h3>${escapeHtml(viewTitle)}</h3>
  </div>
  <div class="page-head-right">
    <span class="stamp">${escapeHtml(agoLabel(sweepAt))}</span>
    <a class="btn btn-secondary small" href="${scanView === 'nearSpot' ? '/' : '/?view=' + scanView}"
       title="Reload this list. The collector sweeps eBay on its own every hour; this re-reads
what it has already found.">Rescan</a>
  </div>
</div>

<div class="summary">
  <div class="cell">
    <div class="cell-label">Auctions checked</div>
    <div class="cell-figure">${considered}</div>
  </div>
  <div class="cell">
    <div class="cell-label">At or near spot</div>
    <div class="cell-figure accent">${shown.length}</div>
  </div>
  <div class="cell">
    <div class="cell-label">Under spot by 5%+</div>
    <div class="cell-figure accent">${underSpot}</div>
  </div>
  <div class="cell">
    <div class="cell-label">Median finish vs spot</div>
    <div class="cell-figure">${medianFinish === null ? '—' : pct(medianFinish)}</div>
  </div>
  <div class="cell">
    <div class="cell-label">Needs review</div>
    <div class="cell-figure-row">
      <div class="cell-figure">${reviewWaiting}</div>
      <a href="/review">open</a>
    </div>
  </div>
</div>

<div class="filters">
  <span class="filter-label">View</span>
  ${pill('nearSpot', 'Near spot', shown.length)}
  ${pill('offers', 'Open to an offer', offers.length)}
  ${pill('sold', 'Actually sold', soldTotal)}
  ${pill('ending', 'Ending within the hour', endingSoon.length)}
  <span class="filter-divider"></span>
  ${metalToggle('XAG', 'Silver')}
  ${metalToggle('XAU', 'Gold')}
  <span class="filter-label right">Sort</span>
  ${viewSort}
</div>

<h2 id="${scanView === 'nearSpot' ? 'auctions' : escapeHtml(scanView)}" class="view-heading">${
    escapeHtml(viewTitle)} (${viewCount})</h2>
<p class="thin view-blurb">${viewBlurb}</p>
${pageSearch}
${pageNarrowed}
${viewBody}

`

    return RENDER.page('Coin Market', body, whereYouAre(url), scanView)
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
        return '<span class="settled thin">' + escapeHtml(said) + '</span>' +
            '<button class="btn btn-secondary icon-btn undo" name="undo" value="' + id + '" ' +
            'title="Forget this decision">' + RENDER.icon('cross', 13) + '</button>'
    }
    return '<button class="btn btn-secondary icon-btn no" name="reject" value="' + id + '" ' +
        'title="' + escapeHtml(SERIES.words(sale).notOne) +
        ' - remove it from every clearing figure">' + RENDER.icon('cross') + '</button>'
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
    /*  A tick and a cross. The same pair as every row, at the same size.

        These act on the ticked batch rather than on one row, and that scope
        lives in the tooltip and in the hint beside them - not on the face of
        the button, where it read as "cross selected" and was exactly the
        AI-written clutter the owner has been stripping out of this UI. */
    return '<div class="bulkbar">' +
        '<button class="btn btn-secondary icon-btn no" name="bulk" value="' +
        LEARNED.VERDICT.NOT_TRACKED + '" title="' + escapeHtml(words.notOne) +
        ' - everything ticked">' + RENDER.icon('cross') + '</button>' +
        '<button class="btn btn-secondary icon-btn yes" name="bulk" value="' +
        LEARNED.VERDICT.TRACKED + '" title="Genuine - everything ticked">' +
        RENDER.icon('check') + '</button>' +
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

    /*
        Search, order and group, applied after the sale filter and before the
        split into excluded and uncertain - so both sections describe the
        same set, and the counts under them keep meaning what they say.
    */
    const QUEUE_SORTS = ['unsure', 'newest', 'oldest', 'dearest', 'cheapest', 'title']
    const beforeControls = rows.filter(r => matchesSale(r, sale))
    const controls = applyRowControls(beforeControls, url, QUEUE_SORTS, 'unsure')
    const filtered = controls.rows

    /*  Only the groups actually present, with their counts. Offering the
        pack's whole vocabulary would list groups that select nothing, and a
        filter that can only ever empty the page is a filter nobody trusts
        twice. */
    const groupCounts = new Map()
    const groupNames = new Map()
    for (const row of beforeControls) {
        const key = row.instrumentKey || row.bestGuess || null
        const found = typeof key === 'string' ? SERIES.forKey(key) : null
        if (found === null) { continue }
        const pool = found.rest[0]
        if (!pool) { continue }
        groupCounts.set(pool, (groupCounts.get(pool) || 0) + 1)
        /*  The pack's own name for the pool, not the key lowercased: BRANCH
            reads "branch mint" and EARLY reads "pre-1871", and a filter that
            calls them something else is a filter that does not match the
            badge on the row it is filtering. */
        if (found.pack.pools && found.pack.pools[pool]) { groupNames.set(pool, found.pack.pools[pool]) }
    }
    const groupOptions = [...groupCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([pool, n]) => ({
            value: pool,
            label: (groupNames.get(pool) || String(pool).toLowerCase().replace(/_/g, ' ')) +
                ' (' + n + ')'
        }))

    const queueControls = controlStrip('/review', url, {
        carry: { coin: chosen, sale },
        allowed: QUEUE_SORTS,
        fallback: 'unsure',
        groups: groupOptions
    })

    /*  Say what the strip did, in rows. A search that matches nothing looks
        identical to a queue that is empty, and the two want opposite next
        actions. */
    const narrowed = (controls.terms.length > 0 || controls.group !== null)
        ? '<p class="thin">Showing <strong>' + filtered.length + '</strong> of ' +
          beforeControls.length + ' ' +
          (controls.terms.length > 0
              ? 'matching ' + controls.terms.map(t => '<code>' + escapeHtml(t) + '</code>').join(' ')
              : '') +
          (controls.group !== null
              ? (controls.terms.length > 0 ? ', ' : '') + 'in ' +
                escapeHtml(String(controls.group).toLowerCase().replace(/_/g, ' '))
              : '') +
          '.' + (filtered.length === 0 ? ' Nothing matches - try fewer words.' : '') + '</p>'
        : ''

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
    /*  And the strip. Landing back on an unfiltered queue after every verdict
        is the same lost-parameter bug the tabs were written to avoid: you
        search for "shield", judge one row, and are returned to all 6,000. */
    if (controls.terms.length > 0) {
        backParams.push('q=' + encodeURIComponent(url.searchParams.get('q') || ''))
    }
    if (controls.group !== null) { backParams.push('group=' + encodeURIComponent(controls.group)) }
    if (controls.order !== 'unsure') { backParams.push('order=' + encodeURIComponent(controls.order)) }
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
  ${queueControls}
  ${narrowed}
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
`, whereYouAre(url))
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
    Search, sort and filter, for any table of listings.

    Both working surfaces already hold their rows in memory - the review
    queue fetches the whole queue and narrows it in JS, the drill-down fetches
    500 - so this needs no SQL and no client script. Everything is a query
    parameter, which means a filtered view is a URL: it can be bookmarked,
    reopened, and handed back to you unchanged after a verdict, which the tabs
    already rely on.

    Searching the TITLE and nothing else, on purpose. A coin's title is the
    only field a person reads to decide anything here, and matching against
    prices or ids as well would make "1887" find both a date and a price and
    give no way to say which was meant. Every word must match, so terms
    narrow rather than widen - "victoria shield" is the two together, which
    is what anyone typing it expects.
*/
function searchTerms (url) {
    const raw = url === undefined ? null : (url.searchParams.get('q') || '').trim()
    if (!raw) { return [] }
    return raw.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8)
}

function matchesSearch (row, terms) {
    if (terms.length === 0) { return true }
    const hay = String(row.title || '').toLowerCase()
    return terms.every(term => hay.includes(term))
}

/*
    Sorts shared by both tables.

    Each is a comparator over the row shape both pages already use. Nulls sort
    last in every one of them rather than first: a lot with no premium is not
    the cheapest lot, and a queue that opens on rows it knows nothing about
    is a queue that buries the ones it does.
*/
const NULLS_LAST = (value) => (value === null || value === undefined || !Number.isFinite(value))

const ROW_SORTS = {
    newest: {
        label: 'Newest first',
        compare: (a, b) => String(rowWhen(b)).localeCompare(String(rowWhen(a)))
    },
    oldest: {
        label: 'Oldest first',
        compare: (a, b) => String(rowWhen(a)).localeCompare(String(rowWhen(b)))
    },
    dearest: {
        label: 'Dearest first',
        compare: (a, b) => (rowTotal(b) || 0) - (rowTotal(a) || 0)
    },
    cheapest: {
        label: 'Cheapest first',
        compare: (a, b) => (rowTotal(a) || 0) - (rowTotal(b) || 0)
    },
    premium: {
        label: 'Highest premium',
        compare: (a, b) => {
            if (NULLS_LAST(a.askPremium) && NULLS_LAST(b.askPremium)) { return 0 }
            if (NULLS_LAST(a.askPremium)) { return 1 }
            if (NULLS_LAST(b.askPremium)) { return -1 }
            return b.askPremium - a.askPremium
        }
    },
    bargain: {
        label: 'Lowest premium',
        compare: (a, b) => {
            if (NULLS_LAST(a.askPremium) && NULLS_LAST(b.askPremium)) { return 0 }
            if (NULLS_LAST(a.askPremium)) { return 1 }
            if (NULLS_LAST(b.askPremium)) { return -1 }
            return a.askPremium - b.askPremium
        }
    },
    unsure: {
        label: 'Least certain first',
        compare: (a, b) => {
            const av = Number.isFinite(a.filedConfidence) ? a.filedConfidence
                : (Number.isFinite(a.confidence) ? a.confidence : 2)
            const bv = Number.isFinite(b.filedConfidence) ? b.filedConfidence
                : (Number.isFinite(b.confidence) ? b.confidence : 2)
            return av - bv
        }
    },
    title: {
        label: 'By title',
        compare: (a, b) => String(a.title || '').localeCompare(String(b.title || ''))
    }
}

/*  When a row happened. A live listing is dated by when it appeared; a
    completed sale by when it closed, which is the only date on it and the
    one anybody means by "newest". ISO 8601 sorts as text. */
function rowWhen (row) {
    return row.endedAt || row.firstSeen || row.lastSeen || ''
}

function rowTotal (row) {
    if (row.sold === 1 && Number.isFinite(row.finalPrice)) {
        return row.finalPrice + (row.finalShipping || 0)
    }
    return (row.price || 0) + (row.shipping || 0)
}

/*  The sort asked for, or the page's own default - never a silent fallback
    to something else, because a sort that quietly ignores you reads as a
    broken control rather than an unsupported one. */
function sortFrom (url, allowed, fallback) {
    const asked = url === undefined ? null : url.searchParams.get('order')
    return allowed.includes(asked) ? asked : fallback
}

function applyRowControls (rows, url, allowed, fallback) {
    const terms = searchTerms(url)
    const order = sortFrom(url, allowed, fallback)
    const group = url === undefined ? null : (url.searchParams.get('group') || null)

    let out = rows.filter(row => matchesSearch(row, terms))
    if (group) {
        out = out.filter(row => {
            const key = row.instrumentKey || row.bestGuess || null
            const found = typeof key === 'string' ? SERIES.forKey(key) : null
            return found !== null && found.rest[0] === group
        })
    }
    /*  A copy, sorted. Sorting in place would reorder the array the caller
        also uses for its tab counts, which is how a count and its section
        come to disagree. */
    return { rows: out.slice().sort(ROW_SORTS[order].compare), order, terms, group }
}

/*
    The strip itself.

    One <form method="get">, so every control submits together and the
    parameters this page already depends on - the coin, the sale filter -
    ride along as hidden fields rather than being dropped. Losing them on
    search would be the same lost-parameter bug the tabs were written to
    avoid, one control further along.
*/
function controlStrip (basePath, url, options) {
    const opts = options || {}
    const terms = url === undefined ? '' : (url.searchParams.get('q') || '')
    const order = sortFrom(url, opts.allowed || Object.keys(ROW_SORTS), opts.fallback)
    const group = url === undefined ? null : (url.searchParams.get('group') || '')

    const hidden = Object.entries(opts.carry || {})
        .filter(([, value]) => value !== null && value !== undefined && value !== '')
        .map(([name, value]) => '<input type="hidden" name="' + escapeHtml(name) +
            '" value="' + escapeHtml(String(value)) + '">')
        .join('')

    const sortOptions = (opts.allowed || Object.keys(ROW_SORTS))
        .map(id => '<option value="' + id + '"' + (id === order ? ' selected' : '') + '>' +
            escapeHtml(ROW_SORTS[id].label) + '</option>')
        .join('')

    const groupPicker = !opts.groups || opts.groups.length === 0
        ? ''
        : '<select name="group" title="Show only coins filed under one group.">' +
          '<option value="">every group</option>' +
          opts.groups.map(g => '<option value="' + escapeHtml(g.value) + '"' +
              (g.value === group ? ' selected' : '') + '>' +
              escapeHtml(g.label) + '</option>').join('') +
          '</select>'

    /*  A reset that is a plain link, not a button, so it is obvious it throws
        the whole strip away rather than submitting it. Shown only when there
        is something to throw away. */
    const active = (terms !== '' || group !== '' || order !== opts.fallback)
    const reset = !active ? '' :
        ' <a class="thin" href="' + escapeHtml(basePath +
            (Object.keys(opts.carry || {}).length === 0 ? '' : '?' +
                Object.entries(opts.carry)
                    .filter(([, v]) => v !== null && v !== undefined && v !== '')
                    .map(([k, v]) => k + '=' + encodeURIComponent(String(v))).join('&'))) +
        '">clear</a>'

    return '<form class="strip" method="get" action="' + escapeHtml(basePath) + '">' +
        hidden +
        '<input type="search" name="q" value="' + escapeHtml(terms) + '" ' +
        'placeholder="search titles" title="Every word must appear in the title. ' +
        'Two words narrow rather than widen.">' +
        groupPicker +
        '<select name="order" title="How to order these rows.">' + sortOptions + '</select>' +
        '<button type="submit">Apply</button>' +
        reset +
        '</form>'
}

/*
    The pools a coin of this series could belong to.

    Read off the pack, exactly as the denominations are, so a series added
    later offers its own vocabulary without anyone editing this file. Morgan
    dollars have key dates and common dates; sovereigns have branch mints and
    a pre-1871 band; neither list is written down here.
*/
function poolsFor (hint) {
    const pack = SERIES.get(hint) ||
        (typeof hint === 'string' ? (SERIES.forKey(hint) || {}).pack : null) || null
    if (pack === null || !pack.pools) { return [''] }
    return [''].concat(Object.keys(pack.pools))
}

/*
    Which pool the classifier already put it in, read off the key.

    Positional, like the denomination beside it: a key IS
    `<series>.<pool>.<denomination>...`, so `forKey().rest[0]` is the answer
    for any series, with no vocabulary to maintain here.
*/
function detectedPool (row) {
    const key = row.instrumentKey || row.bestGuess || null
    if (typeof key !== 'string') { return null }
    const found = SERIES.forKey(key)
    if (found === null) { return null }
    const pool = found.rest[0]
    return pool && found.pack.pools && found.pack.pools[pool] ? pool : null
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
    /*  The pool picker, pre-selected to whatever the classifier decided, so
        the common case still needs no interaction: clicking Genuine submits
        the pool it already had. It only asks a question when it reads
        "which kind?", which is when there is one worth answering.

        Beside the denomination rather than hidden behind a drill-down,
        because this is the field the owner had no way of checking while
        giving 192 verdicts - and a control nobody sees is a control nobody
        uses. */
    const pool = detectedPool(row)
    const poolOptions = poolsFor(row.series || row.instrumentKey || row.bestGuess)
        .map(x => '<option value="' + x + '"' + (x === (pool || '') ? ' selected' : '') + '>' +
            (x === '' ? 'which kind?' : escapeHtml(String(x).toLowerCase().replace(/_/g, ' '))) +
            '</option>')
        .join('')

    return '<select name="p_' + id + '" title="Which kind of coin this is, and so which ' +
        'pile of clearing prices it is measured against. The tool works this out from the ' +
        'title; if it has it wrong, the premium beside it and any offer on it are wrong too.">' +
        poolOptions + '</select>' +
        '<select name="d_' + id + '">' + options + '</select>' +
        '<input class="qty" type="number" name="q_' + id + '" min="1" max="99" value="1" ' +
        'title="How many of the same coin are in this lot. Leave at 1 unless it is a multiple.">' +
        /*  The same pair as the scanner, for the same reason: one gesture
            should not have two appearances depending which list you found the
            coin in. The wording that used to be on the face of the button -
            "Not a sovereign", "Not a silver dollar", still series-specific
            from the pack - is the tooltip now. */
        '<button class="btn btn-secondary icon-btn yes" name="genuine" value="' + id +
        '" title="Genuine">' + RENDER.icon('check') + '</button>' +
        '<button class="btn btn-secondary icon-btn no" name="reject" value="' + id +
        '" title="' + escapeHtml(SERIES.words(row).notOne) + '">' +
        RENDER.icon('cross') + '</button>'
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

/*  How long is left, in the fewest characters that still mean something.

    The same three bands the queue row has always used - minutes under an
    hour, hours under a day and a half, days beyond that - pulled out so the
    dense row and the tall one cannot drift apart on the one figure that
    decides whether a lot is worth opening. Returns null past the end, which
    a caller renders as a dash rather than as "ends in -3 min". */
function endsIn (iso) {
    const minutes = Math.round((Date.parse(iso) - Date.now()) / 60000)
    if (!Number.isFinite(minutes) || minutes <= 0) { return null }
    if (minutes < 60) { return minutes + ' min' }
    if (minutes < 60 * 36) { return Math.round(minutes / 60) + 'h' }
    return Math.round(minutes / 1440) + 'd'
}

/*
    THE SCANNER TABLE.

    A row per lot, seven columns, 44px picture, one title line and one meta
    line. It replaces the tall card the queue has used everywhere - and it is
    deliberately NOT queueRow, which stays exactly as it is for the review
    queue and the drill-down where a taller row and the full verdict controls
    are the right shape.

    A TABLE, WHICH THIS APP DELIBERATELY STOPPED USING. `table { min-width:
    720px }` and `td { white-space: nowrap }` are global here, and the whole
    .q-* namespace exists to escape them: the queue was made a list precisely
    because a table scrolled sideways on a phone. So this one carries its own
    scoped rules, wraps where the old one could not, and is checked at 390px.
    Reversing that decision is the one thing in the redesign that undoes
    something measured, and it is done with its eyes open.
*/
function scanRow (row, verdictCell, sweepAt) {
    const id = escapeHtml(String(row.legacyId))
    const total = PREMIUM.totalCost(row.price, row.shipping)
    const metalValue = Number.isFinite(row.metalValue) ? row.metalValue : null
    const ratio = Number.isFinite(row.ratio) ? row.ratio : null

    /*  Signed, and against spot rather than against the ask: "−4%" means the
        metal in it is worth more than the current bid. Filled with the accent
        only at −5% or better, which is the design's way of saying this one is
        worth acting on rather than merely worth watching. */
    const delta = ratio === null ? null : ratio - 1
    const chip = delta === null
        ? '<span class="chip">—</span>'
        : '<span class="chip' + (delta <= -0.05 ? ' hot' : '') + '">' +
          (delta > 0 ? '+' : '') + (delta * 100).toFixed(1) + '%</span>'

    /*  The tick that replaces five words. "Counted in the statistics" was a
        text badge on every row; at this density it was most of the meta line,
        and it says the same thing as one 14px mark. */
    const counted = row.priced
        ? '<span class="ticked" title="Counted in the statistics">' + RENDER.TICKED + '</span>'
        : ''

    const meta = []
    if (Number.isFinite(row.bidCount)) {
        meta.push(row.bidCount + (row.bidCount === 1 ? ' bid' : ' bids'))
    }
    const left = row.endTime ? endsIn(row.endTime) : null
    if (left !== null) { meta.push('ends in ' + left) }
    if (Number.isFinite(row.sellerFeedbackPct)) {
        meta.push(row.sellerFeedbackPct.toFixed(1) + '% seller')
    }
    if (row.lastSeen && !FRESHNESS.isActionable(row.lastSeen, sweepAt)) {
        meta.push('not seen this sweep')
    }

    const name = row.instrumentKey ? INSTRUMENTS.displayName(row.instrumentKey) : null

    return '<tr>' +
        '<td class="pick-cell"><input class="pick" type="checkbox" name="pick" value="' + id +
        '" title="Select this lot for a bulk decision"></td>' +
        '<td class="lot">' +
        '<div class="lot-row">' + shot(row.imageUrl, escapeHtml(row.title || '')) +
        '<div class="lot-text">' +
        '<div class="lot-title">' + counted +
        (row.itemWebUrl
            ? '<a href="' + escapeHtml(row.itemWebUrl) + '" target="_blank" rel="noopener">' +
              escapeHtml(row.title || '') + '</a>'
            : escapeHtml(row.title || '')) +
        '</div>' +
        '<div class="lot-meta">' + escapeHtml(meta.join(' · ')) + '</div>' +
        '</div></div></td>' +
        '<td class="ident">' + (name === null ? '—' : escapeHtml(name)) + '</td>' +
        '<td class="figure bid" data-spot="' +
            (metalValue === null ? '' : escapeHtml(gbp(metalValue))) + '">' + gbp(total) + '</td>' +
        '<td class="figure spot">' + (metalValue === null ? '—' : gbp(metalValue)) + '</td>' +
        '<td class="figure delta">' + chip + '</td>' +
        '<td class="figure ends">' + (left === null ? '—' : escapeHtml(left)) + '</td>' +
        '<td class="verdict-cell">' + scanVerdict(row) + '</td>' +
        '</tr>'
}

/*  Two 26px buttons where there were two wide worded ones.

    Same form, same field names, same POST - only the presentation changes, so
    a decision made here is the decision made anywhere else in the app. The
    noun in the reject button's title comes from the pack, so a Morgan row
    says "Not a silver dollar" and a sovereign says "Not a sovereign"; the
    label moved from the face of the button into its tooltip, which is the one
    thing this trades away for the density.
*/
function scanVerdict (row) {
    const id = escapeHtml(String(row.legacyId))
    if (row.verdict === LEARNED.VERDICT.TRACKED || row.verdict === LEARNED.VERDICT.NOT_TRACKED) {
        const said = row.verdict === LEARNED.VERDICT.TRACKED
            ? 'genuine' : SERIES.words(row).notOne.toLowerCase()
        return '<span class="settled thin" title="You said: ' + escapeHtml(said) + '">' +
            escapeHtml(said) + '</span>' +
            '<button class="btn btn-secondary icon-btn undo" name="undo" value="' + id +
            '" title="Undo that">' + RENDER.icon('cross', 13) + '</button>'
    }
    return '<button class="btn btn-secondary icon-btn yes" name="genuine" value="' + id +
        '" title="Genuine">' + RENDER.icon('check') + '</button>' +
        '<button class="btn btn-secondary icon-btn no" name="reject" value="' + id +
        '" title="' + escapeHtml(SERIES.words(row).notOne) + '">' +
        RENDER.icon('cross') + '</button>'
}

const SCAN_HEAD = '<thead><tr>' +
    '<th class="pick-cell"></th>' +
    '<th class="lot">Lot</th>' +
    '<th class="ident">Identified as</th>' +
    /*  Each header carries its own column's class, not just `figure`.

        Without them `th.spot` and `th.ends` matched nothing, so the narrow
        breakpoints hid the CELLS and left the HEADERS - a table whose columns
        no longer lined up with their titles, and 562px of it in a 390px
        phone. */
    '<th class="figure bid">Bid</th>' +
    /*  "Spot", not "Melt" - the design is explicit about it, and the rest of
        this app has always said spot. */
    '<th class="figure spot">Spot</th>' +
    '<th class="figure delta">vs spot</th>' +
    '<th class="figure ends">Ends</th>' +
    '<th class="verdict-cell">Verdict</th>' +
    '</tr></thead>'

/*  `back` is where a verdict returns you.

    It was the literal '/', which is right for the near-spot list and wrong for
    the other view that shares this table: judging a coin in "ending within the
    hour" bounced you to near-spot, losing the list you were working through.
    The caller knows which view it is rendering; this function does not. */
function scanTable (rows, verdictCell, sweepAt, back) {
    if (rows.length === 0) {
        return '<p class="thin">Nothing here right now.</p>'
    }
    return '<form method="post" action="/apply">' +
        '<input type="hidden" name="back" value="' + escapeHtml(back || '/') + '">' +
        bulkBar(rows, 'A wrong coin here is worth more than a dismissal: it is setting the ' +
            'clearing price every figure above is measured against.') +
        '<div class="card scan-card"><table class="scan">' + SCAN_HEAD + '<tbody>' +
        rows.map(row => scanRow(row, verdictCell, sweepAt)).join('') +
        '</tbody></table></div>' +
        '<p class="thin scan-note"><span class="ticked">' + RENDER.TICKED +
        '</span> counted in the statistics &nbsp; ' +
        'Tick anything that is not what it says it is; it leaves this panel and every ' +
        'statistic at once.</p>' +
        '</form>'
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

    /*
        WHICH COIN THE TOOL THINKS THIS IS, which is the question nobody was
        being shown.

        The owner has been working these rows answering one question - "is
        this a real sovereign?" - while the tool was quietly answering a
        second: which KIND. That second answer decides which pile of clearing
        prices the coin joins, and therefore the ceiling every offer on it is
        measured against, and it was nowhere on the row.

        It is not a small difference. Measured on this store's own sold
        auctions, a full sovereign filed as bullion clears at +9.6% and one
        filed as a proof at +40.6% - so a coin in the wrong pile is a thirty
        point error in what the tool believes it is worth, in whichever
        direction is least helpful. 3,400 lots are filed this way, almost all
        of them off the title alone.

        Confidence is shown when it is poor rather than always: a number
        beside every row is noise, and 0.97 tells a reader nothing they need
        to act on. Below 0.7 it is a coin the classifier was guessing at, and
        those are the ones worth a second look - 43 of 239 in GRADED.FULL, 38
        of 411 in BULLION.FULL.
    */
    const filedAs = row.instrumentKey || row.bestGuess || null
    if (filedAs === null) {
        /*  Worth saying rather than leaving blank. An unplaced coin is not a
            coin filed wrongly - it is one the tool could not place at all,
            which is a different job for the reviewer and the only case where
            no group is the honest answer. */
        meta.push('<span class="badge critical" title="The tool could not work out ' +
            'which group this coin belongs to, so it is counted in no clearing figure ' +
            'and has no premium.">no group</span>')
    } else {
        const name = INSTRUMENTS.displayName(filedAs)
        /*  filedConfidence is how sure the classifier was of the group it
            ACTUALLY filed the coin under; row.confidence, on a queued row, is
            how sure it was of the guess it could not commit to. Prefer the
            first: it is the number attached to the badge being drawn. */
        const sureness = Number.isFinite(row.filedConfidence) ? row.filedConfidence : row.confidence
        const shaky = Number.isFinite(sureness) && sureness < 0.7
        meta.push('<span class="badge' + (shaky ? ' critical' : '') +
            '" title="The tool has filed this as ' + escapeHtml(name) + ' (' +
            escapeHtml(filedAs) + '), and that is the group whose clearing prices ' +
            'its premium and any offer on it are measured against. If the group is ' +
            'wrong, both numbers are wrong.' +
            (shaky
                ? ' It is only ' + Math.round(sureness * 100) + '% sure of that, ' +
                  'which is low - worth a look.'
                : '') +
            '">' + escapeHtml(name) + (shaky ? ' &middot; unsure' : '') + '</span>')
    }

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
            '<h1>No coin type given</h1><p class="sub"><a href="/">Back to the market</a>.</p>', whereYouAre(url))
    }

    const sale = saleFrom(url)
    const FETCH = 500
    const fetchedRows = repository.listingsForInstrument(key, FETCH, sale)
    /*  Same strip as the review queue, minus the group picker: every row on
        this page is already one group by definition, so offering to filter
        by it would be a control with one option. */
    const DRILL_SORTS = ['dearest', 'cheapest', 'premium', 'bargain', 'newest', 'oldest', 'title']
    const drill = applyRowControls(fetchedRows, url, DRILL_SORTS, 'dearest')
    const rows = drill.rows
    const drillControls = controlStrip('/listings', url, {
        carry: { key, sale }, allowed: DRILL_SORTS, fallback: 'dearest'
    })
    const drillNarrowed = drill.terms.length === 0
        ? ''
        : '<p class="thin">Showing <strong>' + rows.length + '</strong> of ' +
          fetchedRows.length + ' matching ' +
          drill.terms.map(t => '<code>' + escapeHtml(t) + '</code>').join(' ') + '.' +
          (rows.length === 0 ? ' Nothing matches - try fewer words.' : '') + '</p>'
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
  ${drillControls}
  ${drillNarrowed}
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
`, whereYouAre(url))
}

/* ------------------------------------------------ recording a decision */

/*
    Only ever our own pages. The value comes back through a form field, and
    a redirect target taken from input without checking is how an open
    redirect happens - even on a loopback-only service, it is not a habit
    worth having.
*/
/*  The pages you can be sent back to.

    Hand-kept, this list went stale the moment five new pages existed: the
    theme toggle passes the page you are on through here, and /gaps was not on
    it, so changing theme anywhere in Reference silently dumped you on the
    review queue. The reference paths are read from the routing table instead
    of copied out of it, so a sixth page is on this list by existing.

    Everything else about it is unchanged - it is an allow-list because `back`
    arrives in a query string, and an unchecked one is an open redirect. */
const BACK_PATHS = new Set(
    ['/', '/review', '/listings', '/rules', '/teach', '/rule-confirm']
        .concat(Object.keys(REFERENCE_PATHS))
)

function safeBack (value) {
    if (typeof value !== 'string' || !value.startsWith('/')) { return '/review' }
    if (value.startsWith('//')) { return '/review' }
    return BACK_PATHS.has(value.split('?')[0]) ? value : '/review'
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
                /*  Like the denomination: only meaningful alongside
                    "genuine", and an untouched dropdown must not be stored
                    as a correction. */
                pool: verdict === LEARNED.VERDICT.SOVEREIGN
                    ? (form.get('p_' + legacyId) || null)
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
            pool: verdict === LEARNED.VERDICT.SOVEREIGN ? (form.get('pool') || null) : null,
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
            '<a href="/review">Back to the review queue</a>.</p>', whereYouAre(url))
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
        '">No rule &mdash; just this listing</a></p>', whereYouAre(url))
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
        return RENDER.page('Confirm - Coin Market', '<h1>No rule given</h1>', whereYouAre(url))
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
        button + cancel + '</form>', whereYouAre(url))
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
`, whereYouAre(url))
}
