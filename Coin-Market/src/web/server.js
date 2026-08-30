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
                if (size > 64 * 1024) { request.destroy(); return }
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
                html = reviewPage(opened)
            } else if (url.pathname === '/listings') {
                html = listingsPage(opened, url)
            } else if (url.pathname === '/teach') {
                html = teachPage(opened, url)
            } else if (url.pathname === '/rules') {
                html = rulesPage(opened)
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

    /* Live opportunities, one per lot at its most specific instrument. */
    const candidates = []
    for (const entry of markets) {
        for (const alert of ALERT_RULES.evaluate(entry.market, curve, { minEdge: 0.02 })) {
            candidates.push({ alert, name: INSTRUMENTS.displayName(entry.row.key), level: entry.row.level })
        }
    }
    /*
        A lot priced below its own gold content cannot be the coin it claims,
        so the "edge" against it is arithmetic on a category error - and it
        is precisely the listing that floats to the top of an
        edge-ranked list, because the bigger the mismatch the better the
        bargain looks. A book about sovereigns at GBP 107 showed an 87% edge.

        Dropped from the panel rather than merely marked, because this list
        exists to be acted on. They stay visible on the review page with the
        same verdict attached, so a wrong call here is findable.
    */
    const PLAUSIBILITY = require('../analytics/plausibility.js')
    const plausible = ALERT_RULES.dedupeByListing(candidates).filter(entry => {
        const market = markets.find(m => INSTRUMENTS.displayName(m.row.key) === entry.name)
        if (market === undefined || market.market.spot === null || market.market.fineOz === null) { return true }
        const assessed = PLAUSIBILITY.assess(
            entry.alert.currentTotal, market.market.fineOz, market.market.spot.gbpPerOz)
        return assessed === null || !assessed.impossible
    })
    const suppressed = ALERT_RULES.dedupeByListing(candidates).length - plausible.length
    const opportunities = plausible.slice(0, 12)

    const opportunityHtml = opportunities.length === 0
        ? '<p class="thin">No live lot is currently below your bid ceiling.</p>'
        : opportunities.map(entry => {
            const a = entry.alert
            const isAuction = a.rule === 'AUCTION_PROJECTED_BELOW_CEILING'
            return `<div class="alert">
        <div class="t">${escapeHtml(a.title)}</div>
        <div class="thin">${escapeHtml(entry.name)} ·
          ${isAuction ? 'auction ending in ' + a.minutesLeft + ' min' : 'buy it now / best offer'}</div>
        <div style="margin-top:6px">
          Now <span class="mono">${gbp(a.currentTotal)}</span>
          ${isAuction ? '· projected <span class="mono">' + gbp(a.projectedFinal) + '</span> ' +
            '<span class="thin">(' + gbp(a.projectedRange[0]) + '–' + gbp(a.projectedRange[1]) +
            ', from ' + a.basedOn + ' samples)</span>' : ''}
          · ${isAuction ? 'max bid' : 'suggested offer'}
          <span class="mono"><strong>${gbp(isAuction ? a.maxBid : a.suggestedOffer)}</strong></span>
          <span class="badge">edge ${pct(a.edge)}</span>
        </div>
        ${a.url ? '<div style="margin-top:4px"><a href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener">open on eBay</a></div>' : ''}
      </div>`
        }).join('')

    const censored = markets.reduce((sum, e) => sum + e.market.liquidity.censoredOutcomes, 0)
    const spotGaps = markets.reduce((sum, e) => sum + e.market.spotGaps, 0)

    const body = `
<h1>Coin Market</h1>
<p class="sub">What sovereigns actually sell for, measured against their gold content.</p>

<div class="card hero">
  <div>
    <div class="n">${overpay === null ? '—' : gbp(overpay)}</div>
    <div class="l">what paying the asking price costs you, per coin, versus where auctions clear
      — ${escapeHtml(INSTRUMENTS.displayName(headline.row.key))}</div>
  </div>
  <div>
    <div class="n">${pct(hm.fairValue.p50)}</div>
    <div class="l">auctions clear at this premium over melt
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

<h2>Live opportunities</h2>
${suppressed > 0 ? '<p class="thin">' + suppressed + ' lot' + (suppressed === 1 ? '' : 's') +
  ' hidden: priced below their own gold content, so they cannot be the coin the title claims. ' +
  'They are on the <a href="/review">review page</a> with the reason.</p>' : ''}
${opportunityHtml}

<h2>Every tracked coin type</h2>
<div class="card scroll">
<table>
  <thead><tr>
    <th>Coin type</th><th>Sales</th><th>Clears at</th><th>p25–p75</th><th>Asks</th>
    <th>Spread</th><th>Sell-through</th><th>Bids</th><th>Live</th><th>Bid up to</th>
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
    right melt to measure against. Where it did not, the quarter is used -
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

        const v = PLAUSIBILITY.assess(total, fineOz, spot.gbpPerOz)
        if (v === null) { return '' }
        return '<span class="badge ' + (v.impossible ? 'critical' : 'good') + '" title="' +
            escapeHtml(v.detail + ' Measured against ' + measuredAgainst +
                (assumed ? ', the smallest sovereign, because the denomination is unknown.' : '.')) +
            '">' + escapeHtml(v.label) + '</span> <span class="thin mono">' +
            Math.round(v.percentOfMelt) + '% of melt</span>'
    }
}

function reviewPage (opened) {
    /*  The whole queue, not a page of it - it is sorted by impact below and
        truncating before sorting would hide exactly the rows that matter. */
    const rows = opened.repository.reviewQueue(3000)
    const verdictCell = newPlausibilityCell(opened.spotAt(new Date().toISOString()))

    for (const row of rows) { row.back = '/review' }

    const excluded = rows.filter(r => (r.reason || '').startsWith('EXCLUDED'))
    const uncertain = rows.filter(r => !(r.reason || '').startsWith('EXCLUDED'))

    /*  The ones still counted in a market number lead, because they are the
        only ones that can be making the front page wrong. */
    const affecting = uncertain.filter(r => r.priced)
    const inert = uncertain.filter(r => !r.priced)

    const list = (items, empty, cap) => items.length === 0
        ? '<p class="thin">' + empty + '</p>'
        : '<div class="card"><div class="queue">' +
          items.slice(0, cap || 250).map(r => queueRow(r, verdictCell(r))).join('') +
          '</div>' +
          (items.length > (cap || 250)
              ? '<p class="thin" style="margin:12px 0 0">Showing the first ' + (cap || 250) +
                ' of ' + items.length + '.</p>'
              : '') +
          '</div>'

    const settled = rows.filter(r => r.verdict).length

    return RENDER.page('Needs review - Coin Market', `
<h1>Needs review</h1>
<p class="sub">Listings the classifier would not price without a human decision. Every statistic
in this tool is computed over what survives this filter, so it is shown rather than hidden.</p>

<div class="card">
  <p class="thin" style="margin:0">Hover a photo to see it large. Mark one and it is settled for
  good &mdash; the decision is stored against the coin, survives a relist, outranks every rule in
  the classifier, and the collector applies it to listings it finds tomorrow. Say
  <em>not a sovereign</em> and you are then offered a rule that generalises it, with the count of
  what it would catch and what it would break.
  ${settled > 0 ? '<strong>' + settled + '</strong> of the listings below are already settled.' : ''}</p>
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
`)
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

function callControls (row) {
    if (!row.legacyId) { return '<span class="thin">—</span>' }
    const id = escapeHtml(row.legacyId)

    if (row.verdict) {
        const said = row.verdict === LEARNED.VERDICT.SOVEREIGN
            ? 'You said: genuine' + (row.labelledDenomination
                ? ' (' + escapeHtml(String(row.labelledDenomination).toLowerCase()) + ')' : '')
            : 'You said: not a sovereign'
        return '<span class="settled">' + said + '</span> ' +
            '<form method="post" action="/unlabel" style="display:inline">' +
            '<input type="hidden" name="legacyId" value="' + id + '">' +
            '<input type="hidden" name="back" value="' + escapeHtml(row.back || '/review') + '">' +
            '<button class="plain" title="Forget this decision">undo</button></form>'
    }

    const options = DENOMINATION_OPTIONS
        .map(d => '<option value="' + d + '">' + (d === '' ? 'denomination?' : d.toLowerCase()) + '</option>')
        .join('')

    return '<form class="verdict" method="post" action="/label">' +
        '<input type="hidden" name="legacyId" value="' + id + '">' +
        '<input type="hidden" name="title" value="' + escapeHtml(row.title) + '">' +
        '<input type="hidden" name="back" value="' + escapeHtml(row.back || '/review') + '">' +
        '<select name="denomination">' + options + '</select>' +
        '<button class="yes" name="verdict" value="' + LEARNED.VERDICT.SOVEREIGN + '">Genuine</button>' +
        '<button class="no" name="verdict" value="' + LEARNED.VERDICT.NOT_SOVEREIGN + '">Not a sov</button>' +
        '</form>'
}

function queueRow (row, verdictCell) {
    const big = largerImage(row.imageUrl)
    const total = (row.price || 0) + (row.shipping || 0)

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
    if (row.conditionLabel) { meta.push(escapeHtml(row.conditionLabel)) }
    if (row.buyingOptions) { meta.push(escapeHtml(String(row.buyingOptions).toLowerCase().replace(/[|,]/g, ' / ').replace(/_/g, ' '))) }
    /*  Auction-only, and present on just 7.6% of the queue for that reason -
        its absence says "not an auction" rather than "we failed to fetch
        it", so it is emitted only when there is something to say. */
    if (Number.isFinite(row.bidCount)) {
        meta.push(row.bidCount + (row.bidCount === 1 ? ' bid' : ' bids'))
    }
    if (Number.isFinite(row.sellerFeedbackPct)) {
        meta.push('seller ' + row.sellerFeedbackPct.toFixed(1) + '%' +
            (Number.isFinite(row.sellerFeedbackCnt) ? ' (' + row.sellerFeedbackCnt + ')' : ''))
    }

    /*  The full category path in the caption, because it is the single most
        useful thing for judging a listing at a glance and it is too long
        for the row. */
    const caption = escapeHtml(row.categoryPath || '')

    return `<div class="q">
  <div class="q-shot"${big ? ' style="--shot:url(&quot;' + escapeHtml(big) + '&quot;)"' : ''}>
    ${row.imageUrl
        ? '<img src="' + escapeHtml(row.imageUrl) + '" alt="" loading="lazy" decoding="async">'
        : '<img alt="" src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">'}
    ${big ? '<div class="q-big">' + (caption ? '<div class="cap">' + caption + '</div>' : '') + '</div>' : ''}
  </div>
  <div class="q-main">
    <div class="q-title">${row.itemWebUrl
        ? '<a href="' + escapeHtml(row.itemWebUrl) + '" target="_blank" rel="noopener">' + escapeHtml(row.title) + '</a>'
        : escapeHtml(row.title)}</div>
    <div class="q-meta">${meta.join('<span aria-hidden="true">·</span>')}</div>
  </div>
  <div class="q-side">
    <div class="q-price"><span class="mono">${total > 0 ? gbp(total) : '—'}</span>
      ${verdictCell === undefined ? '' : verdictCell}</div>
    ${callControls(row)}
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

    const rows = repository.listingsForInstrument(key, 500)
    const verdictCell = newPlausibilityCell(opened.spotAt(new Date().toISOString()))
    for (const row of rows) { row.back = '/listings?key=' + encodeURIComponent(key) }

    const name = INSTRUMENTS.displayName(key)
    const market = view.forInstrument(key)

    /*  Live and ended are counted separately so this page agrees with the
        Live column that led you here. Ended lots still matter - they feed
        the clearing price - but they are not what the front page's live
        figures are made of. */
    const live = rows.filter(r => r.live === 1)
    const ended = rows.filter(r => r.live !== 1)

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
    const list = (items) => '<div class="card"><div class="queue">' +
        items.slice(0, CAP).map(r => queueRow(r, verdictCell(r))).join('') + '</div>' +
        (items.length > CAP
            ? '<p class="thin" style="margin:12px 0 0">Showing the dearest ' + CAP +
              ' of ' + items.length + '.</p>'
            : '') + '</div>'

    return RENDER.page(name + ' - Coin Market', `
<h1>${escapeHtml(name)}</h1>
<p class="sub">Every listing counted under this coin type. Anything here that is not this coin is
moving the numbers on the front page.</p>

<div class="card hero">
  <div><div class="n">${live.length}</div><div class="l">live listings counted here</div></div>
  <div><div class="n">${pct(market.liquidity.medianAskPremium)}</div>
    <div class="l">median asking premium over gold content</div></div>
  <div><div class="n">${unflagged}</div>
    <div class="l">of them never flagged for review &mdash; they classified confidently, so this
      page is the only way to reach them</div></div>
  ${settled > 0 ? '<div><div class="n">' + settled + '</div><div class="l">you have judged</div></div>' : ''}
</div>

<p class="thin">Dearest first &mdash; within one coin type that is also the highest premium, and a
lot priced far from its neighbours is both the most likely to be wrong and the most visible when
it is. Hover a photo to see it large. If the coin is real but the denomination is wrong, set it
in the dropdown and mark it genuine rather than dismissing it.</p>
${live.length === 0 ? '<p class="thin">Nothing live under this coin type.</p>' : list(live)}

${ended.length === 0 ? '' : `<h2>Ended (${ended.length})</h2>
<p class="thin">No longer on sale, but still feeding the clearing price for this coin type.</p>
${list(ended)}`}

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
            denomination: verdict === LEARNED.VERDICT.SOVEREIGN ? (form.get('denomination') || null) : null
        })
        /*  One coin, not all five thousand. A verdict cannot affect any
            listing but this one's, and a full rebuild per click is slow
            enough on a Pi that people stop clicking. */
        RECLASSIFY.one(db, repository, legacyId)

        /*  Back where the decision was made. A junk listing noticed on a
            market number should not dump you on the review page, or working
            through one coin type means losing your place every time. */
        const back = safeBack(form.get('back'))
        return verdict === LEARNED.VERDICT.NOT_SOVEREIGN
            ? '/teach?legacy=' + encodeURIComponent(legacyId) + '&back=' + encodeURIComponent(back)
            : back
    }

    if (pathname === '/unlabel') {
        const legacyId = form.get('legacyId')
        if (legacyId) {
            repository.unlabel(legacyId)
            RECLASSIFY.one(db, repository, legacyId)
        }
        return safeBack(form.get('back'))
    }

    if (pathname === '/rule') {
        const phrase = (form.get('phrase') || '').trim()
        if (phrase.length > 0) {
            repository.saveLearnedRule({
                phrase,
                kind: LEARNED.VERDICT.NOT_SOVEREIGN,
                support: Number(form.get('support')) || null,
                agreement: form.get('agreement') === '' ? null : Number(form.get('agreement'))
            })
            RECLASSIFY.run(db, repository)
        }
        return form.get('back') ? safeBack(form.get('back')) : '/rules'
    }

    if (pathname === '/rule/delete') {
        const id = Number(form.get('id'))
        if (Number.isFinite(id)) {
            repository.deleteLearnedRule(id)
            RECLASSIFY.run(db, repository)
        }
        return '/rules'
    }

    return '/review'
}

/* ------------------------------------------------- generalising a call */

function teachPage (opened, url) {
    const { repository } = opened
    const legacyId = url.searchParams.get('legacy')
    const labels = repository.labels()
    const label = labels.find(l => l.legacyId === legacyId)

    if (label === undefined) {
        return RENDER.page('Teach — Coin Market',
            '<h1>Nothing to generalise</h1><p class="sub">That decision is no longer stored. ' +
            '<a href="/review">Back to the review queue</a>.</p>')
    }

    const proposals = LEARNED.induce(label, repository.titleCorpus(), labels)
    const back = safeBack(url.searchParams.get('back'))

    const cards = proposals.length === 0
        ? '<p class="thin">Nothing in this title generalises — no phrase in it appears on enough ' +
          'other listings to be worth a rule. The decision itself is still stored.</p>'
        : proposals.map(p => `<div class="proposal">
  <div class="p">Drop everything containing <span class="phrase">${escapeHtml(p.phrase)}</span></div>
  <p class="thin" style="margin:6px 0 0">Matches <strong>${p.support}</strong> tracked listing${p.support === 1 ? '' : 's'}${p.breaks === 0
      ? ', <strong>none</strong> of which are currently priced as sovereigns.'
      : ', and would stop pricing <strong class="warn">' + p.breaks + '</strong> that count towards the market statistics today.'}${p.conflicts.length > 0
      ? ' It also contradicts <strong class="warn">' + p.conflicts.length + '</strong> you have already called genuine, so the phrase is too broad.'
      : ''}</p>
  <ul>${p.samples.map(s => '<li>' + escapeHtml(s) + '</li>').join('')}</ul>
  ${p.breaks > 0 ? '<ul>' + p.breakSamples.map(s => '<li class="warn">priced today, would stop: ' + escapeHtml(s) + '</li>').join('') + '</ul>' : ''}
  ${p.conflicts.length > 0 ? '<ul>' + p.conflicts.map(c => '<li class="warn">you called this genuine: ' + escapeHtml(c) + '</li>').join('') + '</ul>' : ''}
  <form method="post" action="/rule" style="margin-top:10px">
    <input type="hidden" name="back" value="${escapeHtml(back)}">
    <input type="hidden" name="phrase" value="${escapeHtml(p.phrase)}">
    <input type="hidden" name="support" value="${p.support}">
    <input type="hidden" name="agreement" value="${p.agreement === null ? '' : p.agreement}">
    <button class="${p.breaks > 0 || p.conflicts.length > 0 ? 'plain' : 'yes'}">Accept this rule</button>
  </form>
</div>`).join('')

    return RENDER.page('Teach — Coin Market', `
<h1>Should that apply to others?</h1>
<p class="sub">You marked <em>${escapeHtml(label.title)}</em> as not a sovereign. Here is what
that decision could generalise to, ranked by how much it would catch without contradicting
anything else you have said.</p>
<div class="card">
  <p class="thin" style="margin:0">Accepting a rule does not delete anything. Every listing it
  drops still shows in the review queue with the rule named as the reason, and marking one
  genuine overrides it. Take none of these and the single decision still stands.</p>
</div>
${cards}
<p style="margin-top:18px"><a href="${escapeHtml(back)}">No rule &mdash; just this listing</a></p>
`)
}

/* ----------------------------------------------------- what it learned */

function rulesPage (opened) {
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

    return RENDER.page("What you've taught it — Coin Market", `
<h1>What you've taught it</h1>
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
