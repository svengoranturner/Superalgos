'use strict'

const HTTP = require('node:http')
const RENDER = require('./render.js')
const INSTRUMENTS = require('../catalogue/instruments.js')
const ALERT_RULES = require('../alerts/rules.js')

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
        try {
            const html = url.pathname === '/review'
                ? reviewPage(opened)
                : marketPage(opened, url)
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(html)
        } catch (err) {
            response.writeHead(500, { 'Content-Type': 'text/html; charset=utf-8' })
            response.end(RENDER.page('Error', '<h1>Something went wrong</h1><pre>' +
                escapeHtml(err.stack || err.message) + '</pre>'))
        }
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
      <td>${escapeHtml(INSTRUMENTS.displayName(e.row.key))}</td>
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
    const opportunities = ALERT_RULES.dedupeByListing(candidates).slice(0, 12)

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

function reviewPage (opened) {
    const rows = opened.repository.reviewQueue(200)

    const excluded = rows.filter(r => (r.reason || '').startsWith('EXCLUDED'))
    const uncertain = rows.filter(r => !(r.reason || '').startsWith('EXCLUDED'))

    const list = (items, empty) => items.length === 0
        ? '<p class="thin">' + empty + '</p>'
        : '<div class="card scroll"><table><thead><tr><th>Listing</th><th>Reason</th></tr></thead><tbody>' +
          items.map(r => `<tr><td>${r.itemWebUrl
              ? '<a href="' + escapeHtml(r.itemWebUrl) + '" target="_blank" rel="noopener">' + escapeHtml(r.title) + '</a>'
              : escapeHtml(r.title)}</td><td class="thin">${escapeHtml(r.reason)}</td></tr>`).join('') +
          '</tbody></table></div>'

    return RENDER.page('Needs review — Coin Market', `
<h1>Needs review</h1>
<p class="sub">Listings the classifier would not price without a human decision. Every statistic
in this tool is computed over what survives this filter, so it is shown rather than hidden.</p>

<h2>Too uncertain to classify (${uncertain.length})</h2>
${list(uncertain, 'Nothing awaiting a decision.')}

<h2>Deliberately excluded (${excluded.length})</h2>
<p class="thin">Mounts, copies, cases and multi-coin lots. If something here looks wrongly
dropped, the exclusion rules in <code>src/catalogue/exclusions.js</code> need adjusting —
a bad rule quietly eating half the market is the failure mode worth watching for.</p>
${list(excluded, 'Nothing excluded.')}
`)
}
