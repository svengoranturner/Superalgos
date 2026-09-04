'use strict'

const FS = require('node:fs')
const PATH = require('node:path')
const RENDER = require('../web/render.js')
const INSTRUMENTS = require('../catalogue/instruments.js')

/*
    Writes a self-contained HTML report - no external assets, no scripts -
    that can be opened on a phone or published as a shareable page.

    The Node process writes the file; publishing it is a separate,
    deliberate step. Nothing here reaches the network on its own.
*/

exports.build = function (opened, outputPath) {

    const { repository, view } = opened
    const instruments = repository.instruments(0, 2).filter(row => row.listingCount >= 3).slice(0, 20)
    const curve = view.upliftCurve()

    const markets = instruments
        .map(row => ({ row, market: view.forInstrument(row.key) }))
        .filter(entry => entry.market.fairValue.sufficient)

    if (markets.length === 0) {
        throw new Error('Not enough data to build a report yet. Run a sweep, or "coin-market demo".')
    }

    const headline = markets[0].market
    const overpay = (headline.liquidity.askClearingSpread !== null && headline.spot !== null)
        ? headline.liquidity.askClearingSpread * headline.fineOz * headline.spot.gbpPerOz
        : null

    const chartRows = markets.slice(0, 12).map(entry => ({
        label: INSTRUMENTS.displayName(entry.row.key),
        p25: entry.market.fairValue.p25,
        p50: entry.market.fairValue.p50,
        p75: entry.market.fairValue.p75,
        ask: entry.market.liquidity.medianAskPremium,
        n: entry.market.fairValue.n
    }))

    const rows = markets.map(entry => {
        const m = entry.market
        return `<tr>
      <td>${RENDER.escapeHtml(INSTRUMENTS.displayName(entry.row.key))}</td>
      <td class="mono">${m.fairValue.n}</td>
      <td class="mono">${RENDER.pct(m.fairValue.p50)}</td>
      <td class="mono">${RENDER.pct(m.liquidity.medianAskPremium)}</td>
      <td class="mono"><strong>${RENDER.pct(m.liquidity.askClearingSpread)}</strong></td>
      <td class="mono">${RENDER.pct(m.liquidity.sellThroughRate, 0)}</td>
      <td class="mono">${m.bidCeiling ? RENDER.gbp(m.bidCeiling.maxBid) : '—'}</td>
    </tr>`
    }).join('')

    const generated = new Date().toISOString().replace('T', ' ').slice(0, 16) + ' UTC'

    const body = `
<h1>Sovereign market report</h1>
<p class="sub">Generated ${generated} · gold at ${headline.spot ? RENDER.gbp(headline.spot.gbpPerOz) : '—'}/oz</p>

<div class="card hero">
  <div><div class="n">${overpay === null ? '—' : RENDER.gbp(overpay)}</div>
    <div class="l">what the asking price costs you per coin, over where auctions clear</div></div>
  <div><div class="n">${RENDER.pct(headline.fairValue.p50)}</div>
    <div class="l">auctions clear at this premium over spot</div></div>
  <div><div class="n">${RENDER.pct(headline.liquidity.medianAskPremium)}</div>
    <div class="l">buy-it-now sellers ask this</div></div>
</div>

<h2>Where each coin type clears, against what sellers ask</h2>
<div class="card">${RENDER.premiumChart(chartRows)}</div>

<h2>Summary</h2>
<div class="card scroll"><table>
<thead><tr><th>Coin type</th><th>Sales</th><th>Clears at</th><th>Asks</th><th>Spread</th>
<th>Sell-through</th><th>Bid up to</th></tr></thead>
<tbody>${rows}</tbody></table></div>

<h2>How much auctions rise before the hammer</h2>
<div class="card">${RENDER.upliftChart(curve)}</div>

<div class="card"><p class="thin" style="margin:0">
Premiums are measured over each coin's fine gold content, so figures stay comparable as the
gold price moves. Clearing prices come from completed auctions only — Buy-It-Now sales tell
you what one buyer would pay on demand, not where the market clears. Accepted Best Offers are
excluded entirely, because eBay never publishes what was actually paid for them.
</p></div>`

    /*  Inline the stylesheet, explicitly.

        This file travels: it is written to disk and sent to somebody, and a
        <link rel="stylesheet" href="/style.css"> resolves to nothing once it
        has left. Inlining is already the default, but saying so here means
        the report does not depend on whether anything else in the process
        happened to start a server first. The fonts cannot come with it, so a
        shared report renders in system-ui - the sizes and the layout survive,
        the condensed headings do not. */
    RENDER.useStylesheet(null)

    const html = RENDER.page('Sovereign market report', body)
        .replace(/<nav>[\s\S]*?<\/nav>/, '')     /* a shared report has no navigation */

    const target = outputPath || PATH.join(process.cwd(), 'report.html')
    FS.mkdirSync(PATH.dirname(target), { recursive: true })
    FS.writeFileSync(target, html, 'utf8')
    return { path: target, instruments: markets.length, bytes: html.length }
}
