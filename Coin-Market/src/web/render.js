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
    Lucide, at stroke-width 1.5, inline.

    Inline because there is nowhere else for them to go: `img-src 'self'` would
    allow a sprite sheet from this origin, but every icon here is eight to
    thirty bytes of path data and a sprite would be a second request and a
    second cache to reason about. Inline SVG also inherits `currentColor`,
    which is what lets the same check render accent in a row badge and
    foreground in a button without a second copy.

    Kept in one place so they are drawn once. The design names ten; these are
    the ones the pages actually use.
*/
const ICON = {
    chevron: 'm6 9 6 6 6-6',
    check: 'm5 12.5 4.5 4.5L19 7',
    cross: 'M6 6l12 12M18 6 6 18',
    menu: 'M4 6h16M4 12h16M4 18h16',
    sliders: 'M4 6h16M7 12h10M10 18h4',
    moon: 'M20 14.5A8.5 8.5 0 0 1 9.5 4a8.5 8.5 0 1 0 10.5 10.5Z'
}

/*  A path-only icon. The check-in-circle and the sun need more than one
    shape, so they are written out where they are used rather than bent into
    this shape. */
function icon (name, size) {
    const px = size || 14
    return '<svg width="' + px + '" height="' + px + '" viewBox="0 0 24 24" fill="none" ' +
        'stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="' +
        ICON[name] + '"></path></svg>'
}

/*  The one icon with a circle round it: "counted in the statistics", which
    replaces a five-word text badge on every row of the scanner. */
const TICKED = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="9"></circle><path d="m8.5 12.4 2.6 2.6 4.4-5"></path></svg>'

const SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" ' +
    'stroke="currentColor" stroke-width="1.5" aria-hidden="true">' +
    '<circle cx="12" cy="12" r="4.5"></circle>' +
    '<path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6 7 7M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4">' +
    '</path></svg>'

exports.icon = icon
exports.TICKED = TICKED

/*
    What the menu bar needs that a page shell cannot know.

    The bar carries live spot rates and a count beside every menu item, and
    render.js has no store to read them from. Rather than thread them through
    eleven page() calls that do not care, the server registers a function once
    and it is called per render.

    Nothing registers it in `report build`, which is correct twice over: that
    output has no navigation at all (build.js strips it) and no server behind
    it to make the links work.
*/
let chromeSource = null

exports.useChrome = function (fn) { chromeSource = typeof fn === 'function' ? fn : null }

function chrome () {
    if (chromeSource === null) { return { rates: null, counts: {} } }
    try {
        const value = chromeSource() || {}
        return { rates: value.rates || null, counts: value.counts || {} }
    } catch (err) {
        /*  A menu that cannot count is still a menu worth showing. The bar is
            on every page, so a failure here would take down every page at
            once - and the thing it would take them down for is a subtitle. */
        return { rates: null, counts: {} }
    }
}

/*
    The four menus, and what is under each.

    The groupings came from the designer, who inferred them from the old
    three-link tab row and asked for them to be confirmed - so they are
    written here as data rather than markup, where changing one is changing a
    list. `count` names a key in the chrome counts; absent means no number.

    "Saved searches" appears in the mock's Scanner menu and is NOT here: this
    app has no such feature, and a menu item that goes nowhere is worse than
    one that is missing.
*/
const MENUS = [
    ['Scanner', [
        ['Live', [
            ['/', 'Auctions near spot', 'nearSpot'],
            /*  No count, deliberately. The honest number here is the size
                of the offers panel itself - lots whose ask is within reach of
                your ceiling - and that costs the whole market computation,
                which every other page would then pay for to render a
                subtitle. A cheap count of "Buy-It-Now lots allowing offers"
                would be a different quantity wearing the same label, and
                would disagree with the page it opens. */
            ['/?view=offers', 'Open to an offer', null],
            ['/?view=ending', 'Ending within the hour', 'endingHour']
        ]]
    ]],
    ['Sold prices', [
        [null, [
            ['/?view=sold', 'Sold', 'sold'],
            ['/premiums', 'Premiums', null],
            ['/uplift', 'Bid uplift', null]
        ]]
    ]],
    ['Identification', [
        [null, [
            ['/review', 'Needs review', 'review'],
            ['/rules', 'Rules', null]
        ]]
    ]],
    ['Reference', [
        [null, [
            ['/types', 'Coin types', null],
            ['/composition', 'Composition', null],
            ['/gaps', 'Gaps', null]
        ]]
    ]]
]

/*
    The bar.

    ONE <nav>, and that is not a style preference: report/build.js strips
    navigation with a non-greedy regex and a test asserts there is exactly
    one, so a second element or a wrapper leaks the whole bar into a report
    meant to be shared.

    The menus are <details>. With `script-src 'none'` there is no other way
    to open one, and it is a fair trade: a <summary> is focusable, toggles on
    Enter and Space, and announces its state. What is lost is closing on an
    outside click or on Escape, which no amount of CSS restores.
*/
function menuBar (pathname, view) {
    const { rates, counts } = chrome()
    /*  `pathname` arrives with its query attached, because the theme toggle
        has to send the reader back to the page they were actually on rather
        than to its bare path. Only this comparison wants it stripped. */
    /*  Defaulted, because report/build.js calls `page` with a title and a body
        and nothing else - it produces a standalone file with no navigation at
        all, so it has no page to be on. */
    const path = (pathname || '/').split('?')[0]

    /*  Which menu row is the page you are looking at.

        The second clause used to be an `||` on `href === pathname`, which lit
        "Auctions near spot" on every ?view= URL - so reading the sold list
        showed two rows current in two different menus, each claiming to be
        where you were. `/` is the near-spot view specifically, not "any view
        of the scanner", and `viewFrom` resolves an absent or unknown view to
        'nearSpot', so that is the whole test. */
    const here = (href) => href.startsWith('/?view=')
        ? path === '/' && href === '/?view=' + view
        : href === path && (href !== '/' || view === undefined || view === 'nearSpot')

    const menus = MENUS.map(([label, groups]) => {
        const contains = groups.some(([, rows]) => rows.some(([href]) => here(href)))
        const panel = groups.map(([groupLabel, rows]) =>
            (groupLabel === null ? '' : '<div class="menu-label">' + escapeHtml(groupLabel) + '</div>') +
            rows.map(([href, text, countKey]) => {
                const n = countKey === null ? null : counts[countKey]
                return '<a class="menu-row' + (here(href) ? ' on' : '') + '" href="' +
                    escapeHtml(href) + '">' + escapeHtml(text) +
                    (Number.isFinite(n) ? '<span class="n">' + n + '</span>' : '') + '</a>'
            }).join('')
        ).join('')

        /*  `name` makes the four an exclusive group, the way radio buttons
            are: opening one closes the rest. Without it every menu you
            touched stayed open and they stacked on top of each other, three
            panels deep, because <details> has no idea its siblings exist and
            `script-src 'none'` leaves nothing to teach it.

            A browser too old for the attribute ignores it and behaves as it
            does today, which is the bug rather than a worse one. Chrome 120,
            Safari 17.2 and Firefox 130 all shipped it.

            Clicking outside, or Escape, still will not close a menu. That one
            is not solvable without script and is the honest cost of the CSP. */
        return '<details name="menubar" class="menu' + (contains ? ' current' : '') + '">' +
            '<summary>' + escapeHtml(label) + icon('chevron', 12) + '</summary>' +
            '<div class="menu-panel blueprint">' +
            '<i class="corner tl"></i><i class="corner tr"></i>' +
            '<i class="corner bl"></i><i class="corner br"></i>' +
            panel + '</div></details>'
    }).join('')

    /*  Both toggles are rendered and CSS shows the right one. The theme is
        stamped onto <html> after this string is built - and even if it were
        not, a first visit has no cookie at all and the answer depends on the
        reader's operating system, which the server never sees. Letting the
        cascade decide is the only version of this that is right in every
        case. */
    const back = encodeURIComponent(pathname || '/')
    const toggle =
        '<a class="btn btn-secondary icon-btn to-dark" href="/theme?to=dark&amp;back=' + back +
        '" title="Dark mode" aria-label="Switch to dark mode">' + icon('moon', 15) + '</a>' +
        '<a class="btn btn-secondary icon-btn to-light" href="/theme?to=light&amp;back=' + back +
        '" title="Light mode" aria-label="Switch to light mode">' + SUN + '</a>'

    return '<nav class="bar">' +
        '<a class="brand" href="/">Coin&nbsp;Market</a>' +
        '<div class="menus">' + menus + '</div>' +
        '<div class="bar-right">' +
        (rates === null ? '' : '<span class="rates">' + escapeHtml(rates) + '</span>') +
        toggle + '</div></nav>'
}

exports.page = function (title, body, pathname, view) {
    const style = stylesheetHref === null
        ? '<style>' + STATIC.css() + '</style>'
        : '<link rel="stylesheet" href="' + escapeHtml(stylesheetHref) + '">'

    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>${style}</head>
<body><div class="wrap">
${menuBar(pathname, view)}
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
