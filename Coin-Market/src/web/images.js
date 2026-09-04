'use strict'

const CRYPTO = require('node:crypto')
const FS = require('node:fs')
const HTTPS = require('node:https')
const PATH = require('node:path')

/*
    Serving eBay's thumbnails from this origin instead of linking to them.

    THE PROBLEM, and the honest limit of what was proved. Through the
    MetalHead proxy the pictures stopped loading: blank space, no broken
    icon. Ruled out from this side - eBay serves the images with no referer,
    the proxy leaves the <img> tags intact, exactly one Content-Security-
    Policy header reaches the browser and it permits i.ebayimg.com. The owner
    then saw the same thing in a private window, which rules out an extension
    but NOT Firefox's own tracking protection, which is set to Strict in
    private windows by default. So the cause is browser-side blocking of a
    third-party request, and which flavour was never established.

    That is exactly the kind of thing worth engineering around rather than
    diagnosing further: whatever a given viewer's browser, VPN, DNS or
    network blocks about eBay, a same-origin image is not a third-party
    request and there is nothing left to block. It also means the page's own
    Content-Security-Policy can drop to `img-src 'self'`, which is tighter
    than it was, not looser.

    WHY THIS LIVES HERE AND NOT IN METALHEAD. Coin Market is reached two ways
    - directly over the SSH forward, and proxied behind the login - and doing
    it here fixes both at once. The proxy in front needs only to know that
    `src="/..."` is an internal link, the same as href and action.

    THE THING TO GET RIGHT IS THE ALLOWLIST. A proxy that fetches whatever it
    is asked to fetch is a server-side request forgery hole: point it at
    169.254.169.254 or at a neighbour on the LAN and it will dutifully go and
    read it. This one accepts eBay's image CDN and nothing else, checked
    against a parsed URL rather than a substring - `https://evil.test/?x=
    i.ebayimg.com` contains the host name and is not it.
*/

/*  eBay's image CDN. Both spellings are live and both appear in the store. */
const ALLOWED_HOSTS = new Set(['i.ebayimg.com', 'i.ebayimg.co.uk'])

/*  What one of their image paths looks like. Not strictly necessary once the
    host is pinned, but it costs nothing and keeps the proxy to the one job
    it exists for. */
/*  The tilde is not decoration: eBay's image ids are base64-ish and a good
    fraction of them carry one - `yWQAAeSw9fJql~Vx`. Leaving it out of this
    class refused 24 of the 114 pictures on one real page, and they fell back
    to the direct eBay URL, so the page half-worked in exactly the way that
    hides the fault. The test fixture's id happened not to have one. */
const ALLOWED_PATH = /^\/[A-Za-z0-9/_~-]+\/s-l\d+\.(jpg|jpeg|png|webp)$/i

/*  Enough for several pages of thumbnails at ~12KB each, and small enough to
    sit beside a 90MB store without anybody noticing. Swept when it is
    exceeded, oldest first. */
const CACHE_BYTES = 64 * 1024 * 1024

const TYPES = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.webp': 'image/webp'
}

function allowed (raw) {
    if (typeof raw !== 'string' || raw === '') { return null }
    let url
    try { url = new URL(raw) } catch (err) { return null }
    if (url.protocol !== 'https:') { return null }
    if (!ALLOWED_HOSTS.has(url.hostname)) { return null }
    if (!ALLOWED_PATH.test(url.pathname)) { return null }
    /*  Rebuilt from the parsed parts, so nothing riding in a query string or
        a fragment reaches the fetch. */
    return 'https://' + url.hostname + url.pathname
}

function cacheName (url) {
    const hash = CRYPTO.createHash('sha256').update(url).digest('hex').slice(0, 32)
    const dot = url.lastIndexOf('.')
    const extension = dot < 0 ? '.jpg' : url.slice(dot).toLowerCase()
    return hash + (TYPES[extension] ? extension : '.jpg')
}

/*  Oldest first, and only when over. Reading a directory of a few thousand
    entries costs a millisecond and happens only after a miss. */
function sweep (dir) {
    let entries
    try {
        entries = FS.readdirSync(dir).map(name => {
            const full = PATH.join(dir, name)
            try { return { full, stat: FS.statSync(full) } } catch (err) { return null }
        }).filter(Boolean)
    } catch (err) { return }

    let total = entries.reduce((sum, e) => sum + e.stat.size, 0)
    if (total <= CACHE_BYTES) { return }
    entries.sort((a, b) => a.stat.mtimeMs - b.stat.mtimeMs)
    for (const entry of entries) {
        if (total <= CACHE_BYTES * 0.8) { break }
        try { FS.unlinkSync(entry.full); total -= entry.stat.size } catch (err) { /* gone */ }
    }
}

function fetchOnce (url, callback) {
    const request = HTTPS.get(url, { timeout: 10000 }, (response) => {
        if (response.statusCode !== 200) {
            response.resume()
            return callback(new Error('upstream ' + response.statusCode))
        }
        const chunks = []
        let size = 0
        response.on('data', (chunk) => {
            size += chunk.length
            /*  A thumbnail is ~12KB and the large one ~40KB. Anything past a
                few megabytes is not an image we asked for. */
            if (size > 8 * 1024 * 1024) { request.destroy(); return callback(new Error('too large')) }
            chunks.push(chunk)
        })
        response.on('end', () => callback(null, Buffer.concat(chunks),
            response.headers['content-type'] || 'image/jpeg'))
    })
    request.on('timeout', () => { request.destroy(); callback(new Error('timeout')) })
    request.on('error', callback)
}

/*
    Handle GET /img?u=<eBay url>.

    Answers 404 for anything not on the allowlist - not 400, because a
    rejected URL is not a request this endpoint has any opinion about, and
    saying "no such image" is the whole of what a caller needs to know.
*/
exports.handle = function (url, response, options) {
    const config = Object.assign({ cacheDir: null }, options || {})
    const target = allowed(url.searchParams.get('u'))
    if (target === null) {
        response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        return response.end('no such image')
    }

    const name = cacheName(target)
    const extension = name.slice(name.lastIndexOf('.'))
    const type = TYPES[extension] || 'image/jpeg'
    const file = config.cacheDir === null ? null : PATH.join(config.cacheDir, name)

    /*  A day is arbitrary but the pictures never change: eBay mints a new URL
        for a new photo, so a cached one is correct until the listing is gone. */
    const send = (body) => {
        response.writeHead(200, {
            'Content-Type': type,
            'Content-Length': body.length,
            'Cache-Control': 'public, max-age=86400'
        })
        response.end(body)
    }

    if (file !== null) {
        try { return send(FS.readFileSync(file)) } catch (err) { /* a miss */ }
    }

    fetchOnce(target, (err, body) => {
        if (err) {
            /*  A missing picture must never be an error page. The row it
                belongs to is still worth reading, and a broken image is a
                smaller failure than a 500 in the middle of a table. */
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
            return response.end('image unavailable')
        }
        if (file !== null) {
            try {
                FS.mkdirSync(config.cacheDir, { recursive: true })
                FS.writeFileSync(file, body)
                sweep(config.cacheDir)
            } catch (cacheErr) { /* serving it matters more than keeping it */ }
        }
        send(body)
    })
}

/*  The same-origin address for one eBay image, or null if it is not one we
    would serve. Kept here so the page and the handler cannot disagree about
    what is proxyable. */
exports.proxied = function (raw) {
    const target = allowed(raw)
    return target === null ? null : '/img?u=' + encodeURIComponent(target)
}

exports.ALLOWED_HOSTS = ALLOWED_HOSTS
