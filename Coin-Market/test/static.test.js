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
        assert.ok(!html.includes('<nav>'), 'a shared report carries navigation')
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
