'use strict'

const INSTRUMENTS = require('../catalogue/instruments.js')
const UPLIFT = require('../analytics/uplift.js')

/*
    Server-rendered HTML. No framework, no build step, no CDN - it has to
    start on a Pi with nothing installed and keep working offline.

    Charts are inline SVG. Colours come from a validated categorical
    palette (blue = where the market clears, orange = what sellers ask);
    both hues clear CVD and contrast gates in light and dark. Identity is
    never carried by colour alone - every series is directly labelled and
    the table below repeats every number.
*/

const escapeHtml = (value) => String(value === null || value === undefined ? '' : value)
    .replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

const pct = (value, digits) => (value === null || value === undefined || !Number.isFinite(value))
    ? '—' : (value * 100).toFixed(digits === undefined ? 1 : digits) + '%'
const gbp = (value) => (value === null || value === undefined || !Number.isFinite(value))
    ? '—' : '£' + value.toFixed(2)

exports.escapeHtml = escapeHtml
exports.pct = pct
exports.gbp = gbp

const STATIC = require('./static.js')

/*
    The stylesheet, one way or the other.

    Served pages link it, so the browser caches it once instead of carrying
    24KB on every response, and so MetalHead's Content-Security-Policy can
    stop having to permit inline style at all one day.

    `report build` cannot: it produces a single file meant to be emailed and
    opened from disk, where /style.css resolves to nothing. So the default is
    inline and the SERVER opts in, which means the report keeps working
    without knowing this decision exists.
*/
let stylesheetHref = null

exports.useStylesheet = function (href) { stylesheetHref = href || null }

/*
    The three places worth going, and which one you are on.

    `class="on"` used to be baked onto the Market link, so Market stayed
    underlined on every page in the tool. It needs the current path, and only
    the path: the title is not a usable key, because /listings passes a
    per-instrument display name and two different call sites both pass
    'Coin Market'.

    Matched EXACTLY. On /listings, /teach and /rule-confirm nothing is lit,
    which is the honest answer - a sub-page-to-parent map would have to decide
    where /rule-confirm belongs now that it is reachable from both /teach and
    /rules, and a table that must be right about that goes stale silently.
    Those pages each carry their own heading and a way back.

    Must stay ONE <nav> element: report/build.js strips it with a non-greedy
    regex, and a second one would survive into a shared report.
*/
const NAV = [
    ['/', 'Market'],
    ['/review', 'Needs review'],
    ['/rules', "What you've taught it"]
]

exports.page = function (title, body, pathname) {
    const nav = NAV.map(([href, label]) =>
        '<a href="' + href + '"' + (href === pathname ? ' class="on"' : '') + '>' +
        escapeHtml(label) + '</a>').join('')

    const style = stylesheetHref === null
        ? '<style>' + STATIC.css() + '</style>'
        : '<link rel="stylesheet" href="' + escapeHtml(stylesheetHref) + '">'

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${style}</head>
<body><div class="wrap">
<nav>${nav}</nav>
${body}
</div></body></html>`
}

/*
    Which theme the reader chose, written onto the document.

    Not passed down through the eleven page functions, because none of them
    has the request and none of them should need it: a theme is a property of
    who is looking, not of what is being shown. The request handler stamps it
    on the way out, in one place.

    An unrecognised value stamps nothing, which is the correct default and
    not a fallback - with no attribute the tokens fall to
    prefers-color-scheme, so a first visit follows the operating system
    exactly as the design asks.
*/
exports.stampTheme = function (html, theme) {
    if (theme !== 'dark' && theme !== 'light') { return html }
    return html.replace('<html lang="en">', '<html lang="en" data-theme="' + theme + '">')
}

/*
    The money chart: where each coin type actually clears, against what
    sellers are asking for it.

    A range plot rather than bars - the interesting quantity is the GAP
    between two points on one shared axis, plus the spread of clearing
    prices around it. One axis (premium over spot); never two.
*/
/*
    What the tracked market is made of: live against ended, auction against
    Buy-It-Now, sold against unsold.

    Deliberately shows the hole. Every completed outcome in the store is an
    auction, because a Buy-It-Now listing is Good-'Til-Cancelled, carries no
    end time, and so never becomes eligible for outcome resolution. Drawing
    that as a zero sell-through would be a lie - it is unobserved, and the
    bar is hatched to say so rather than left off the chart, because a
    missing bar reads as nothing to see.
*/
exports.compositionChart = function (c) {
    const live = c.liveAuction + c.liveBin
    const ended = c.auctionSold + c.auctionUnsold

    const seg = (value, total, colour, label, title) => {
        if (value <= 0) { return '' }
        const share = (value / total) * 100
        /*  One style attribute, not two - a second is ignored, and the
            ignored one here was the width. */
        const cls = colour === null ? ' class="hatch"' : ''
        const background = colour === null ? '' : 'background:' + colour + ';'
        return '<span' + cls + ' title="' + escapeHtml(title) + '"' +
            ' style="' + background + 'flex:0 0 ' + share.toFixed(2) + '%">' +
            (share > 12 ? escapeHtml(label) : '') + '</span>'
    }

    const row = (label, count, bar) =>
        '<div class="comp-row"><div class="comp-label"><b>' + escapeHtml(label) + '</b><br>' +
        (count === null ? '' : count.toLocaleString('en-GB') + ' listings') +
        '</div><div class="comp-bar">' + bar + '</div></div>'

    const sellThrough = ended > 0 ? Math.round((c.auctionSold / ended) * 100) : null

    return '<div class="comp">' +
        row('On sale now', live,
            seg(c.liveBin, live, 'var(--ask)', 'Buy-It-Now ' + c.liveBin.toLocaleString('en-GB'),
                c.liveBin + ' Buy-It-Now listings') +
            seg(c.liveAuction, live, 'var(--clearing)', 'Auction ' + c.liveAuction,
                c.liveAuction + ' auctions')) +
        row('Auctions ended', ended,
            seg(c.auctionSold, ended, 'var(--good)', 'Sold ' + c.auctionSold,
                c.auctionSold + ' sold — ' + sellThrough + '% sell-through') +
            seg(c.auctionUnsold, ended, 'var(--critical)', 'Unsold ' + c.auctionUnsold,
                c.auctionUnsold + ' ended without a bid high enough to sell')) +
        row('Buy-It-Now ended', null,
            seg(1, 1, null, 'not observed — see below',
                'A Buy-It-Now listing has no end time, so it never enters outcome resolution')) +
        '</div>' +
        '<div class="comp-key">' +
        '<span><span class="swatch" style="background:var(--ask)"></span>Buy-It-Now</span>' +
        '<span><span class="swatch" style="background:var(--clearing)"></span>Auction</span>' +
        '<span><span class="swatch" style="background:var(--good)"></span>Sold</span>' +
        '<span><span class="swatch" style="background:var(--critical)"></span>Unsold</span>' +
        '</div>'
}

exports.premiumChart = function (rows) {
    if (rows.length === 0) { return '<p class="thin">No instrument has enough sales yet.</p>' }

    const width = 1000
    const rowHeight = 34
    const left = 352   /* fits 'Sovereign · Elizabeth II Young Head · 1966 · London' */
    const right = 60
    const top = 34
    const height = top + rows.length * rowHeight + 26

    const values = []
    for (const row of rows) {
        for (const v of [row.p25, row.p50, row.p75, row.ask]) {
            if (Number.isFinite(v)) { values.push(v) }
        }
    }
    const min = Math.min(0, Math.min(...values))
    const max = Math.max(...values) * 1.08
    const x = (value) => left + ((value - min) / (max - min)) * (width - left - right)

    const ticks = []
    const step = max > 0.4 ? 0.1 : 0.05
    for (let t = Math.ceil(min / step) * step; t <= max; t += step) {
        ticks.push(`<line x1="${x(t).toFixed(1)}" y1="${top - 8}" x2="${x(t).toFixed(1)}" y2="${height - 26}"
            stroke="var(--grid)" stroke-width="1"/>
          <text x="${x(t).toFixed(1)}" y="${height - 10}" fill="var(--muted)" font-size="11"
            text-anchor="middle">${(t * 100).toFixed(0)}%</text>`)
    }

    const marks = rows.map((row, index) => {
        const y = top + index * rowHeight + rowHeight / 2
        const parts = []

        parts.push(`<text x="0" y="${y + 4}" fill="var(--ink)" font-size="12.5">${escapeHtml(row.label.slice(0, 52))}</text>`)

        /* Interquartile range of clearing prices - what patience is worth. */
        if (Number.isFinite(row.p25) && Number.isFinite(row.p75)) {
            parts.push(`<line x1="${x(row.p25).toFixed(1)}" y1="${y}" x2="${x(row.p75).toFixed(1)}" y2="${y}"
                stroke="var(--clearing)" stroke-width="2" opacity="0.32" stroke-linecap="round"/>`)
        }
        if (Number.isFinite(row.p50)) {
            parts.push(`<circle cx="${x(row.p50).toFixed(1)}" cy="${y}" r="5"
                fill="var(--clearing)" stroke="var(--surface)" stroke-width="2"/>`)
        }
        if (Number.isFinite(row.ask)) {
            parts.push(`<circle cx="${x(row.ask).toFixed(1)}" cy="${y}" r="5"
                fill="var(--ask)" stroke="var(--surface)" stroke-width="2"/>`)
            /* Direct label on the gap - the number the user came for. */
            if (Number.isFinite(row.p50)) {
                const mid = (x(row.p50) + x(row.ask)) / 2
                parts.push(`<line x1="${x(row.p50).toFixed(1)}" y1="${y}" x2="${x(row.ask).toFixed(1)}" y2="${y}"
                    stroke="var(--axis)" stroke-width="1" stroke-dasharray="2 3"/>`)
                parts.push(`<text x="${mid.toFixed(1)}" y="${y - 9}" fill="var(--ink-2)" font-size="11"
                    text-anchor="middle">+${((row.ask - row.p50) * 100).toFixed(0)}pp</text>`)
            }
        }
        parts.push(`<title>${escapeHtml(row.label)}: clears ${pct(row.p50)}, asks ${pct(row.ask)} (n=${row.n})</title>`)
        return '<g>' + parts.join('') + '</g>'
    })

    return `
<div class="legend">
  <span><span class="swatch" style="background:var(--clearing)"></span>Auction clearing premium (bar = p25–p75)</span>
  <span><span class="swatch" style="background:var(--ask)"></span>Buy-It-Now asking premium</span>
</div>
<div class="scroll"><svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
  role="img" aria-label="Clearing premium versus asking premium by coin type">
  ${ticks.join('')}
  ${marks.join('')}
</svg></div>
<p class="thin">Premium is measured over the coin's gold content, so the comparison holds as the gold price moves.</p>`
}

/* Uplift curve: one series, magnitude across ordered buckets -> bars. */
exports.upliftChart = function (curve) {
    const buckets = UPLIFT.BUCKETS.filter(b => curve[b.code] && curve[b.code].sufficient)
    if (buckets.length === 0) {
        return '<p class="thin">Not learned yet — needs completed auctions with snapshots. ' +
            'Until then the tool stays silent on projections rather than assuming lots do not move.</p>'
    }

    const width = 1000
    const height = 210
    const left = 90
    const bottom = 42
    const max = Math.max(...buckets.map(b => curve[b.code].median))
    const scale = (value) => (value - 1) / (max - 1 || 1)
    const barWidth = (width - left - 30) / buckets.length - 14

    const bars = buckets.map((bucket, index) => {
        const entry = curve[bucket.code]
        const x = left + index * ((width - left - 30) / buckets.length)
        const h = Math.max(2, scale(entry.median) * (height - bottom - 30))
        const y = height - bottom - h
        return `<g>
      <rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${h.toFixed(1)}"
        rx="4" fill="var(--clearing)"/>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${(y - 7).toFixed(1)}" fill="var(--ink-2)"
        font-size="11.5" text-anchor="middle">×${entry.median.toFixed(2)}</text>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${height - bottom + 16}" fill="var(--muted)"
        font-size="11" text-anchor="middle">${escapeHtml(bucket.label)}</text>
      <text x="${(x + barWidth / 2).toFixed(1)}" y="${height - bottom + 30}" fill="var(--muted)"
        font-size="10" text-anchor="middle">n=${entry.n}</text>
      <title>${escapeHtml(bucket.label)} before close: lots finish ×${entry.median.toFixed(3)} higher (n=${entry.n})</title>
    </g>`
    }).join('')

    return `<div class="scroll"><svg viewBox="0 0 ${width} ${height}" width="100%" height="${height}"
   role="img" aria-label="How much auctions rise before the hammer, by time remaining">
  <line x1="${left - 14}" y1="${height - bottom}" x2="${width - 20}" y2="${height - bottom}"
    stroke="var(--axis)" stroke-width="1"/>
  <text x="0" y="${height - bottom - 6}" fill="var(--muted)" font-size="11">final ÷ observed</text>
  ${bars}
</svg></div>`
}
