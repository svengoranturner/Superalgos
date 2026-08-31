'use strict'

const HTTP = require('node:http')
const RENDER = require('./render.js')
const INSTRUMENTS = require('../catalogue/instruments.js')
const ALERT_RULES = require('../alerts/rules.js')
const LEARNED = require('../catalogue/learned.js')
const CLASSIFY = require('../catalogue/classify.js')
const RECLASSIFY = require('../catalogue/reclassify.js')

const { escapeHtml, pct, gbp } = RENDER

/*
    The local dashboard. Binds to loopback by default - it holds your
    buying intentions and there is no reason for it to be reachable from
    the network.
*/

exports.start = function (opened, options) {

    const config = Object.assign({ port: 34260, host: '127.0.0.1' }, options || {})

    const server = HTTP.createServer((request, response) => {
        const url = new URL(request.url, 'http://' + config.host)

        const fail = (err) => {
            response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(RENDER.page('Error', '<h1>Something went wrong</h1><pre>' +
                escapeHtml(err.stack || err.message) + '</pre>'))
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
            } else if (url.pathname === '/teach') {
                html = teachPage(opened, url)
            } else if (url.pathname === '/rule-confirm') {
                html = confirmRulePage(opened, url)
            } else if (url.pathname === '/rules') {
                html = rulesPage(opened, url)
            } else {
                html = marketPage(opened, url)
            }
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(html)
        } catch (err) { fail(err) }
    })

    server.listen(config.port, config.host, () => {
        console.log('Coin Market dashboard: http://' + config.host + ':' + config.port)
        console.log('Press Ctrl+C to stop.')
    })

    return server
}

function marketPage (opened, url) {
    const { repository, view } = opened
    const minSample = Number(url.searchParams.get('min')) || 3

    const instruments = repository.instruments(0, 3)
        .filter(row => row.listingCount >= minSample)
        .slice(0, 40)

    const curve = view.upliftCurve()
    const markets = instruments.map(row => ({ row, market: view.forInstrument(row.key) }))
        .filter(entry => entry.market.fairValue.sufficient || entry.market.liquidity.askSampleSize > 0)

    if (markets.length === 0) {
        return RENDER.page('Coin Market',
            '<h1>Coin Market</h1><p class="sub">Nothing tracked yet.</p>' +
            '<div class="card"><p>Run <code>node bin/cli.js demo</code> to see the tool working on a ' +
            'synthetic market, or configure eBay credentials and run a sweep.</p></div>')
    }

    /* Headline: the cost of paying the asking price, in money. */
    const headline = markets.find(e => e.market.fairValue.sufficient &&
        e.market.liquidity.askClearingSpread !== null) || markets[0]
    const hm = headline.market
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

    const tableRows = markets.map(e => {
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
    const composition = repository.marketComposition()
    const sales = repository.recentSales(15)
    const spotNow = opened.spotAt(new Date().toISOString())
    const salesHtml = sales.length === 0
        ? '<p class="thin">No completed sales resolved yet.</p>'
        : '<div class="card scroll"><table><thead><tr><th>Sold</th><th>Coin type</th>' +
          '<th>Price</th><th>Bids</th><th>Premium over spot</th></tr></thead><tbody>' +
          sales.map(sale => {
              const paid = sale.finalPrice + (sale.finalShipping || 0)
              const premium = spotNow === null || !Number.isFinite(sale.fineOz) || sale.fineOz <= 0
                  ? null
                  : (paid / (sale.fineOz * spotNow.gbpPerOz)) - 1
              return '<tr>' +
                  '<td class="thin">' + escapeHtml(String(sale.endedAt || '').slice(0, 10)) + '</td>' +
                  '<td>' + (sale.itemWebUrl
                      ? '<a href="' + escapeHtml(sale.itemWebUrl) + '" target="_blank" rel="noopener">' +
                        escapeHtml(sale.title.slice(0, 58)) + '</a>'
                      : escapeHtml(sale.title.slice(0, 58))) + '</td>' +
                  '<td class="mono"><strong>' + gbp(paid) + '</strong></td>' +
                  '<td class="mono">' + (Number.isFinite(sale.finalBidCount) ? sale.finalBidCount : '—') + '</td>' +
                  '<td class="mono">' + (sale.censored === 1
                      ? '<span class="thin">not published</span>'
                      : pct(premium)) + '</td>' +
                  '</tr>'
          }).join('') + '</tbody></table></div>'

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
    const sort = url.searchParams.get('sort') === 'spot' ? 'spot' : 'ending'
    const spotForOpportunities = opened.spotAt(new Date().toISOString())
    const PREMIUM = require('../analytics/premium.js')

    let opportunities = []
    let considered = 0
    if (spotForOpportunities !== null) {
        opportunities = repository.liveAuctions(500)
            .map(row => {
                const total = PREMIUM.totalCost(row.price, row.shipping)
                const gold = row.fineOz * spotForOpportunities.gbpPerOz
                return Object.assign({}, row, { total, gold, ratio: gold > 0 ? total / gold : null })
            })
            .filter(row => Number.isFinite(row.ratio))
        considered = opportunities.length
        opportunities = opportunities
            .filter(row => row.ratio <= NEAR_SPOT)
            /*  A coin you have already judged not to be a sovereign is not an
                opportunity, whatever its price. */
            .filter(row => row.verdict !== LEARNED.VERDICT.NOT_SOVEREIGN)

        /*
            Ending soonest by default. The % of spot badge already tells you
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
    for (const row of shown) { row.back = '/' }

    /*  Keep any min= the owner arrived with, so switching the ordering does
        not silently widen the sample underneath them. */
    const sortParams = url.searchParams.get('min') ? { min: url.searchParams.get('min') } : {}
    const opportunitySort = shown.length === 0 ? '' : tabs('/', 'sort', [
        { value: 'ending', label: 'Ending soonest', isDefault: true },
        { value: 'spot', label: 'Cheapest against spot' }
    ], sort, sortParams)

    const opportunityVerdict = newPlausibilityCell(spotForOpportunities)
    const opportunityHtml = shown.length === 0
        ? '<p class="thin">No live auction is currently at or near the spot value of its gold. ' +
          considered + ' were checked.</p>'
        : '<form method="post" action="/apply">' +
          '<input type="hidden" name="back" value="/">' +
          '<div class="bulkbar">' +
          '<button class="no" name="bulk" value="' + LEARNED.VERDICT.NOT_SOVEREIGN + '">' +
          'Not a sovereign &mdash; selected</button>' +
          '<button class="yes" name="bulk" value="' + LEARNED.VERDICT.SOVEREIGN + '">' +
          'Genuine &mdash; selected</button>' +
          '<span class="thin">Tick anything that is not what it says it is; it leaves this ' +
          'panel and every statistic at once.</span></div>' +
          '<div class="card"><div class="queue">' +
          shown.map(row => queueRow(row, opportunityVerdict(row))).join('') +
          '</div></div></form>'

    const censored = markets.reduce((sum, e) => sum + e.market.liquidity.censoredOutcomes, 0)
    const spotGaps = markets.reduce((sum, e) => sum + e.market.spotGaps, 0)

    const body = `
<h1>Coin Market</h1>
<p class="sub">What sovereigns actually sell for, measured against their gold content.</p>
${countryPicker(repository)}

<div class="card hero">
  <div>
    <div class="n">${overpay === null ? '—' : gbp(overpay)}</div>
    <div class="l">what paying the asking price costs you, per coin, versus where auctions clear
      — ${escapeHtml(INSTRUMENTS.displayName(headline.row.key))}</div>
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
    <div class="l">gold, £/oz, from your metals.dev feed</div>
  </div>
</div>

<h2>Where each coin type clears, against what sellers ask</h2>
<div class="card">${RENDER.premiumChart(chartRows)}</div>

<h2>Live auctions at or near spot (${shown.length})</h2>
<p class="thin">Auctions on coins the tool can identify, whose current bid is within 5% of the
spot value of the gold in them. Worth watching even if you do not bid: where one of these
finishes is how fair value gets measured.
${considered > 0 ? considered + ' live auctions were checked.' : ''}</p>
${opportunitySort}
${opportunityHtml}

<h2>What the tracked market is made of</h2>
<div class="card">
  ${RENDER.compositionChart(composition)}
  <p class="thin" style="margin:14px 0 0">
    <strong>Buy-It-Now outcomes are not observed at all.</strong> A Buy-It-Now listing is
    Good-'Til-Cancelled and carries no end time, so it never becomes eligible for outcome
    resolution &mdash; every one of the ${composition.auctionSold + composition.auctionUnsold}
    completed lots here is an auction. So the clearing prices describe the auction market, the
    asking prices are ${Math.round(100 * composition.liveBin / (composition.liveBin + composition.liveAuction))}%
    Buy-It-Now, and the spread between them compares two markets rather than two ends of one.
    ${composition.binVanished > 0
        ? '<strong>' + composition.binVanished + '</strong> Buy-It-Now listings have gone quiet ' +
          'without being resolved; each has either sold or been withdrawn and we cannot yet tell which.'
        : ''}</p>
</div>

<h2>What has actually sold (${sales.length})</h2>
<p class="thin">Completed auctions with a hammer price. Every clearing figure on this page is
built from these and nothing else &mdash; an asking price is an opinion, and this is what somebody
paid. ${sales.length < 30
    ? 'There are not many yet: they only arrive as lots this tool was already watching come to a close.'
    : ''}</p>
${salesHtml}

<h2>Every tracked coin type</h2>
<div class="card scroll">
<table>
  <thead><tr>
    <th>Coin type</th>
    <th title="Completed auction sales this figure is built from, over 180 days and weighted so a sale 45 days old counts half as much as today's. Under three and the clearing columns stay blank.">Sales</th>
    <th title="Where auctions actually clear, as a premium over the coin's gold content. Sold auctions only, and never accepted Best Offers, whose price eBay does not publish.">Clears at</th>
    <th title="The middle half of those clearing prices: a quarter of sales went below the first number, a quarter above the second. A wide band means the price depends on the coin, not the type.">p25–p75</th>
    <th title="What the Buy-It-Now shelf is asking right now, as a premium over gold. Fixed-price listings only - a running auction has no asking price, just a bid so far.">Asks</th>
    <th title="Asks minus Clears at, in percentage points. What paying a Buy-It-Now costs you over waiting for an auction - and the room you have to make an offer.">Spread</th>
    <th title="Of the lots that ENDED in the last 90 days, the share that sold. Low means the shelf is priced above what anyone will pay. A seller who relists doggedly pushes this down.">Sell-through</th>
    <th title="Median number of bids on auctions that got at least one, over 90 days. Auctions that ended with no bids at all are excluded, so this says how contested a lot is once bidding starts - not how often it starts.">Bids</th>
    <th title="Listings on sale right now: not ended, and seen by a sweep within the last 24 hours. Counts auctions as well as Buy-It-Now, so it is usually larger than the sample behind Asks.">Live</th>
    <th title="The most you should BID, from the clearing distribution at your target quantile. This is the number to type into eBay: the buyer protection fee eBay adds on top has already been taken out of it, so winning at this bid lands you on fair value rather than 2-5% above it. Blank when there are too few sales to say.">Bid up to</th>
  </tr></thead>
  <tbody>${tableRows}</tbody>
</table>
</div>

<h2>How much auctions rise before the hammer</h2>
<div class="card">
  ${RENDER.upliftChart(curve)}
  <p class="thin">Learned from this tool's own snapshots. It is why an alert can fire while
  you can still act, instead of after the lot has gone.</p>
</div>

<h2>What this cannot see</h2>
<div class="card">
  <p class="thin" style="margin:0">
    <strong>${censored}</strong> ended listings are excluded from clearing prices because eBay never
    publishes what an accepted Best Offer sold for — counting those at list price would
    systematically overstate the market.
    ${spotGaps > 0 ? '<br><strong>' + spotGaps + '</strong> sales have no premium because the gold feed had a gap at the moment they closed; they are withheld rather than priced against a stale figure.' : ''}
  </p>
</div>`

    return RENDER.page('Coin Market', body)
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
function newPlausibilityCell (spot) {
    const PLAUSIBILITY = require('../analytics/plausibility.js')
    const COINS = require('../catalogue/coins.js')

    return (row) => {
        if (spot === null) { return '' }
        const total = (row.price || 0) + (row.shipping || 0)

        let fineOz = Number.isFinite(row.fineOz) ? row.fineOz : null
        let measuredAgainst = 'the coin it is classified as'
        let assumed = false

        if (fineOz === null) {
            const guessed = typeof row.bestGuess === 'string'
                ? row.bestGuess.split('.').find(part => COINS.DENOMINATIONS[part] !== undefined)
                : undefined
            const denomination = COINS.DENOMINATIONS[guessed] || COINS.DENOMINATIONS.QUARTER
            fineOz = denomination.fineOz
            measuredAgainst = denomination.label
            assumed = guessed === undefined
        }

        /*  A running auction is judged differently: its current bid is not a
            claim about the coin, it is an opening position. */
        const running = /AUCTION/i.test(String(row.buyingOptions || '')) &&
            row.endTime !== null && row.endTime !== undefined &&
            new Date(row.endTime).getTime() > Date.now()

        const v = PLAUSIBILITY.assess(total, fineOz, spot.gbpPerOz, { liveAuction: running })
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
                (assumed ? ', the smallest sovereign, because the denomination is unknown.' : '.')) +
            '">' + escapeHtml(v.label) + '</span> <span class="thin mono">' +
            Math.round(v.percentOfSpot) + '% of spot</span>'
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
            return option.value === current
                ? '<span class="tab on">' + escapeHtml(option.label) + '</span>'
                : '<a class="tab" href="' + escapeHtml(href) + '">' +
                  escapeHtml(option.label) + '</a>'
        }).join('') + '</div>'
}

function saleTabs (basePath, current, params) {
    return tabs(basePath, 'sale', [
        { value: 'all', label: 'Everything', isDefault: true },
        { value: 'auction', label: 'Auctions only' },
        { value: 'bin', label: 'Buy-It-Now only' }
    ], current, params)
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
          ' marked ' + (appliedVerdict === LEARNED.VERDICT.SOVEREIGN
              ? 'genuine' : 'not a sovereign') +
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
    const fetched = opened.repository.reviewQueue(QUEUE_LIMIT + 1)
    const truncated = fetched.length > QUEUE_LIMIT
    const rows = truncated ? fetched.slice(0, QUEUE_LIMIT) : fetched
    const verdictCell = newPlausibilityCell(opened.spotAt(new Date().toISOString()))

    const sale = ['auction', 'bin'].includes(url === undefined ? null : url.searchParams.get('sale'))
        ? url.searchParams.get('sale')
        : 'all'
    const filtered = rows.filter(r => matchesSale(r, sale))
    const back = '/review' + (sale === 'all' ? '' : '?sale=' + sale)
    for (const row of filtered) { row.back = back }

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
    const bar = (where) => '<div class="bulkbar">' +
        '<button class="no" name="bulk" value="' + LEARNED.VERDICT.NOT_SOVEREIGN + '">' +
        'Not a sovereign &mdash; selected</button>' +
        '<button class="yes" name="bulk" value="' + LEARNED.VERDICT.SOVEREIGN + '">' +
        'Genuine &mdash; selected</button>' +
        (where === 'top'
            ? '<span class="thin">Tick down the left, then one click. ' +
              'Anything you have not ticked is untouched.</span>'
            : '') +
        '</div>'

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

    return RENDER.page('Needs review - Coin Market', `
<h1>Needs review</h1>
<p class="sub">Listings the classifier would not price without a human decision. Every statistic
in this tool is computed over what survives this filter, so it is shown rather than hidden.</p>
${applied}

<div class="card">
  <p class="thin" style="margin:0">Click a photo to see it large. Mark one and it is settled for
  good &mdash; the decision is stored against the coin, survives a relist, outranks every rule in
  the classifier, and the collector applies it to listings it finds tomorrow. Say
  <em>not a sovereign</em> and you are then offered a rule that generalises it, with the count of
  what it would catch and what it would break.
  ${settled > 0 ? '<strong>' + settled + '</strong> of the listings below are already settled.' : ''}</p>
</div>

<div class="card">
  ${saleTabs('/review', sale)}
  <p class="thin" style="margin:10px 0 0">A live lot is filtered on how it is offered, a
  completed one on how it actually sold. ${sale === 'bin'
      ? 'No Buy-It-Now lot has a recorded outcome yet &mdash; they carry no end time, so the tool never learns whether they sold.'
      : ''}</p>
</div>

<h2>Making a number wrong right now (${affecting.length})</h2>
<p class="thin">Flagged as uncertain, but still counted in the market statistics. These are the
ones behind anything that looks wrong on the front page.</p>
${list(affecting, 'Nothing uncertain is currently being priced.')}

<h2>Uncertain, but not being priced (${inert.length})</h2>
${list(inert, 'Nothing else awaiting a decision.', 150)}

<h2>Deliberately excluded (${excluded.length})</h2>
<p class="thin">Mounts, copies, cases and multi-coin lots. If something here looks wrongly
dropped, mark it genuine &mdash; that overrides the rule that dropped it, which is the failure
mode worth watching for: a bad rule quietly eating half the market.</p>
${list(excluded, 'Nothing excluded.', 150)}
${truncated ? '<p class="thin warn">The queue is longer than this page reads &mdash; only the first ' + QUEUE_LIMIT + ' rows were fetched, so the counts above are floors rather than totals.</p>' : ''}
`)
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

const DENOMINATION_OPTIONS = ['', 'FULL', 'HALF', 'QUARTER', 'DOUBLE', 'QUINTUPLE']

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
function detectedDenomination (row) {
    const key = row.bestGuess || row.instrumentKey || null
    if (typeof key !== 'string') { return null }
    return key.split('.').find(part => DENOMINATION_OPTIONS.includes(part)) || null
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
            : 'You said: not a sovereign'
        return '<span class="settled">' + said + '</span> ' +
            '<button class="plain" name="undo" value="' + id + '" title="Forget this decision">undo</button>'
    }

    /*  Pre-selected to whatever the classifier already worked out, so the
        common case needs no interaction at all: clicking Genuine submits the
        denomination it already had. The dropdown only asks a question when it
        reads "denomination?", which is exactly when there is one to answer. */
    const detected = detectedDenomination(row)
    const options = DENOMINATION_OPTIONS
        .map(d => '<option value="' + d + '"' + (d === (detected || '') ? ' selected' : '') + '>' +
            (d === '' ? 'denomination?' : d.toLowerCase()) + '</option>')
        .join('')

    /*  Field names carry the listing id, because one form now covers the
        whole section: the handler reads the denomination and quantity
        belonging to each row it is acting on, whether that is this one row or
        every ticked one. */
    return '<select name="d_' + id + '">' + options + '</select>' +
        '<input class="qty" type="number" name="q_' + id + '" min="1" max="99" value="1" ' +
        'title="How many of the same coin are in this lot. Leave at 1 unless it is a multiple.">' +
        '<button class="yes" name="genuine" value="' + id + '">Genuine</button>' +
        '<button class="no" name="reject" value="' + id + '">Not a sov</button>'
}

function queueRow (row, verdictCell) {
    const big = largerImage(row.imageUrl)
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
  ${(() => {
      /*  A <details> rather than a hover, because hovering opened the
          preview while the pointer was merely on its way somewhere and it
          covered the title underneath. Click to open, click to close, and it
          stays put while you read it. No JavaScript: <summary> is focusable
          and toggles on Enter or Space, so it is keyboard-workable too. */
      const thumb = row.imageUrl
          ? '<img src="' + escapeHtml(row.imageUrl) + '" alt="" loading="lazy" decoding="async">'
          : '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">'
      if (!big) { return '<div class="q-shot">' + thumb + '</div>' }
      return '<details class="q-shot" style="--shot:url(&quot;' + escapeHtml(big) + '&quot;)">' +
          '<summary title="Click for a larger picture">' + thumb + '</summary>' +
          '<div class="q-big">' + (caption ? '<div class="cap">' + caption + '</div>' : '') + '</div>' +
          '</details>'
  })()}
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
            '<h1>No coin type given</h1><p class="sub"><a href="/">Back to the market</a>.</p>')
    }

    const sale = ['auction', 'bin'].includes(url.searchParams.get('sale'))
        ? url.searchParams.get('sale')
        : 'all'
    const rows = repository.listingsForInstrument(key, 500, sale)
    const verdictCell = newPlausibilityCell(opened.spotAt(new Date().toISOString()))
    for (const row of rows) {
        row.back = '/listings?key=' + encodeURIComponent(key) +
            (sale === 'all' ? '' : '&sale=' + sale)
        /*  The drill-down knows the instrument from the URL, so the controls
            can pre-select the denomination here too. */
        row.instrumentKey = key
    }

    const name = INSTRUMENTS.displayName(key)
    const market = view.forInstrument(key)

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
    const live = rows.filter(r => r.sold !== 1 && r.live === 1)
    const unsold = rows.filter(r => r.sold !== 1 && r.live !== 1)

    /*  The number that justifies this page existing. Of the live listings
        counted into an instrument, most were never flagged for review at
        all - they classified confidently and wrongly - so the review queue
        could not reach them from any direction. */
    const unflagged = live.filter(r => !r.reason).length
    const settled = rows.filter(r => r.verdict).length

    /*  Capped, and says so. Dearest first means the lots most likely to be
        distorting the number are at the top, so a cap costs little - but a
        list that silently stops is a list you would wrongly believe you had
        worked through. */
    const CAP = 200
    const bar = '<div class="bulkbar">' +
        '<button class="no" name="bulk" value="' + LEARNED.VERDICT.NOT_SOVEREIGN + '">' +
        'Not a sovereign &mdash; selected</button>' +
        '<button class="yes" name="bulk" value="' + LEARNED.VERDICT.SOVEREIGN + '">' +
        'Genuine &mdash; selected</button></div>'

    const list = (items) => '<form method="post" action="/apply">' +
        '<input type="hidden" name="back" value="' +
        escapeHtml('/listings?key=' + key + (sale === 'all' ? '' : '&sale=' + sale)) + '">' +
        bar +
        '<div class="card"><div class="queue">' +
        items.slice(0, CAP).map(r => queueRow(r, verdictCell(r))).join('') + '</div>' +
        (items.length > CAP
            ? '<p class="thin" style="margin:12px 0 0">Showing the dearest ' + CAP +
              ' of ' + items.length + '.</p>'
            : '') + '</div>' + bar + '</form>'

    return RENDER.page(name + ' - Coin Market', `
<h1>${escapeHtml(name)}</h1>
<p class="sub">Every listing counted under this coin type. Anything here that is not this coin is
moving the numbers on the front page.</p>

<div class="card hero">
  <div><div class="n">${sold.length}</div><div class="l">completed sales &mdash; the evidence
    everything else is measured against</div></div>
  <div><div class="n">${live.length}</div><div class="l">live listings counted here</div></div>
  <div><div class="n">${pct(market.liquidity.medianAskPremium)}</div>
    <div class="l">median asking premium over gold content</div></div>
  <div><div class="n">${unflagged}</div>
    <div class="l">of them never flagged for review &mdash; they classified confidently, so this
      page is the only way to reach them</div></div>
  ${settled > 0 ? '<div><div class="n">' + settled + '</div><div class="l">you have judged</div></div>' : ''}
</div>

<div class="card">
  ${saleTabs('/listings', sale, { key })}
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
    : list(sold)}

<h2>On sale now (${live.length})</h2>
<p class="thin">Dearest first &mdash; within one coin type that is also the highest premium, and a
lot priced far from its neighbours is both the most likely to be wrong and the most visible when
it is. Click a photo to see it large. If the coin is real but the denomination is wrong, set it
in the dropdown and mark it genuine rather than dismissing it.</p>
${live.length === 0 ? '<p class="thin">Nothing live under this coin type.</p>' : list(live)}

${unsold.length === 0 ? '' : `<h2>Ended without selling (${unsold.length})</h2>
<p class="thin">The asking price was refused. Useful for the sell-through rate, and worth
nothing at all as a clearing price.</p>
${list(unsold)}`}

<p style="margin-top:18px"><a href="/">Back to the market</a></p>
`)
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

        repository.saveLearnedRule({
            phrase,
            kind: LEARNED.VERDICT.NOT_SOVEREIGN,
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
    What one phrase would actually do, recomputed from the corpus.

    Used both to rank proposals and to spell out the consequences on the
    confirmation page - the same numbers in both places, so what you are
    shown before clicking and what you are asked to confirm cannot drift.
*/
function ruleEffect (repository, phrase) {
    const test = LEARNED.phrasePattern(phrase)
    const matches = repository.titleCorpus().filter(row => test.test(row.title))
    const breaks = matches.filter(row => row.priced)
    const conflicts = repository.labels()
        .filter(l => l.verdict === LEARNED.VERDICT.SOVEREIGN && test.test(l.title))
    return {
        phrase,
        support: matches.length,
        breaks: breaks.length,
        breakSamples: breaks.slice(0, 30).map(b => b.title),
        samples: matches.slice(0, 6).map(m => m.title),
        conflicts: conflicts.map(c => c.title)
    }
}

function proposalCard (p, back, legacyId) {
    const risky = p.breaks > 0 || p.conflicts.length > 0
    const consequence = p.breaks === 0
        ? ', <strong>none</strong> of which are currently priced as sovereigns.'
        : ', and would stop pricing <strong class="warn">' + p.breaks +
          '</strong> that count towards the market statistics today.'

    /*  A rule that breaks nothing can be taken in one click. A rule that
        would remove real coins from the statistics gets a confirmation page
        naming every one of them - the difference between those two cases is
        the whole reason `breaks` is measured. */
    const action = risky
        ? '<a class="confirm" href="/rule-confirm?phrase=' + encodeURIComponent(p.phrase) +
          '&amp;legacy=' + encodeURIComponent(legacyId) + '&amp;back=' + encodeURIComponent(back) +
          '">Review what this would remove&hellip;</a>'
        : '<form method="post" action="/rule" style="margin-top:10px">' +
          '<input type="hidden" name="back" value="' + escapeHtml(back) + '">' +
          '<input type="hidden" name="phrase" value="' + escapeHtml(p.phrase) + '">' +
          '<input type="hidden" name="support" value="' + p.support + '">' +
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
            '<a href="/review">Back to the review queue</a>.</p>')
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
        ? safe.map(p => proposalCard(p, back, legacyId)).join('')
        : nothingSafe

    const riskyHtml = risky.length === 0 ? '' : '<details>' +
        '<summary>' + risky.length + ' other phrase' + (risky.length === 1 ? '' : 's') +
        ' would also match, but ' + (risky.length === 1 ? 'it removes' : 'they remove') +
        ' coins from the statistics</summary>' +
        '<p class="thin">These need checking rather than clicking. Each one opens a page ' +
        'listing exactly what it would stop pricing.</p>' +
        risky.map(p => proposalCard(p, back, legacyId)).join('') +
        '</details>'

    return RENDER.page('Teach - Coin Market',
        '<h1>Should that apply to others?</h1>' +
        '<p class="sub">You marked <em>' + escapeHtml(label.title) + '</em> as not a sovereign. ' +
        'Here is what that decision could generalise to.</p>' +
        '<div class="card"><p class="thin" style="margin:0">Accepting a rule does not delete ' +
        'anything. Every listing it drops still shows in the review queue with the rule named as ' +
        'the reason, marking one genuine overrides it, and any rule can be removed from ' +
        '<a href="/rules">what you\'ve taught it</a>. Take none of these and the single decision ' +
        'still stands.</p></div>' +
        safeHtml + riskyHtml +
        '<p style="margin-top:18px"><a href="' + escapeHtml(back) +
        '">No rule &mdash; just this listing</a></p>')
}

/*
    The confirmation step for a rule that would remove real coins.

    Named listings, not a count. "Would stop pricing 97" is a number people
    click past; "would stop pricing 1911 Gold Sovereign George V London" is
    not.
*/
function confirmRulePage (opened, url) {
    const { repository } = opened
    const phrase = url.searchParams.get('phrase')
    const back = safeBack(url.searchParams.get('back'))
    const legacyId = url.searchParams.get('legacy') || ''

    if (phrase === null || phrase === '') {
        return RENDER.page('Confirm - Coin Market', '<h1>No rule given</h1>')
    }

    const effect = ruleEffect(repository, phrase)

    const conflictBlock = effect.conflicts.length === 0 ? ''
        : '<h2>You called these genuine</h2><div class="card"><ul>' +
          effect.conflicts.map(c => '<li class="warn">' + escapeHtml(c) + '</li>').join('') +
          '</ul></div>'

    const more = effect.breaks > effect.breakSamples.length
        ? '<li><em>and ' + (effect.breaks - effect.breakSamples.length) + ' more</em></li>'
        : ''

    return RENDER.page('Confirm - Coin Market',
        '<h1>This rule would remove coins that are being priced</h1>' +
        '<p class="sub">Dropping everything containing <span class="phrase">' +
        escapeHtml(phrase) + '</span> matches ' + effect.support + ' tracked listing' +
        (effect.support === 1 ? '' : 's') + '.</p>' +
        '<div class="card"><p style="margin:0"><strong class="warn">' + effect.breaks +
        '</strong> of them count towards the market statistics right now and would stop.' +
        (effect.conflicts.length > 0
            ? ' <strong class="warn">' + effect.conflicts.length +
              '</strong> of them you have already called genuine.'
            : '') +
        '</p><p class="thin" style="margin:8px 0 0">This is reversible &mdash; removing the rule ' +
        'from <a href="/rules">what you\'ve taught it</a> puts every one of them back. But it is ' +
        'worth reading the list first.</p></div>' +
        conflictBlock +
        '<h2>Priced today, would stop (' + effect.breaks + ')</h2>' +
        '<div class="card"><ul class="thin">' +
        effect.breakSamples.map(t => '<li>' + escapeHtml(t) + '</li>').join('') + more +
        '</ul></div>' +
        '<form method="post" action="/rule" style="display:flex; gap:10px; align-items:center">' +
        '<input type="hidden" name="back" value="' + escapeHtml(back) + '">' +
        '<input type="hidden" name="phrase" value="' + escapeHtml(phrase) + '">' +
        '<input type="hidden" name="support" value="' + effect.support + '">' +
        '<button class="no">Yes, apply it anyway</button>' +
        '<a href="/teach?legacy=' + encodeURIComponent(legacyId) + '&amp;back=' +
        encodeURIComponent(back) + '">Cancel</a></form>')
}

/* ----------------------------------------------------- what it learned */

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
        ? '<p class="thin">No rules yet. They come from the review queue: mark something as not a ' +
          'sovereign and you are offered the rule that generalises it.</p>'
        : '<div class="card scroll"><table><thead><tr><th>Rule</th><th>Matches now</th>' +
          '<th>When accepted</th><th></th></tr></thead><tbody>' +
          rules.map(rule => {
              const test = LEARNED.phrasePattern(rule.phrase)
              const now = corpus.filter(row => test.test(row.title)).length
              return `<tr>
    <td>drop titles containing <span class="phrase">${escapeHtml(rule.phrase)}</span></td>
    <td class="mono">${now}</td>
    <td class="mono thin">${rule.support === null ? '—' : rule.support}</td>
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
    — ${byVerdict.genuine} genuine, ${byVerdict.not} not a sovereign</div></div>
  <div><div class="n">${rules.length}</div><div class="l">rules generalised from them</div></div>
  <div><div class="n">${decided.length === 0 ? '—' : Math.round(100 * agreed / decided.length) + '%'}</div>
    <div class="l">of your calls the classifier now reaches on its own, with your labels withheld</div></div>
</div>

<h2>Rules</h2>
${ruleRows}

<h2>Your decisions (${labels.length})</h2>
${labels.length === 0
    ? '<p class="thin">Nothing judged yet.</p>'
    : '<div class="card scroll"><table><thead><tr><th>Listing</th><th>Your call</th><th>When</th>' +
      '</tr></thead><tbody>' + labels.slice(0, 200).map(l => `<tr>
  <td>${escapeHtml(l.title)}</td>
  <td>${l.verdict === LEARNED.VERDICT.SOVEREIGN
      ? '<span class="badge good">genuine' + (l.denomination ? ' · ' + escapeHtml(String(l.denomination).toLowerCase()) : '') + '</span>'
      : '<span class="badge critical">not a sovereign</span>'}</td>
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
`)
}
