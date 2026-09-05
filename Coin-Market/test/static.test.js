'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const SPOT = require('../src/spot/spot.js')
const MARKET = require('../src/analytics/market.js')
const SERVER = require('../src/web/server.js')
const RENDER = require('../src/web/render.js')
const STATIC = require('../src/web/static.js')
const FS = require('fs')
const OS = require('os')
const PATH = require('path')

/*
    The stylesheet, the fonts and the theme.

    All three exist because the app grew a design system, and all three run
    into the same wall: MetalHead sets `default-src 'self'; script-src 'none';
    style-src 'unsafe-inline'` over these pages. No remote font, no script to
    remember a preference, and - until the CSP gained 'self' alongside the
    inline permission - no external stylesheet either.
*/

function opened () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const spotAt = SPOT.newSpotLookup(db, {})
    return { db, repository, spotAt, view: MARKET.newMarketView(repository, spotAt, {}) }
}

async function get (store, path, headers) {
    const server = SERVER.start(store, { port: 0, host: '127.0.0.1', quiet: true })
    await new Promise(resolve => server.once('listening', resolve))
    try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + path,
            { headers: headers || {}, redirect: 'manual' })
        return {
            status: response.status,
            type: response.headers.get('content-type'),
            cache: response.headers.get('cache-control'),
            location: response.headers.get('location'),
            setCookie: response.headers.get('set-cookie'),
            body: await response.text()
        }
    } finally {
        server.close()
    }
}

test('the stylesheet is served as CSS, not as the front page', async () => {
    /*
        THE bug this route exists to close. The router ends in an
        unconditional `else` that renders the market page, so before there was
        a branch for it, GET /style.css answered with the whole front page as
        text/html, status 200 - a stylesheet that fails without ever looking
        like it failed.
    */
    const store = opened()
    const response = await get(store, '/style.css')

    assert.strictEqual(response.status, 200)
    assert.match(response.type, /^text\/css/, 'served as ' + response.type)
    assert.ok(response.body.includes('--color-accent'), 'that is not the stylesheet')
    assert.ok(!response.body.includes('<!doctype html'), 'the front page came back instead')
    store.db.close()
})

test('a font is served as a font, and is a real font', async () => {
    const store = opened()
    const response = await get(store, '/font/barlow-condensed-600.woff2')

    assert.strictEqual(response.status, 200)
    assert.strictEqual(response.type, 'font/woff2')
    /*  woff2 begins with wOF2. Reading it as text mangles the rest, but the
        magic number survives - enough to know a font came back rather than a
        404 page or an HTML error. */
    assert.ok(response.body.startsWith('wOF2'), 'not a woff2 file')
    store.db.close()
})

test('static assets are cacheable for a year; pages are never cacheable', async () => {
    /*  Opposite ends of the same decision. A page is a live read of a store a
        collector writes to hourly and must not be cached at all; these files
        change only when the code does, and the URL carries a fingerprint so a
        change is a new URL. */
    const store = opened()
    const sheet = await get(store, '/style.css')
    const page = await get(store, '/')

    assert.match(sheet.cache, /max-age=31536000/, 'the stylesheet is not cached')
    assert.match(sheet.cache, /immutable/)
    assert.match(page.cache, /no-store/, 'a page became cacheable')
    store.db.close()
})

test('an unknown path still falls through to the market page', async () => {
    /*  The static branch must not swallow anything it does not own - the
        catch-all behaviour the rest of the app relies on is unchanged. */
    const store = opened()
    const response = await get(store, '/not-a-real-asset.css')

    assert.strictEqual(response.status, 200)
    assert.match(response.type, /text\/html/)
    store.db.close()
})

test('a served page links the stylesheet rather than carrying it', async () => {
    const store = opened()
    const response = await get(store, '/')

    assert.match(response.body, /<link rel="stylesheet" href="\/style\.css\?v=[0-9a-f]+">/,
        'the page does not link the stylesheet')
    assert.ok(!response.body.includes('<style>'), 'the page still inlines 24KB of CSS')
    store.db.close()
})

test('the report inlines the stylesheet, because it travels alone', async () => {
    /*
        A report is written to disk and sent to somebody. A link to
        /style.css resolves to nothing once it has left this machine, so the
        one caller that cannot use a URL gets the bytes instead.

        Built for real rather than by calling page() directly: the earlier
        version of this test set the mode itself and so proved only that
        render.js can inline, never that the report asks it to. Pointing
        build.js at a served stylesheet broke nothing.
    */
    /*  The report refuses to build on an empty store, so this one carries
        the minimum it asks for: a coin type with three sold auctions behind
        it and something still listed. */
    const store = opened()
    const now = new Date().toISOString()
    const { db, repository } = store
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(now, 'XAU', 3290, null, 'test')
    const KEY = 'GB.SOV.BULLION.FULL'
    const add = (id, price, auction, sold) => {
        const browseId = 'v1|' + id + '|0'
        repository.saveListing({
            browseId, legacyId: id, title: 'Gold Sovereign ' + id,
            buyingOptions: auction ? 'AUCTION' : 'FIXED_PRICE',
            endTime: auction ? new Date(Date.now() + 3600000).toISOString() : null
        }, now)
        repository.saveSnapshot(browseId, { price, shipping: 0, bidCount: 4, observedAt: now })
        repository.setListingSeries(browseId, 'GB.SOV')
        repository.saveClassification(browseId, [{ key: KEY, level: 0 }], 0.9, 'title', 0.2354, {})
        if (sold) {
            repository.saveOutcome(browseId, {
                endTime: now, sold: true, finalPrice: price, shipping: 0, bidCount: 4,
                saleType: 'AUCTION', censored: false, source: 'trading_getitem'
            })
        }
    }
    for (let n = 0; n < 4; n++) { add('sold' + n, 880 + n, true, true) }
    for (let n = 0; n < 3; n++) { add('live' + n, 940 + n, false, false) }

    /*  A server has started in this process, so the linked mode is already
        set - which is exactly the condition the report has to survive. */
    RENDER.useStylesheet('/style.css?v=deadbeef')

    const BUILD = require('../src/report/build.js')
    const out = PATH.join(OS.tmpdir(), 'coin-market-report-test-' + process.pid + '.html')
    try {
        BUILD.build(store, out)
        const html = FS.readFileSync(out, 'utf8')
        assert.ok(html.includes('<style>'), 'the report has no styles at all')
        assert.ok(html.includes('--color-accent'), 'the inlined sheet is not the real one')
        assert.ok(!html.includes('<link rel="stylesheet"'),
            'the report links a stylesheet it cannot reach once it has been sent')
        /*  `<nav` and not `<nav>`. The bar has carried a class since it became
            a menu bar, so the app emits no bare `<nav>` anywhere and this
            assertion could not fail however much navigation leaked into a
            shared report - which is the only thing it exists to catch. */
        assert.ok(!/<nav\b/.test(html), 'a shared report carries navigation')
        /*  The markup, not the string: the report inlines the whole stylesheet,
            and `.menu-panel` is a selector in it. `<details name="menubar"` can
            only be the bar itself. */
        assert.ok(!html.includes('name="menubar"'),
            'the report carries the menu bar even if the <nav> tag itself was stripped')
    } finally {
        try { FS.unlinkSync(out) } catch (err) { /* already gone */ }
        store.db.close()
    }
})

test('stampTheme refuses a value that is not a theme', async () => {
    /*
        Tested at the function rather than through a request, because the
        request path filters the cookie first - so a server-level test passes
        whatever this function does, and mutating its guard broke nothing.

        It matters on its own: an attribute carrying an unrecognised value
        matches neither :root[data-theme="dark"] nor the media query's
        :not([data-theme="light"]) guard, so the page would render the light
        palette on whatever ground the reader's system chose.
    */
    const page = '<!doctype html><html lang="en"><head></head><body></body></html>'
    for (const bad of ['purple', '', 'DARK', 'dark light', null, undefined, 0]) {
        assert.strictEqual(RENDER.stampTheme(page, bad), page,
            'a non-theme was stamped: ' + JSON.stringify(bad))
    }
    assert.ok(RENDER.stampTheme(page, 'dark').includes('data-theme="dark"'))
    assert.ok(RENDER.stampTheme(page, 'light').includes('data-theme="light"'))
})

/* ------------------------------------------------------------------ theme */

test('with no cookie the page stamps nothing, and the system decides', async () => {
    /*  The design asks for prefers-color-scheme to decide on a first visit.
        That is achieved by doing nothing: with no data-theme attribute the
        tokens fall to the media query. */
    const store = opened()
    const response = await get(store, '/')
    assert.ok(response.body.includes('<html lang="en">'),
        'a theme was forced on a reader who never chose one')
    store.db.close()
})

test('a theme cookie is stamped onto the document', async () => {
    const store = opened()
    const dark = await get(store, '/', { cookie: 'theme=dark' })
    const light = await get(store, '/', { cookie: 'theme=light' })

    assert.ok(dark.body.includes('<html lang="en" data-theme="dark">'))
    assert.ok(light.body.includes('<html lang="en" data-theme="light">'))
    store.db.close()
})

test('a cookie nobody set is ignored', async () => {
    /*  Anything but the two known values stamps nothing rather than
        stamping something. An attribute with an unrecognised value would
        match neither :root[data-theme="dark"] nor the media query's
        :not([data-theme="light"]) guard, and the page would render the light
        palette on a dark ground. */
    const store = opened()
    for (const cookie of ['theme=purple', 'theme=', 'other=dark', 'theme=darkish']) {
        const response = await get(store, '/', { cookie })
        assert.ok(response.body.includes('<html lang="en">'),
            'a bad cookie was stamped: ' + cookie)
    }
    store.db.close()
})

test('the toggle sets a cookie and sends you back where you were', async () => {
    const store = opened()
    const response = await get(store, '/theme?to=dark&back=%2Freview')

    assert.strictEqual(response.status, 302)
    assert.strictEqual(response.location, '/review', 'it did not go back')
    assert.match(response.setCookie, /^theme=dark;/)
    assert.match(response.setCookie, /Max-Age=31536000/)
    /*  Lax, not Strict: arriving from MetalHead's login is a cross-site
        navigation, and Strict would drop the cookie exactly there. */
    assert.match(response.setCookie, /SameSite=Lax/)
    store.db.close()
})

test('the toggle cannot be turned into an open redirect', async () => {
    /*  Same allow-list the verdict forms use. A theme link is the kind of URL
        that gets shared, and one that will bounce you anywhere is worth
        more to somebody else than to you. */
    const store = opened()
    const response = await get(store, '/theme?to=dark&back=https%3A%2F%2Fevil.test%2F')

    assert.strictEqual(response.status, 302)
    assert.ok(!String(response.location).includes('evil.test'),
        'it redirected off-site: ' + response.location)
    store.db.close()
})

test('a toggle with no theme still returns you, and sets nothing', async () => {
    const store = opened()
    const response = await get(store, '/theme?back=%2Frules')

    assert.strictEqual(response.status, 302)
    assert.strictEqual(response.location, '/rules')
    assert.strictEqual(response.setCookie, null, 'a nonsense value was stored')
    store.db.close()
})

/* --------------------------------------------------------------- the sheet */

test('the stylesheet carries the design system and the app layer both', async () => {
    /*  The whole point of vendoring rather than bolting on: the pages that
        are not being redesigned inherit the new palette through the bridge,
        without their markup being touched. */
    const css = STATIC.css()

    assert.ok(css.includes('@font-face'), 'no self-hosted fonts')
    /*  Relative, not absolute. Behind MetalHead this sheet lives at
        /coin-market/style.css and the proxy does not rewrite URLs inside CSS,
        so an absolute /font/... would 404 there and fall back to system-ui
        without anything reporting an error. */
    assert.ok(css.includes('url("font/barlow-condensed-600.woff2")'),
        'the condensed face is missing, or its path is absolute')
    assert.ok(!css.includes('url("/font/'),
        'a font path is absolute and will 404 behind the proxy')
    /*  Asserted on what the sheet FETCHES, not on what it mentions - the
        header comment names the domain precisely to explain why it is not
        used, and a bare substring test called that a violation. No @import
        and no remote url() is the actual requirement: `default-src 'self'`
        blocks both, silently, leaving a page in system-ui with no error
        anyone would notice. */
    assert.ok(!/^\s*@import/m.test(css), 'the sheet still @imports something')
    assert.ok(!/url\(\s*["']?https?:/i.test(css),
        'the sheet fetches something remote, which the CSP blocks')

    assert.ok(css.includes('--color-accent:'), 'no Industry tokens')
    assert.ok(css.includes('--plane: var(--color-bg)'), 'the bridge to the old tokens is gone')
    assert.ok(css.includes('.blueprint'), 'no blueprint frame')

    assert.ok(css.includes('.q-title'), 'the app layer did not come across')
    assert.ok(css.includes('.bulkbar'), 'the app layer did not come across')
})

test('the two long-standing glyph faults are fixed', async () => {
    /*  The open-fold marker was a minus sign that lost a round trip through
        an editor and had been rendering as a stray digit; --mono was
        referenced by that same rule and never defined anywhere. */
    const css = STATIC.css()

    assert.ok(css.includes('details.fold[open] > summary::before { content:"−" }'),
        'the fold marker is still wrong')
    assert.ok(!css.includes(''), 'the mojibake survived the move')
    assert.match(css, /--mono:\s*ui-monospace/, '--mono is still undefined')
})

test('the stylesheet URL changes when the stylesheet does', async () => {
    /*  It is served immutable for a year, which is only safe because the
        fingerprint is of the bytes: edit the sheet and every page asks for a
        different URL. */
    assert.match(STATIC.version(), /^[0-9a-f]{12}$/)
})

/*
    THE THEME TOGGLE, AND WHY THIS TEST IS A CASCADE SIMULATION.

    The toggle shipped broken and looked perfect. Two links are rendered, one
    per theme, and CSS shows whichever one you are not currently using. Every
    rule that decided this was backwards: `.to-dark` is the link TO dark, so
    it belongs to a reader in LIGHT, and it was being shown in dark. The
    result was a button that offered you the theme you already had. Clicking
    it set the cookie to the value it already held, redirected you back, and
    changed nothing - in all three states, so no combination of clicks ever
    revealed the fault.

    Nothing an ordinary test could see was wrong. The markup was right, both
    hrefs were right, the route was right, the cookie was right; the two tests
    below this one prove each of those separately and would all have passed on
    the broken build. The defect lived entirely in which of two elements the
    cascade chose to show, so that is what this measures: for every state the
    page can be in, settle the winning `display` the way a browser would - by
    specificity, then source order - and assert that exactly one link shows
    and it is the other theme's.
*/

/*  Enough of a cascade to settle two class selectors. */
function specificityOf (selector) {
    /*  :not() contributes its argument's specificity; the :not() itself adds
        nothing, so unwrap it and count what was inside. */
    const bare = selector.replace(/:not\(([^)]*)\)/g, '$1')
    return [
        0,
        (bare.match(/\[[^\]]*\]/g) || []).length + (bare.match(/\.[\w-]+/g) || []).length,
        (bare.match(/:root/g) || []).length
    ]
}

/*  Every stretch of the sheet, in source order, flagged with whether it sits
    inside a dark-preference media query.

    Brace-matched rather than pattern-matched, and the reason is a bug this
    very test shipped with: the sheet holds SEVERAL `prefers-color-scheme:
    dark` blocks - the palette is one - and a non-greedy pattern found the
    first, which is not the one the toggle lives in. The toggle's media rules
    were then read as if they applied unconditionally, and the test failed
    against CSS that was right. A scanner that cannot pick the wrong block is
    worth more here than a shorter one. */
function darkSegments (css) {
    const MEDIA = /@media \(prefers-color-scheme: dark\)\s*\{/g
    const out = []
    let at = 0
    let m
    while ((m = MEDIA.exec(css)) !== null) {
        /*  Emitted in true source order - the plain run, then the block that
            interrupted it - because equal specificity is settled by which
            rule comes later. */
        out.push({ text: css.slice(at, m.index), inMedia: false })
        let depth = 1
        let i = m.index + m[0].length
        const from = i
        while (i < css.length && depth > 0) {
            if (css[i] === '{') { depth++ } else if (css[i] === '}') { depth-- }
            i++
        }
        out.push({ text: css.slice(from, i - 1), inMedia: true })
        at = i
        MEDIA.lastIndex = i
    }
    return out.concat({ text: css.slice(at), inMedia: false })
}

function displayRules (css, className) {
    /*  Every `display` declaration in the sheet that targets this link, in
        source order, tagged with whether the OS has to say dark for it to
        apply at all. */
    const out = []
    for (const segment of darkSegments(css)) {
        const rule = new RegExp('([^{}\\n]*\\.' + className + ')\\s*\\{([^}]*)\\}', 'g')
        let m
        while ((m = rule.exec(segment.text)) !== null) {
            const decl = /display:\s*([\w-]+)/.exec(m[2])
            if (decl === null) { continue }
            out.push({ selector: m[1].trim(), display: decl[1], inMedia: segment.inMedia })
        }
    }
    return out
}

/*  Every state a reader can actually be in. `stamped` is the data-theme the
    server writes from the cookie; `os` is what prefers-color-scheme reports.
    `showing` is the theme they are therefore looking at - which is the thing
    the visible link has to disagree with. */
const THEME_STATES = [
    { name: 'first visit, light OS', stamped: null, os: 'light', showing: 'light' },
    { name: 'first visit, dark OS', stamped: null, os: 'dark', showing: 'dark' },
    { name: 'chose dark, light OS', stamped: 'dark', os: 'light', showing: 'dark' },
    { name: 'chose dark, dark OS', stamped: 'dark', os: 'dark', showing: 'dark' },
    { name: 'chose light, light OS', stamped: 'light', os: 'light', showing: 'light' },
    { name: 'chose light, dark OS', stamped: 'light', os: 'dark', showing: 'light' }
]

function selectorMatches (selector, state) {
    if (selector.includes('[data-theme="dark"]')) { return state.stamped === 'dark' }
    if (selector.includes(':not([data-theme="light"])')) { return state.stamped !== 'light' }
    if (selector.includes('[data-theme="light"]')) { return state.stamped === 'light' }
    return true
}

function displayOf (rules, state) {
    let winner = null
    let best = [-1, -1, -1]
    rules.forEach(rule => {
        if (rule.inMedia && state.os !== 'dark') { return }
        if (!selectorMatches(rule.selector, state)) { return }
        const spec = specificityOf(rule.selector)
        /*  >= on the last comparison, because a later rule of equal
            specificity wins on source order. */
        const beats = spec[0] > best[0] ||
            (spec[0] === best[0] && spec[1] > best[1]) ||
            (spec[0] === best[0] && spec[1] === best[1] && spec[2] >= best[2])
        if (beats) { best = spec; winner = rule.display }
    })
    return winner
}

test('the toggle offers the theme you are not in, in every state', () => {
    const css = STATIC.css()
    const toDark = displayRules(css, 'to-dark')
    const toLight = displayRules(css, 'to-light')

    assert.ok(toDark.length > 0 && toLight.length > 0,
        'no display rules found for the toggle links; the test has lost its target')

    for (const state of THEME_STATES) {
        const shown = [
            displayOf(toDark, state) === 'none' ? null : 'to-dark',
            displayOf(toLight, state) === 'none' ? null : 'to-light'
        ].filter(Boolean)

        assert.strictEqual(shown.length, 1,
            state.name + ': ' + shown.length + ' toggle links visible (' +
            (shown.join(', ') || 'none') + '); exactly one must show')

        /*  The whole point. The visible link must lead AWAY from the theme on
            screen - a link to where you already are is a button that does
            nothing, which is exactly the bug this pins. */
        const wanted = state.showing === 'dark' ? 'to-light' : 'to-dark'
        assert.strictEqual(shown[0], wanted,
            state.name + ': the page is showing ' + state.showing + ' but offers ' +
            shown[0] + ', the theme the reader already has')
    }
})

test('choosing a theme survives the round trip', async () => {
    /*  The server half, end to end: no cookie means no stamp and the OS
        decides; the route sets the cookie and sends you back where you were;
        the next page carries the attribute the CSS keys off. */
    const store = opened()

    const first = await get(store, '/')
    assert.ok(!/<html[^>]*data-theme/.test(first.body),
        'a first visit stamps a theme, which overrides the reader\'s OS setting')

    const set = await get(store, '/theme?to=dark&back=%2Fgaps')
    assert.strictEqual(set.status, 302, 'the theme route did not redirect')
    assert.match(set.setCookie || '', /(^|;|\s)theme=dark/, 'no theme cookie was set')
    assert.strictEqual(set.location, '/gaps',
        'the toggle did not return the reader to the page they were on')

    const after = await get(store, '/', { Cookie: 'theme=dark' })
    assert.match(after.body, /<html[^>]*data-theme="dark"/,
        'the chosen theme is not stamped on the next page')

    /*  And the other direction, so this cannot pass with a rule that only
        ever writes "dark". */
    const back = await get(store, '/theme?to=light&back=%2F')
    assert.match(back.setCookie || '', /(^|;|\s)theme=light/, 'cannot get back to light')
    const lit = await get(store, '/', { Cookie: 'theme=light' })
    assert.match(lit.body, /<html[^>]*data-theme="light"/, 'light is not stamped')

    store.db.close()
})

test('a menu closes when another opens', async () => {
    /*
        Four menus, four <details>, and no idea their siblings exist. Every
        one you opened stayed open, so a couple of clicks left panels stacked
        three deep across the page - which is what the owner saw and sent in.

        The `name` attribute makes them an exclusive group the way radio
        buttons are, and it is the only mechanism that does this without
        script, which `script-src 'none'` forbids. Asserted on the markup
        because the browser is what applies it and the markup is the half this
        app controls: the same name on all of them, so they are ONE group.
    */
    const store = opened()
    const body = (await get(store, '/')).body
    const nav = (body.match(/<nav\b[^>]*>[\s\S]*?<\/nav>/) || [''])[0]

    const menus = nav.match(/<details\b[^>]*class="menu[^"]*"[^>]*>/g) || []
    assert.ok(menus.length >= 2,
        'found ' + menus.length + ' menus in the bar; exclusivity means nothing below two')

    const names = menus.map(tag => (/name="([^"]*)"/.exec(tag) || [])[1])
    names.forEach((name, i) => {
        assert.ok(name !== undefined,
            'menu ' + i + ' has no name, so it will not close its siblings: ' + menus[i])
    })
    const groups = new Set(names)
    assert.strictEqual(groups.size, 1,
        'the menus carry ' + groups.size + ' different names (' + [...groups].join(', ') +
        '); a different name is a different group, and separate groups do not close ' +
        'each other')

    /*  And none is open on arrival - a bar that greets you with a panel over
        the page is the same complaint from the other end. */
    assert.ok(!/<details\b[^>]*class="menu[^"]*"[^>]*\sopen/.test(nav),
        'a menu is open before anybody has clicked anything')

    store.db.close()
})

/*
    THE HEAD AND THE BODY OF A COLUMN MUST AGREE.

    The app-layer sheet still carries `td { text-align:right }` from when every
    table in it was numbers. The scan table overrode that for its `th` and
    never did for its `td`, so the headings sat left and the cells under them
    sat right - and nothing said so, because both halves looked deliberate on
    their own.

    Worst in the lot cell, where the title and the meta line are sized as one
    block: the shorter of the two got pushed right, so every row's meta line
    began somewhere different. Measured at 1280px, three consecutive rows
    started at 177, 300 and 330. The owner called it formatting and
    justification, which is exactly what it was.

    Checked by resolving the cascade rather than by grepping for a string,
    because the bug was an absent declaration - there was nothing to grep for.
*/
function alignmentRules (css) {
    /*  Every text-align declaration outside a media query, in source order.
        Media blocks are excluded: the phone layout stacks the table into cards
        and legitimately aligns things differently. */
    const rules = []
    let depth = 0
    let i = 0
    const stripped = css.replace(/@media[^{]*\{/g, m => { return m })
    // Walk, skipping any @media block wholesale.
    while (i < stripped.length) {
        const at = stripped.indexOf('@media', i)
        const chunk = at === -1 ? stripped.slice(i) : stripped.slice(i, at)
        const rule = /([^{}]+)\{([^}]*)\}/g
        let m
        while ((m = rule.exec(chunk)) !== null) {
            const decl = /text-align:\s*([\w-]+)/.exec(m[2])
            if (decl === null) { continue }
            m[1].split(',').forEach(sel => rules.push({ sel: sel.trim(), value: decl[1] }))
        }
        if (at === -1) { break }
        depth = 1
        i = stripped.indexOf('{', at) + 1
        while (i < stripped.length && depth > 0) {
            if (stripped[i] === '{') { depth++ } else if (stripped[i] === '}') { depth-- }
            i++
        }
    }
    return rules
}

function matchesCell (selector, cell) {
    const parts = selector.split(/\s+/)
    const own = parts[parts.length - 1]

    const tag = (/^[a-z]+/.exec(own) || [''])[0]
    if (tag && tag !== cell.tag) { return false }
    const wanted = (own.match(/\.[\w-]+/g) || []).map(c => c.slice(1))
    if (!wanted.every(c => cell.classes.includes(c))) { return false }
    if (own.includes(':first-child') && !cell.first) { return false }

    /*  The only ancestor any of these rules names. */
    if (parts.length > 1 && parts.some(p => p.includes('table.scan')) && !cell.scan) { return false }
    return true
}

function specificity (selector) {
    return [
        0,
        (selector.match(/\.[\w-]+/g) || []).length + (selector.match(/:[\w-]+/g) || []).length,
        (selector.match(/(^|\s)[a-z]+/g) || []).length
    ]
}

function alignmentOf (rules, cell) {
    let winner = null
    let best = [-1, -1, -1]
    rules.forEach(rule => {
        if (!matchesCell(rule.sel, cell)) { return }
        const s = specificity(rule.sel)
        if (s[0] > best[0] || (s[0] === best[0] && s[1] > best[1]) ||
            (s[0] === best[0] && s[1] === best[1] && s[2] >= best[2])) {
            best = s; winner = rule.value
        }
    })
    return winner
}

test('a scan column is aligned the same in its head as in its body', () => {
    const rules = alignmentRules(STATIC.css())
    assert.ok(rules.length > 0, 'no text-align rules found; the test has lost its target')

    /*  first: the pick-cell is the first child, which the app layer aligns
        left by position rather than by class. */
    const COLUMNS = [
        { classes: ['pick-cell'], first: true },
        { classes: ['lot'], first: false },
        { classes: ['ident'], first: false },
        { classes: ['figure', 'bid'], first: false },
        { classes: ['figure', 'spot'], first: false },
        { classes: ['figure', 'delta'], first: false },
        { classes: ['figure', 'ends'], first: false },
        { classes: ['verdict-cell'], first: false }
    ]

    for (const column of COLUMNS) {
        const head = alignmentOf(rules, { tag: 'th', scan: true, ...column })
        const body = alignmentOf(rules, { tag: 'td', scan: true, ...column })
        assert.strictEqual(body, head,
            '.' + column.classes.join('.') + ': the heading is ' + head +
            ' and the cells under it are ' + body)
    }
})

test('the text columns are left and the figures are right', () => {
    /*  The other half: agreeing on the WRONG value would satisfy the test
        above. A price reads right, a coin title reads left. */
    const rules = alignmentRules(STATIC.css())
    const body = (classes, first) => alignmentOf(rules, { tag: 'td', scan: true, classes, first })

    assert.strictEqual(body(['lot'], false), 'left', 'the coin title is not left-aligned')
    assert.strictEqual(body(['ident'], false), 'left', 'the identified-as column is not left-aligned')
    assert.strictEqual(body(['figure', 'bid'], false), 'right', 'the bid is not right-aligned')
    assert.strictEqual(body(['figure', 'spot'], false), 'right', 'spot is not right-aligned')
    assert.strictEqual(body(['verdict-cell'], false), 'right', 'the verdict buttons are not right-aligned')
})

/*
    A CELL THAT LEAVES THE TABLE TAKES ITS COLUMN WIDTH WITH IT.

    Same shape of fault as the toggle dot below, one layout mode along. The
    pickers column was given `width: 20%` and `display: flex` in the same
    rule, which reads correctly and is not: `display: flex` on a <td> takes it
    out of the table's column algorithm entirely, so the percentage stopped
    applying. Measured at 1280px, the column came out 40px wide holding three
    <select> elements.

    Invisible to reading the CSS, which plainly says 20%. The fix was to flex
    a wrapper inside the cell instead - so the invariant is: while its table
    is still a table, a cell stays a table-cell.

    Scoped per block, because the phone layout breaks this deliberately and
    correctly - it turns the whole table into blocks, cells included. That is
    the difference the test has to keep: changing a cell's display is only
    safe when its table's display changes with it.
*/
test('a table cell stays a table cell while its table is a table', () => {
    const css = STATIC.css()

    /*  Each layout context, which is a media CONDITION and not a block: two
        `@media (max-width: 620px)` blocks in different parts of the sheet
        both apply at 619px, so a cell in one and its table in the other are
        the same context. Keying on the block would have reported the queue's
        own stacking rules as a fault - they sit in a second 620px block
        beside the scanner's. */
    const byCondition = new Map()
    const add = (condition, text) => {
        byCondition.set(condition, (byCondition.get(condition) || '') + text)
    }
    let i = 0
    while (i < css.length) {
        const at = css.indexOf('@media', i)
        add('', css.slice(i, at === -1 ? css.length : at))
        if (at === -1) { break }
        let depth = 0
        let j = css.indexOf('{', at)
        const condition = css.slice(at, j).replace(/\s+/g, ' ').trim()
        const from = j + 1
        do {
            if (css[j] === '{') { depth++ } else if (css[j] === '}') { depth-- }
            j++
        } while (j < css.length && depth > 0)
        add(condition, css.slice(from, j - 1))
        i = j
    }
    const blocks = [...byCondition.values()]

    const displays = (block) => {
        const out = []
        const rule = /([^{}]+)\{([^}]*)\}/g
        let m
        while ((m = rule.exec(block)) !== null) {
            const decl = /(?:^|[;{\s])display:\s*([\w-]+)/.exec(m[2])
            if (decl === null) { continue }
            for (const sel of m[1].split(',')) { out.push({ sel: sel.trim(), value: decl[1] }) }
        }
        return out
    }

    let checked = 0
    for (const block of blocks) {
        const rules = displays(block)
        /*  Does this block take the table itself out of table layout? */
        const tableIsBlock = rules.some(r =>
            /^table\.scan(\.[\w-]+)?$/.test(r.sel) && r.value !== 'table')

        for (const rule of rules) {
            /*  A cell rule: the last simple selector is a td, or a th. */
            const own = rule.sel.split(/\s+/).pop()
            if (!/^t[dh](\.[\w-]+)*$/.test(own)) { continue }
            checked++
            if (tableIsBlock) { continue }
            /*  `none` is the exception and a deliberate one: dropping a
                column whole is how the narrow breakpoints shed the ones that
                carry least, and a hidden cell has no width to lose. */
            if (rule.value === 'none') { continue }
            assert.ok(/^table-(cell|row)$/.test(rule.value),
                rule.sel + ' sets display:' + rule.value + ' on a cell whose table is still ' +
                'a table - the column algorithm stops applying to it and any width it was ' +
                'given is silently discarded')
        }
    }
    assert.ok(checked > 0, 'no cell display rules found; the test has lost its target')
})

/*  A LABEL FOR A NUMBER THAT IS NOT THERE.

    The stacked phone row prints the spot figure under the bid, out of a
    data-spot attribute, because a price with nothing to measure it against is
    half a row. The guard against a lot with no spot reading was
    `[data-spot=""]` - which needs the attribute to be present and empty.

    The review queue then reused this table, and its price cell carries no
    data-spot at all: a lot awaiting a verdict is not being compared to its
    metal. So the guard did not match, and every stacked queue row grew the
    word SPOT with nothing after it. */
test('the spot label needs a spot figure to label', () => {
    const css = STATIC.css()
    const rule = /table\.scan td\.bid([^{]*)::after \{([^}]*)\}/.exec(css)

    assert.ok(rule !== null, 'the stacked row no longer prints spot under the bid')
    assert.ok(rule[2].includes('attr(data-spot)'), 'the test has lost its target')
    assert.ok(rule[1].includes('[data-spot]'),
        'the spot label fires on a cell that has no data-spot attribute at all, ' +
        'printing the word with nothing after it: ' + rule[1].trim())
})

test('a filter toggle is a box, not an inline sliver', () => {
    /*
        THE OWNER'S REPORT: you cannot tell whether Silver and Gold are on or
        off. The cause was not the colours, it was the box model. `.dot` is a
        bare <span>, so `display` was `inline`, and width and height do not
        apply to an inline box - it rendered 3px wide against the 14 it asked
        for, leaving fill colour as the only difference between states.

        Invisible to reading the CSS, which plainly says 14px. Caught by
        getBoundingClientRect, which said 3.

        Asserted here because a stylesheet cannot be measured without a
        browser: any rule that sets a width on `.dot` must also give it a
        display that honours one.
    */
    const css = STATIC.css()
    const rule = /\.filters \.radio \.dot \{([^}]*)\}/.exec(css)

    assert.ok(rule !== null, 'the toggle dot has no rule at all')
    const decl = rule[1]

    if (/width\s*:/.test(decl) || /height\s*:/.test(decl)) {
        assert.match(decl, /display\s*:\s*(block|inline-block|flex|inline-flex|grid)/,
            'the dot sets a size but stays inline, so the size is ignored: ' + decl.trim())
    }

    /*  And the state must not rest on the dot alone. */
    assert.match(css, /\.filters \.radio\.on \{[^}]*color\s*:/,
        'only the dot changes between on and off; the control itself says nothing')
})

test('the late-bidding chart is drawn on a fixed scale, not on its own maximum', () => {
    /*
        THE FAULT THIS REPLACES. The old chart scaled bar height by
        (median - 1) / (max - 1), so the tallest bar was always full height
        whatever it represented - a x1.02 bucket beside a x1.10 one drew at a
        quarter the height rather than 93%, and a chart of uniformly tiny
        movements looked like a chart of enormous ones.

        A share is already a fraction of one and needs no normalising. Pinned
        by rendering the same bucket in two different companies: if the scale
        moved with the data, the identical bucket would draw at two different
        heights.
    */
    const UPLIFT = require('../src/analytics/uplift.js')
    const code = UPLIFT.bucketFor(600)

    const build = (jumpers, total) => {
        const samples = []
        for (let n = 0; n < total; n++) {
            samples.push({
                browseId: 'lot' + n, secondsToEnd: 600, price: 100,
                finalPrice: n < jumpers ? 130 : 101
            })
        }
        return UPLIFT.buildCurve(samples)
    }

    /*  The same 30% bucket, once alone and once beside a 90% one. */
    const quiet = build(3, 10)
    const loud = build(9, 10)
    const mixed = Object.assign({}, quiet)
    mixed[UPLIFT.BUCKETS[0].code] = loud[code]

    /*  THE SAME bucket in both charts, not any bar against any bar - an
        any-to-any comparison passes trivially, because the tallest bar of a
        self-scaling chart is full height in every chart it appears in. That
        is how the first version of this test missed the mutation it exists
        for. */
    const label = UPLIFT.BUCKETS.find(b => b.code === code).label
    const heightOfBucket = (svg) => {
        const group = svg.split('<g>').find(g => g.includes('>' + label + '<'))
        assert.ok(group !== undefined, 'no group for bucket ' + label)
        const rects = group.match(/<rect[^>]*height="([\d.]+)"/g) || []
        assert.ok(rects.length > 0, 'bucket ' + label + ' drew no bar')
        return Number(/height="([\d.]+)"/.exec(rects[0])[1])
    }

    const alone = heightOfBucket(RENDER.upliftChart(quiet))
    const beside = heightOfBucket(RENDER.upliftChart(mixed))

    assert.ok(Math.abs(alone - beside) < 0.5,
        'the 30% bucket drew at ' + alone.toFixed(1) + ' alone and ' + beside.toFixed(1) +
        ' beside a 90% one, so the scale is still moving with the data')

    /*  And the axis says what the scale is, which a self-scaling one cannot. */
    const svg = RENDER.upliftChart(quiet)
    for (const mark of ['25%', '50%', '75%', '100%']) {
        assert.ok(svg.includes('>' + mark + '<'), 'the axis has no ' + mark + ' gridline')
    }
})

test('a bucket with too little data is named, not deleted', () => {
    /*  The old chart filtered thin buckets out entirely, so a reader could not
        tell a quiet bucket from one nobody has data for. */
    const UPLIFT = require('../src/analytics/uplift.js')
    const samples = []
    /*  One bucket well populated, another with two auctions in it. */
    for (let n = 0; n < 10; n++) {
        samples.push({ browseId: 'a' + n, secondsToEnd: 600, price: 100, finalPrice: 120 })
    }
    samples.push({ browseId: 'b1', secondsToEnd: 30, price: 100, finalPrice: 120 })
    samples.push({ browseId: 'b2', secondsToEnd: 30, price: 100, finalPrice: 120 })

    const svg = RENDER.upliftChart(UPLIFT.buildCurve(samples))
    assert.ok(svg.includes('too few'), 'the thin bucket was dropped rather than named')
    assert.ok(svg.includes('n=2'), 'the thin bucket does not say how thin it is')
})
