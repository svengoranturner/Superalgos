'use strict'

const FS = require('fs')
const PATH = require('path')

/*
    The stylesheet and the fonts.

    Every other response this server makes is a page: generated per request,
    read from a store a collector writes to every hour, and sent
    `no-store, must-revalidate` so nothing between here and the browser can
    serve yesterday's numbers. These two are the opposite kind of thing -
    bytes on disk that change only when the code does - and they carry the
    opposite headers.

    WHY THERE IS A ROUTE HERE AT ALL. The whole stylesheet used to be one
    inline <style> block, which is why MetalHead's Content-Security-Policy in
    front of this app says `style-src 'unsafe-inline'` and nothing more.
    Serving it as a file needs `'self'` added there too, and the design system
    this app now wears needs its own font files, which `default-src 'self'`
    will only allow from this origin. Both of those are a tightening
    disguised as a widening: the alternative was fetching Barlow from
    fonts.googleapis.com, which is a third party watching which coin pages
    get opened.

    WHAT THIS DOES NOT DO. It does not serve a directory. There is a fixed map
    of eight names to two directories and anything not in it is a 404 - no
    path joining from user input, no `..`, no extension sniffing. A static
    handler that takes a path from a query string is the same server-side
    request forgery hole as an image proxy that fetches what it is told, and
    this app already refused that once in images.js.
*/

const ROOT = __dirname
const FONT_DIR = PATH.join(ROOT, 'fonts')

/*  The one stylesheet, and the five faces it names. Keyed by the URL the
    page asks for, valued by an absolute path this module resolved itself. */
const ASSETS = {
    '/style.css': { file: PATH.join(ROOT, 'industry.css'), type: 'text/css; charset=utf-8' },
    '/font/barlow-400.woff2': { file: PATH.join(FONT_DIR, 'barlow-400.woff2'), type: 'font/woff2' },
    '/font/barlow-500.woff2': { file: PATH.join(FONT_DIR, 'barlow-500.woff2'), type: 'font/woff2' },
    '/font/barlow-700.woff2': { file: PATH.join(FONT_DIR, 'barlow-700.woff2'), type: 'font/woff2' },
    '/font/barlow-condensed-400.woff2':
        { file: PATH.join(FONT_DIR, 'barlow-condensed-400.woff2'), type: 'font/woff2' },
    '/font/barlow-condensed-600.woff2':
        { file: PATH.join(FONT_DIR, 'barlow-condensed-600.woff2'), type: 'font/woff2' }
}

/*
    A year, immutable, and that is safe only because the name never changes
    meaning: edit the stylesheet and every browser that already has it keeps
    the old one until the cache expires.

    So the page asks for `/style.css?v=<hash>` - the hash is of the file's own
    bytes, computed once at startup - and a changed stylesheet is a changed
    URL. The query string is ignored when matching, which is what makes that
    work without a second entry here.
*/
const CACHE = 'public, max-age=31536000, immutable'

/*  Read once. These files are a few kilobytes each and this runs on a Pi
    that is also the database server; re-reading them per request would be
    disk it does not need to do. A restart picks up an edit, which is how
    every other change to this app is deployed anyway. */
const loaded = new Map()

function load (key) {
    if (loaded.has(key)) { return loaded.get(key) }
    const asset = ASSETS[key]
    let value = null
    try {
        value = { body: FS.readFileSync(asset.file), type: asset.type }
    } catch (err) {
        /*  A missing font is a broken deployment, not a broken request. Say
            so once on the console and answer 404 from then on, rather than
            throwing inside a request and taking the page with it. */
        console.error('static: cannot read ' + asset.file + ' (' + err.code + ')')
    }
    loaded.set(key, value)
    return value
}

/*  A short fingerprint of everything served, so one query string busts the
    lot. Computed lazily and cached: it is only needed once, when the first
    page renders its <link>. */
let stamp = null

exports.version = function () {
    if (stamp !== null) { return stamp }
    const hash = require('crypto').createHash('sha256')
    for (const key of Object.keys(ASSETS)) {
        const asset = load(key)
        hash.update(key)
        if (asset !== null) { hash.update(asset.body) }
    }
    stamp = hash.digest('hex').slice(0, 12)
    return stamp
}

/*
    The stylesheet as text, for the one caller that cannot use a URL.

    `report build` produces a single file meant to be sent to somebody and
    opened from disk, so a <link> to /style.css would arrive at a page with no
    server behind it. That report inlines the sheet instead - and gets system
    fonts, because /font/*.woff2 is equally unreachable from a file:// page.
    That is the honest trade for a document that has to travel alone.
*/
exports.css = function () {
    const asset = load('/style.css')
    return asset === null ? '' : asset.body.toString('utf8')
}

/*  Whether this path is one of ours. Called before the page router, so a
    stylesheet request never falls through to the market page - which is
    exactly what used to happen, silently, with a 200 and text/html. */
exports.handles = function (pathname) {
    return Object.prototype.hasOwnProperty.call(ASSETS, pathname)
}

exports.handle = function (pathname, response) {
    const asset = exports.handles(pathname) ? load(pathname) : null
    if (asset === null) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        response.end('not found')
        return
    }
    response.writeHead(200, {
        'Content-Type': asset.type,
        'Content-Length': asset.body.length,
        'Cache-Control': CACHE
    })
    response.end(asset.body)
}
