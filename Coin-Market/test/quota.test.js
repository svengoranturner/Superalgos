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

/*
    Sweep error reporting.

    The collector runs unattended for months. A bare count cannot distinguish
    eight transient timeouts from one partition failing every sweep, and the
    second is the one that quietly costs coverage.
*/
const SCHEDULER = require('../src/collect/scheduler.js')

test('repeated errors are grouped with a count, most frequent first', () => {
    const summary = SCHEDULER.summariseErrors([
        'sovereign: timeout', 'sovereign: timeout', 'sovereign: timeout', 'britannia: 500'
    ])
    assert.match(summary, /^3x sovereign: timeout/)
    assert.ok(summary.includes('britannia: 500'))
})

test('a single error is not given a redundant multiplier', () => {
    assert.strictEqual(SCHEDULER.summariseErrors(['half-sovereign: budget exhausted']),
        'half-sovereign: budget exhausted')
})

test('a storm of distinct errors is capped rather than flooding the journal', () => {
    const many = ['a: x', 'b: x', 'c: x', 'd: x', 'e: x']
    const summary = SCHEDULER.summariseErrors(many)
    assert.ok(summary.includes('and 2 more'), summary)
    assert.ok(summary.split(';').length <= 4, summary)
})

test('no errors summarise to an empty string', () => {
    assert.strictEqual(SCHEDULER.summariseErrors([]), '')
})

/*
    The budget ledger against eBay's authoritative figure.

    Nothing here existed while the bug did, which is exactly why the bug
    lasted: quota.js was tested thoroughly, and the ledger that consumes its
    answer was not tested at all. The header above even names the hazard.

    Both defects below were found in production, from the collector's own
    journal, after discovery had been returning "0 listings seen" for seven
    consecutive sweeps.
*/
const { newBudget } = require('../src/ebay/budget.js')
const { newDatabase } = require('../src/store/db.js')

function ledger (options) {
    return newBudget(newDatabase(':memory:'), options)
}

test('reconciling twice with the same figure does not move the budget', () => {
    /*
        The oscillation. The correction row is a gap, not a count of calls,
        so it has to be measured against our own calls alone. Measured
        against spent() - which already contains the last correction - and
        then written over that correction, each pass discards the previous
        one and hands the collector back calls it never had.

        Production, every thirty minutes, for days:
            eBay reports 850 left; corrected ours  854 -> 4120
            eBay reports 810 left; corrected ours 4075 ->  814
            eBay reports 630 left; corrected ours  638 -> 3895
    */
    const budget = ledger()
    for (let i = 0; i < 40; i++) { budget.record('browse') }

    budget.reconcile(850)
    assert.strictEqual(budget.remaining(), 850)

    budget.reconcile(850)
    assert.strictEqual(budget.remaining(), 850, 'the second pass moved a budget nothing had spent')

    budget.reconcile(850)
    assert.strictEqual(budget.remaining(), 850)
})

test('calls made after a reading are charged against it', () => {
    /*  Between readings the correction is fixed and our own count keeps
        rising, so remaining() must track eBay's last figure minus what we
        have spent since. Without this the reading would freeze the budget
        for a whole reconcile interval. */
    const budget = ledger()
    budget.reconcile(500)
    assert.strictEqual(budget.remaining(), 500)
    for (let i = 0; i < 30; i++) { budget.record('browse') }
    assert.strictEqual(budget.remaining(), 470)
})

test('when eBay says the window has reset, the ledger comes back up', () => {
    /*
        The outage. Our day rolls at UTC midnight, eBay's Browse window at
        07:00 UTC, so for seven hours a day the two disagree by a whole
        window's spend. A correction that could only ever ADD spend left the
        ledger pinned at exhausted from 07:00 UTC until midnight: the
        collector sat blind for seventeen hours holding a full allowance it
        refused to spend, and the journal showed sweep after sweep of
        "0 listings seen" while only 1,590 calls had actually been made.
    */
    const budget = ledger()
    for (let i = 0; i < 1590; i++) { budget.record('browse') }
    budget.reconcile(150)
    assert.strictEqual(budget.remaining(), 150)
    assert.strictEqual(budget.allows('discover', 200), false, 'it should be out of budget here')

    /*  eBay's window turns over. It is authoritative in this direction too. */
    budget.reconcile(5000)
    assert.strictEqual(budget.remaining(), 5000, 'the ledger stayed pinned at exhausted')
    assert.strictEqual(budget.allows('discover', 200), true)
})

test('a correction can never hand out more than the configured ceiling', () => {
    /*  dailyLimit is what this deployment has decided to spend, not what
        eBay happens to grant - the module's own header calls the Trading
        figure a conservative guess rather than a measured one. A keyset with
        a larger real grant would otherwise drive spend negative and hand the
        collector a budget above its own ceiling. */
    const budget = ledger({ dailyLimit: 5000 })
    budget.reconcile(6000)
    assert.strictEqual(budget.remaining(), 5000, 'the ledger exceeded its own ceiling')

    /*  And it still charges calls made afterwards against that ceiling. */
    for (let i = 0; i < 10; i++) { budget.record('browse') }
    assert.strictEqual(budget.remaining(), 5000)
})

test('an unreadable quota leaves the ledger alone', () => {
    /*  quota.browseRemaining answers null on any failure, and a failed
        reading must not be mistaken for a reset window. */
    const budget = ledger()
    for (let i = 0; i < 100; i++) { budget.record('browse') }
    budget.reconcile(400)
    for (const bad of [null, undefined, NaN, 'lots']) {
        budget.reconcile(bad)
        assert.strictEqual(budget.remaining(), 400, 'a ' + String(bad) + ' reading moved the budget')
    }
})

test('reconciling Browse never touches the Trading allowance', () => {
    /*  The two grants are separate, and outcome resolution must not be able
        to starve discovery or be starved by it. */
    const budget = ledger()
    for (let i = 0; i < 20; i++) { budget.record('trading') }
    budget.reconcile(100)
    assert.strictEqual(budget.remaining(), 100)
    assert.strictEqual(budget.tradingRemaining(), 4980, 'a Browse correction moved Trading')
})
