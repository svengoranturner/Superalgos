'use strict'

const test = require('node:test')
const assert = require('node:assert')

const IMAGES = require('../src/web/images.js')

/*
    The image proxy, and mostly its allowlist.

    Serving eBay's thumbnails from this origin fixes a real problem - through
    the login proxy the pictures were a third-party request and something in
    the browser was refusing them - but a proxy that fetches whatever it is
    asked to fetch is a server-side request forgery hole. This one runs on a
    Pi that also holds the store, sits on a home LAN with a NAS and a router
    on it, and is reachable from the internet behind a login. "Fetch this URL
    for me" is the last thing it should offer.

    So the tests that matter here are the refusals.
*/

const REAL = 'https://i.ebayimg.com/images/g/J-UAAeSw7RNqlXWy/s-l225.jpg'

test('a genuine eBay thumbnail is proxied', () => {
    const proxied = IMAGES.proxied(REAL)
    assert.ok(proxied.startsWith('/img?u='), 'not a same-origin URL: ' + proxied)
    /*  Same origin is the entire point: a relative path cannot be a
        third-party request, so there is nothing left for a tracker blocker,
        a VPN or a DNS filter to refuse. */
    assert.ok(!proxied.includes('://'), 'the page still links off-site: ' + proxied)
    assert.ok(decodeURIComponent(proxied.split('u=')[1]) === REAL)
})

test('an image id with a tilde in it is proxied', () => {
    /*  Found on the live page, not in a fixture. eBay's ids are base64-ish
        and many carry a tilde; a character class without one refused 24 of
        114 pictures, which then fell back to the direct URL and worked -
        badly, and invisibly. */
    const tilde = 'https://i.ebayimg.com/images/g/yWQAAeSw9fJql~Vx/s-l225.jpg'
    assert.ok(IMAGES.proxied(tilde) !== null, 'a tilde in the id is refused')
    assert.strictEqual(decodeURIComponent(IMAGES.proxied(tilde).split('u=')[1]), tilde)
})

test('the .co.uk spelling of the same CDN is proxied too', () => {
    const url = 'https://i.ebayimg.co.uk/images/g/AAA/s-l500.jpg'
    assert.ok(IMAGES.proxied(url).startsWith('/img?u='))
})

test('nothing but eBay images is proxied', () => {
    for (const [url, why] of [
        ['http://i.ebayimg.com/images/g/AAA/s-l225.jpg', 'plain http, so it could be intercepted'],
        ['https://evil.test/images/g/AAA/s-l225.jpg', 'a different host entirely'],
        ['https://i.ebayimg.com.evil.test/images/g/AAA/s-l225.jpg', 'the host name as a prefix'],
        ['https://evil.test/?x=i.ebayimg.com/s-l225.jpg', 'the host name in a query string'],
        ['https://i.ebayimg.com/../../etc/passwd', 'walking out of the image path'],
        ['https://i.ebayimg.com/images/g/AAA/s-l225.svg', 'not an image type we serve'],
        ['https://169.254.169.254/latest/meta-data/', 'the cloud metadata address'],
        ['http://127.0.0.1:34260/rules', 'this app talking to itself'],
        ['https://192.168.68.11/', 'a neighbour on the LAN'],
        ['file:///etc/passwd', 'not even http'],
        ['', 'nothing at all'],
        [null, 'null'],
        [undefined, 'undefined'],
        [12345, 'not a string']
    ]) {
        assert.strictEqual(IMAGES.proxied(url), null,
            'the proxy accepted ' + why + ': ' + String(url))
    }
})

test('a refused URL is answered, not crashed on', async () => {
    /*  404, not 400: a rejected URL is not a request this endpoint has any
        opinion about, and "no such image" is the whole of what a caller needs
        to know. It must also never throw - this runs inside a page full of
        rows, and one bad image must not take the response with it. */
    const written = { status: null, body: null }
    const response = {
        writeHead (status) { written.status = status },
        end (body) { written.body = body }
    }
    IMAGES.handle(new URL('http://x/img?u=https://evil.test/a.jpg'), response, {})
    assert.strictEqual(written.status, 404)

    IMAGES.handle(new URL('http://x/img'), response, {})
    assert.strictEqual(written.status, 404, 'a missing parameter was not refused')
})

test('the query string and fragment are dropped before fetching', () => {
    /*  Rebuilt from the parsed host and path, so nothing riding along in a
        query string reaches the fetch. */
    const proxied = IMAGES.proxied(REAL + '?tracking=1#fragment')
    assert.strictEqual(decodeURIComponent(proxied.split('u=')[1]), REAL)
})
