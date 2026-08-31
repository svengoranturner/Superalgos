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

const STYLE = `
:root {
  color-scheme: light;
  --plane:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink-2:#52514e; --muted:#898781;
  --grid:#e1e0d9; --axis:#c3c2b7; --border:rgba(11,11,11,0.10);
  --clearing:#2a78d6; --ask:#eb6834; --good:#006300; --critical:#d03b3b;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    color-scheme: dark;
    --plane:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
    --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
    --clearing:#3987e5; --ask:#d95926; --good:#0ca30c; --critical:#e66767;
  }
}
:root[data-theme="dark"] {
  color-scheme: dark;
  --plane:#0d0d0d; --surface:#1a1a19; --ink:#ffffff; --ink-2:#c3c2b7; --muted:#898781;
  --grid:#2c2c2a; --axis:#383835; --border:rgba(255,255,255,0.10);
  --clearing:#3987e5; --ask:#d95926; --good:#0ca30c; --critical:#e66767;
}
* { box-sizing:border-box }
body {
  margin:0; background:var(--plane); color:var(--ink);
  font:15px/1.5 ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;
}
.wrap { max-width:1120px; margin:0 auto; padding:32px 20px 72px }
h1 { font-size:22px; margin:0 0 4px; letter-spacing:-0.01em }
h2 { font-size:15px; margin:36px 0 12px; letter-spacing:-0.005em }
.sub { color:var(--ink-2); margin:0 0 28px; font-size:14px }
.card { background:var(--surface); border:1px solid var(--border); border-radius:10px; padding:20px; margin-bottom:20px }
.hero { display:flex; flex-wrap:wrap; gap:32px; align-items:baseline }
.hero .n { font-size:40px; font-weight:640; letter-spacing:-0.02em; line-height:1 }
.hero .l { color:var(--ink-2); font-size:13px; margin-top:6px; max-width:30ch }
.scroll { overflow-x:auto }
table { border-collapse:collapse; width:100%; font-size:13.5px; min-width:720px }
th { text-align:right; font-weight:560; color:var(--ink-2); padding:8px 10px; border-bottom:1px solid var(--axis); white-space:nowrap }
th:first-child, td:first-child { text-align:left }
td { padding:8px 10px; border-bottom:1px solid var(--grid); text-align:right; white-space:nowrap }
tbody tr:hover { background:color-mix(in srgb, var(--ink) 4%, transparent) }
.mono { font-variant-numeric:tabular-nums }
.thin { color:var(--muted); font-size:12px }
/*  A link has to look like one.

    "a { color: inherit }" with no underline made every coin type on the
    market page read as plain text, so the drill-down - and the auction /
    Buy-It-Now filter that lives on it - was unreachable unless you happened
    to click a word that gave no sign of being clickable. */
a { color:inherit }
td a, th a { text-decoration:underline; text-decoration-color:var(--axis);
  text-underline-offset:3px }
td a:hover { text-decoration-color:var(--ink) }
.legend { display:flex; gap:18px; align-items:center; font-size:13px; color:var(--ink-2); margin-bottom:14px }
.swatch { width:10px; height:10px; border-radius:2px; display:inline-block; margin-right:6px; vertical-align:-1px }
.alert { border-left:3px solid var(--good); padding:12px 16px; margin-bottom:10px; background:var(--surface); border-radius:0 8px 8px 0 }
.alert { display:flex; gap:14px; align-items:flex-start }
.alert-main { min-width:0; flex:1 1 auto }
.alert-shot { flex:0 0 auto }
.alert .t { font-weight:560 }
.badge { display:inline-block; padding:1px 7px; border-radius:99px; font-size:11.5px; border:1px solid var(--border); color:var(--ink-2) }
.warn { color:var(--critical) }
nav { display:flex; gap:16px; margin-bottom:24px; font-size:14px }
nav a { color:var(--ink-2); text-decoration:none; padding-bottom:3px; border-bottom:2px solid transparent }
nav a.on { color:var(--ink); border-bottom-color:var(--ink) }
.badge.good { color:var(--good); border-color:color-mix(in srgb, var(--good) 40%, transparent) }
.badge.critical { color:var(--critical); border-color:color-mix(in srgb, var(--critical) 40%, transparent) }
/*  The verdict controls. Deliberately plain buttons in a plain form: the
    review queue is worked through quickly, and anything that needs
    JavaScript to record a decision is something that can silently fail to
    record one. */
.verdict { display:flex; flex-wrap:wrap; gap:6px; align-items:center; justify-content:flex-end }
button, select { font:inherit; font-size:12.5px; padding:3px 9px; border-radius:6px;
  border:1px solid var(--border); background:var(--surface); color:var(--ink); cursor:pointer }
button:hover { background:color-mix(in srgb, var(--ink) 6%, transparent) }
button.yes { color:var(--good); border-color:color-mix(in srgb, var(--good) 40%, transparent) }
button.no  { color:var(--critical); border-color:color-mix(in srgb, var(--critical) 40%, transparent) }
button.plain { color:var(--ink-2) }
.settled { color:var(--ink-2); font-size:12px }
/*  The tick column. Kept narrow and first so a cull is one pass straight down
    the left edge without the pointer leaving that column. */
input.pick { width:16px; height:16px; margin-top:20px; accent-color:var(--critical); cursor:pointer }
.pick-spacer { display:block; width:16px }
.bulkbar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin:0 0 12px }
.bulkbar button { font-size:13px; padding:5px 12px }
/*  Composition bars. Plain flex rather than SVG: the quantity is a share of
    a whole, a rectangle divided by percentage says exactly that, and it
    reflows on a phone without any viewBox arithmetic. */
.comp { display:flex; flex-direction:column; gap:14px }
.comp-row { display:grid; grid-template-columns:minmax(120px,170px) minmax(0,1fr); gap:14px; align-items:center }
.comp-label { font-size:13px; color:var(--ink-2) }
.comp-label b { color:var(--ink); font-weight:560 }
.comp-bar { display:flex; height:30px; border-radius:6px; overflow:hidden; background:var(--grid) }
.comp-bar span { display:flex; align-items:center; justify-content:center; font-size:11.5px;
  color:#fff; white-space:nowrap; overflow:hidden; min-width:0 }
.comp-bar span.pale { color:var(--ink-2); background:var(--grid) }
.comp-bar span.hatch { color:var(--ink-2);
  background:repeating-linear-gradient(135deg, var(--grid) 0 7px, transparent 7px 14px) }
.tabs { display:flex; flex-wrap:wrap; gap:8px }
.tab { display:inline-block; font-size:13px; padding:5px 12px; border-radius:99px;
  border:1px solid var(--border); color:var(--ink-2); text-decoration:none }
a.tab:hover { background:color-mix(in srgb, var(--ink) 6%, transparent) }
.tab.on { color:var(--ink); border-color:var(--ink); font-weight:560 }
.comp-key { display:flex; flex-wrap:wrap; gap:6px 16px; font-size:12px; color:var(--ink-2); margin-top:4px }
input.qty { font:inherit; font-size:12.5px; width:52px; padding:3px 6px; border-radius:6px;
  border:1px solid var(--border); background:var(--surface); color:var(--ink) }
.countries { display:flex; flex-wrap:wrap; gap:6px 14px; margin:10px 0 14px }
.countries label { font-size:12.5px; color:var(--ink-2); display:flex; gap:5px; align-items:center }
.countries input { accent-color:var(--clearing) }
/*  The work queue: a list, not a table.

    eBay titles run to 70 characters at the median and 84 at the longest,
    and a table column wide enough for one of those pushed the whole page
    sideways - the global "table { min-width:720px }" and
    "td { white-space:nowrap }" are right for the market statistics and
    wrong for a queue somebody has to read. Scoped class names, so the wide
    statistics table keeps the horizontal scroll it needs. */
.queue { display:flex; flex-direction:column }
.q { display:grid; grid-template-columns:18px 56px minmax(0,1fr) auto; gap:12px;
  align-items:start; padding:11px 4px; border-bottom:1px solid var(--grid) }
.q:hover { background:color-mix(in srgb, var(--ink) 4%, transparent) }
/*  A row with its picture open sits above its neighbours, so the preview is
    not painted under the row below. */
.q:has(.q-shot[open]) { position:relative; z-index:30 }
.q-shot { position:relative; width:56px; height:56px }
.q-shot > summary { list-style:none; cursor:zoom-in; display:block; border-radius:6px }
.q-shot > summary::-webkit-details-marker { display:none }
.q-shot[open] > summary { cursor:zoom-out; outline:2px solid var(--clearing); outline-offset:2px }
.q-shot img { width:56px; height:56px; object-fit:cover; border-radius:6px; display:block;
  border:1px solid var(--border); background:var(--plane) }
/*  minmax(0,1fr) above and min-width:0 here are the two rules that actually
    stop a long title forcing the grid wider than the viewport. */
.q-main { min-width:0 }
.q-title { font-size:13.5px; line-height:1.35; overflow-wrap:anywhere }
.q-title a { text-decoration:none }
.q-title a:hover { text-decoration:underline }
.q-meta { margin-top:5px; display:flex; flex-wrap:wrap; gap:5px 10px; align-items:center;
  font-size:11.5px; color:var(--muted) }
/*  Two lines, not four. The queue is scanned, so row height is how many
    listings fit on a screen. */
.q-side { display:flex; flex-direction:column; align-items:flex-end; gap:6px; text-align:right }
.q-price { display:flex; flex-wrap:wrap; gap:4px 8px; align-items:baseline; justify-content:flex-end }

/*  The preview, on hover or keyboard focus.

    eBay sends x-frame-options: SAMEORIGIN, so the listing page itself
    cannot be shown here - but the photo is what a glance is actually for,
    and we already store its URL for every listing.

    The large image is named ONLY inside the hover rule, so the browser
    never fetches it until asked. Two hundred rows would otherwise pull
    about 8MB on page load. The delay is deliberate: without it, running an
    eye down the list flashes a preview per row. */
/*  Below the thumbnail, not beside it.

    Beside it meant on top of the title, which is the thing most worth
    reading and the one the picture is least able to replace. Dropping it
    below the row keeps title, badges and price visible while the picture is
    open.

    The image is named only in the [open] rule, so it is not downloaded until
    the picture is actually asked for - 550 rows would otherwise pull about
    20MB on page load. */
.q-big { position:absolute; left:0; top:62px; z-index:40; width:340px; height:340px;
  border-radius:10px; border:1px solid var(--border); pointer-events:none;
  background:var(--surface) center/contain no-repeat;
  box-shadow:0 12px 34px rgba(0,0,0,0.30) }
.q-shot[open] > .q-big { background-image:var(--shot) }
.q-big .cap { position:absolute; left:0; right:0; bottom:0; padding:7px 10px; font-size:11.5px;
  color:var(--ink-2); background:color-mix(in srgb, var(--surface) 88%, transparent);
  border-radius:0 0 9px 9px; border-top:1px solid var(--border) }

@media (max-width:760px) {
  .q { grid-template-columns:18px 44px minmax(0,1fr) }
  .q-shot, .q-shot img { width:44px; height:44px }
  .q-side { grid-column:3; align-items:flex-start; text-align:left;
    flex-direction:row; flex-wrap:wrap; align-items:center }
  .q-big { left:0; top:52px; width:min(86vw,340px); height:min(86vw,340px) }
}
.proposal { border:1px solid var(--border); border-radius:8px; padding:14px 16px; margin-bottom:12px }
details { margin:16px 0 }
summary { cursor:pointer; color:var(--ink-2); font-size:13.5px; padding:6px 0 }
a.confirm { display:inline-block; margin-top:10px; font-size:12.5px; color:var(--critical);
  text-decoration:none; border:1px solid color-mix(in srgb, var(--critical) 40%, transparent);
  border-radius:6px; padding:4px 10px }
a.confirm:hover { background:color-mix(in srgb, var(--critical) 10%, transparent) }
.proposal .p { font-weight:560; font-size:15px }
.proposal ul { margin:8px 0 0; padding-left:18px; color:var(--muted); font-size:12px }
.phrase { font-variant-numeric:tabular-nums; background:color-mix(in srgb, var(--ink) 7%, transparent);
  padding:1px 6px; border-radius:4px }
`

exports.page = function (title, body) {
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><div class="wrap">
<nav><a href="/" class="on">Market</a><a href="/review">Needs review</a><a href="/rules">What you've taught it</a></nav>
${body}
</div></body></html>`
}

/*
    The money chart: where each coin type actually clears, against what
    sellers are asking for it.

    A range plot rather than bars - the interesting quantity is the GAP
    between two points on one shared axis, plus the spread of clearing
    prices around it. One axis (premium over melt); never two.
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
