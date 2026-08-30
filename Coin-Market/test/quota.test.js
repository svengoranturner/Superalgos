'use strict'

const test = require('node:test')
const assert = require('node:assert')

const QUOTA = require('../src/ebay/quota.js')

/*
    Reading eBay's authoritative quota.

    This exists because the local counter and eBay's window roll at different
    times - UTC midnight against 07:00 UTC - so for seven hours a day the
    local count is optimistic by a whole window's spend. Everything here is
    about failing towards under-spending.
*/

const auth = {
    endpoints: { analytics: 'https://api.ebay.com/developer/analytics/v1_beta' },
    applicationToken: async () => 'token'
}

function respond (payload, ok) {
    return async () => ({ ok: ok === undefined ? true : ok, json: async () => payload })
}

test('the Browse remaining count is read out of the quota response', async () => {
    const fetchImpl = respond({
        rateLimits: [
            { apiName: 'Buy', resources: [{ name: 'buy.browse', rates: [{ remaining: 4960, limit: 5000 }] }] }
        ]
    })
    assert.strictEqual(await QUOTA.browseRemaining(auth, fetchImpl), 4960)
})

/*  Production really does answer with two rows for the same resource - 4960
    and 5000 on the same call. Believing the higher one would hand back calls
    that are not there. */
test('when eBay returns two rows for Browse, the lower is believed', async () => {
    const fetchImpl = respond({
        rateLimits: [
            {
                apiName: 'Buy',
                resources: [{ name: 'buy.browse', rates: [{ remaining: 5000 }, { remaining: 4960 }] }]
            }
        ]
    })
    assert.strictEqual(await QUOTA.browseRemaining(auth, fetchImpl), 4960)
})

test('a non-Browse quota response yields null rather than a wrong number', async () => {
    const fetchImpl = respond({
        rateLimits: [{ apiName: 'Sell', resources: [{ name: 'sell.account', rates: [{ remaining: 10 }] }] }]
    })
    assert.strictEqual(await QUOTA.browseRemaining(auth, fetchImpl), null)
})

test('an HTTP failure yields null, so the collector keeps its own estimate', async () => {
    assert.strictEqual(await QUOTA.browseRemaining(auth, respond({}, false)), null)
})

test('an empty or malformed payload yields null', async () => {
    assert.strictEqual(await QUOTA.browseRemaining(auth, respond({})), null)
    assert.strictEqual(await QUOTA.browseRemaining(auth, respond({ rateLimits: [] })), null)
    const noRates = respond({ rateLimits: [{ apiName: 'Buy', resources: [{ name: 'buy.browse', rates: [] }] }] })
    assert.strictEqual(await QUOTA.browseRemaining(auth, noRates), null)
})

/*  A rate row without a numeric remaining must not become NaN and poison
    the comparison in budget.reconcile. */
test('non-numeric remaining values are ignored', async () => {
    const fetchImpl = respond({
        rateLimits: [{
            apiName: 'Buy',
            resources: [{ name: 'buy.browse', rates: [{ remaining: null }, { remaining: 4900 }] }]
        }]
    })
    assert.strictEqual(await QUOTA.browseRemaining(auth, fetchImpl), 4900)
})
