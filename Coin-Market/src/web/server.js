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
            if (url.pathname === '/review') { html = reviewPage(opened) } else if (url.pathname === '/teach') { html = teachPage(opened, url) } else if (url.pathname === '/rules') { html = rulesPage(opened) } else { html = marketPage(opened, url) }
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

function reviewPage (opened) {
    const rows = opened.repository.reviewQueue(200)
    const PLAUSIBILITY = require('../analytics/plausibility.js')
    const COINS = require('../catalogue/coins.js')

    const spot = opened.spotAt(new Date().toISOString())

    /*
        What the price implies about whether this is a sovereign at all.

        Where the classifier managed a best guess, its denomination gives the
        right melt to measure against. Where it did not, the quarter is used -
        the smallest sovereign struck - so the verdict is the conservative
        one: anything under a quarter's gold content cannot be any sovereign,
        whatever the title says.
    */
    const verdictFor = (row) => {
        if (spot === null) { return null }
        const total = (row.price || 0) + (row.shipping || 0)
        const guessed = typeof row.bestGuess === 'string'
            ? row.bestGuess.split('.').find(part => COINS.DENOMINATIONS[part] !== undefined)
            : undefined
        const denomination = COINS.DENOMINATIONS[guessed] || COINS.DENOMINATIONS.QUARTER
        const assessed = PLAUSIBILITY.assess(total, denomination.fineOz, spot.gbpPerOz)
        if (assessed === null) { return null }
        return Object.assign({ measuredAgainst: denomination.label, assumed: guessed === undefined }, assessed)
    }

    const verdictCell = (row) => {
        const v = verdictFor(row)
        if (v === null) { return '<span class="thin">—</span>' }
        const tone = v.impossible ? 'critical' : 'good'
        return '<span class="badge ' + tone + '" title="' +
            escapeHtml(v.detail + ' Measured against a ' + v.measuredAgainst +
                (v.assumed ? ', the smallest sovereign, because the denomination is unknown.' : '.')) +
            '">' + escapeHtml(v.label) + '</span> <span class="thin mono">' +
            Math.round(v.percentOfMelt) + '% of melt</span>'
    }

    /*
        Your call.

        Every rule in the classifier is a guess made from outside the market
        about what a sovereign is, and the list of things that are not one
        has no end - fishing reels, fantasy Edward VIII strikes, gold bars
        with the word in the title. Somebody who knows the market answers
        each of those without opening the listing. This is where that answer
        goes, and it outranks everything the classifier decided.
    */
    const callCell = (row) => {
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
                '<button class="plain" title="Forget this decision">undo</button></form>'
        }

        const options = ['', 'FULL', 'HALF', 'QUARTER', 'DOUBLE', 'QUINTUPLE']
            .map(d => '<option value="' + d + '">' + (d === '' ? 'denomination?' : d.toLowerCase()) + '</option>')
            .join('')

        return '<form class="verdict" method="post" action="/label">' +
            '<input type="hidden" name="legacyId" value="' + id + '">' +
            '<input type="hidden" name="title" value="' + escapeHtml(row.title) + '">' +
            '<select name="denomination">' + options + '</select>' +
            '<button class="yes" name="verdict" value="' + LEARNED.VERDICT.SOVEREIGN + '">Genuine</button>' +
            '<button class="no" name="verdict" value="' + LEARNED.VERDICT.NOT_SOVEREIGN + '">Not a sov</button>' +
            '</form>'
    }

    const excluded = rows.filter(r => (r.reason || '').startsWith('EXCLUDED'))
    const uncertain = rows.filter(r => !(r.reason || '').startsWith('EXCLUDED'))

    const list = (items, empty) => items.length === 0
        ? '<p class="thin">' + empty + '</p>'
        : '<div class="card scroll"><table><thead><tr><th>Listing</th><th>Reason</th>' +
          '<th>Does the price make sense?</th><th>Your call</th></tr></thead><tbody>' +
          items.map(r => `<tr><td>${r.itemWebUrl
              ? '<a href="' + escapeHtml(r.itemWebUrl) + '" target="_blank" rel="noopener">' + escapeHtml(r.title) + '</a>'
              : escapeHtml(r.title)}</td><td class="thin">${escapeHtml(r.reason)}</td>` +
              `<td>${verdictCell(r)}</td><td>${callCell(r)}</td></tr>`).join('') +
          '</tbody></table></div>'

    const settled = rows.filter(r => r.verdict).length

    return RENDER.page('Needs review — Coin Market', `
<h1>Needs review</h1>
<p class="sub">Listings the classifier would not price without a human decision. Every statistic
in this tool is computed over what survives this filter, so it is shown rather than hidden.</p>

<div class="card">
  <p class="thin" style="margin:0">Mark one and it is settled for good — the decision is stored
  against the coin, survives a relist, and outranks every rule in the classifier. Say
  <em>not a sovereign</em> and you are then offered a rule that generalises it to the listings
  nobody has looked at yet, with the count of what it would catch, to accept or refuse.
  ${settled > 0 ? '<strong>' + settled + '</strong> of the listings below are already settled.' : ''}</p>
</div>

<h2>Too uncertain to classify (${uncertain.length})</h2>
${list(uncertain, 'Nothing awaiting a decision.')}

<h2>Deliberately excluded (${excluded.length})</h2>
<p class="thin">Mounts, copies, cases and multi-coin lots. If something here looks wrongly
dropped, mark it genuine — that overrides the rule that dropped it, which is the failure mode
worth watching for: a bad rule quietly eating half the market.</p>
${list(excluded, 'Nothing excluded.')}
`)
}

/* ------------------------------------------------ recording a decision */

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
        RECLASSIFY.run(db, repository)

        return verdict === LEARNED.VERDICT.NOT_SOVEREIGN
            ? '/teach?legacy=' + encodeURIComponent(legacyId)
            : '/review'
    }

    if (pathname === '/unlabel') {
        const legacyId = form.get('legacyId')
        if (legacyId) {
            repository.unlabel(legacyId)
            RECLASSIFY.run(db, repository)
        }
        return '/review'
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
        return '/rules'
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

    const cards = proposals.length === 0
        ? '<p class="thin">Nothing in this title generalises — no phrase in it appears on enough ' +
          'other listings to be worth a rule. The decision itself is still stored.</p>'
        : proposals.map(p => `<div class="proposal">
  <div class="p">Drop everything containing <span class="phrase">${escapeHtml(p.phrase)}</span></div>
  <p class="thin" style="margin:6px 0 0">Matches <strong>${p.support}</strong> tracked listing${p.support === 1 ? '' : 's'}${p.conflicts.length > 0
      ? ' — but contradicts <strong class="warn">' + p.conflicts.length + '</strong> you have already called genuine, so this phrase is too broad.'
      : '.'}</p>
  <ul>${p.samples.map(s => '<li>' + escapeHtml(s) + '</li>').join('')}</ul>
  ${p.conflicts.length > 0 ? '<ul>' + p.conflicts.map(c => '<li class="warn">would also drop: ' + escapeHtml(c) + '</li>').join('') + '</ul>' : ''}
  <form method="post" action="/rule" style="margin-top:10px">
    <input type="hidden" name="phrase" value="${escapeHtml(p.phrase)}">
    <input type="hidden" name="support" value="${p.support}">
    <input type="hidden" name="agreement" value="${p.agreement === null ? '' : p.agreement}">
    <button class="${p.conflicts.length > 0 ? 'plain' : 'yes'}">Accept this rule</button>
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
<p style="margin-top:18px"><a href="/review">No rule — just this listing</a></p>
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
