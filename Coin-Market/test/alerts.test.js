'use strict'

const test = require('node:test')
const assert = require('node:assert')

const RULES = require('../src/alerts/rules.js')
const BUYER = require('../src/analytics/buyercost.js')
const FRESHNESS = require('../src/analytics/freshness.js')

const CEILING = 850

/*  A lot whose all-in cost lands exactly on a target, so a test can say
    "9% over the ceiling" and mean it. Prices run through PREMIUM.totalCost,
    which charges the buyer fee, so the price is derived rather than guessed. */
function lotCosting (allIn, extra) {
    const shipping = 4.5
    return Object.assign({
        /*  Seen by the sweep just now unless a test says otherwise. */
        lastSeen: new Date().toISOString(),
        browseId: 'v1|x|0',
        legacyId: 'x',
        title: 'Gold Sovereign',
        itemWebUrl: 'https://ebay.co.uk/x',
        buyingOptions: 'FIXED_PRICE|BEST_OFFER',
        price: BUYER.priceForCost(allIn) - shipping,
        shipping
    }, extra || {})
}

function viewOf (listings) {
    return {
        fairValue: { sufficient: true },
        bidCeiling: { allInValue: CEILING },
        spot: { gbpPerOz: 3292 },
        active: listings
    }
}

test('a Best Offer lot above the ceiling is worth an offer; a rigid one is not', () => {
    const near = RULES.evaluate(viewOf([lotCosting(CEILING * 1.09)]), null, {})
    assert.strictEqual(near.length, 1)
    assert.strictEqual(near[0].rule, 'BEST_OFFER_IN_REACH')
    assert.ok(Math.abs(near[0].gap - 0.09) < 0.001, 'gap reported as measured')

    /*  Same lot, same price, no Best Offer button: there is nothing to ask
        for, so surfacing it would just be a listing you cannot afford. */
    const rigid = RULES.evaluate(viewOf([
        lotCosting(CEILING * 1.09, { buyingOptions: 'FIXED_PRICE' })
    ]), null, {})
    assert.deepStrictEqual(rigid, [])
})

test('an offer a quarter under the ask is optimistic; further is noise', () => {
    assert.strictEqual(RULES.evaluate(viewOf([lotCosting(CEILING * 1.24)]), null, {}).length, 1)
    assert.strictEqual(RULES.evaluate(viewOf([lotCosting(CEILING * 1.40)]), null, {}).length, 0)
})

/*  The whole point of the number. An offer is a price you type into eBay,
    and eBay adds its fee on top - so the offer plus postage plus fee has to
    fit inside the ceiling it was derived from, or acting on the alert
    overpays by exactly the amount MKT-10 was written to remove. */
test('the suggested offer, once eBay adds its fee, still fits inside the ceiling', () => {
    const alert = RULES.evaluate(viewOf([lotCosting(CEILING * 1.10)]), null, {})[0]
    assert.ok(BUYER.buyerCost(alert.suggestedOffer + 4.5) <= CEILING,
        'offer ' + alert.suggestedOffer + ' + postage + fee must not exceed ' + CEILING)
    assert.ok(alert.suggestedOffer < alert.askPrice, 'an offer must be below the ask')
    assert.ok(alert.discount > 0 && alert.discount < 1)
})

/*  Already cheap enough to just buy. That is a different decision from a
    negotiation, and it must not be reported as one. */
test('a lot already below clearing is a purchase, not a negotiation', () => {
    const alerts = RULES.evaluate(viewOf([lotCosting(CEILING * 0.90)]), null, {})
    assert.strictEqual(alerts.length, 1)
    assert.strictEqual(alerts[0].rule, 'BIN_BELOW_CLEARING')
})

test('no evidence, no opinion', () => {
    const view = viewOf([lotCosting(CEILING * 1.09)])
    view.fairValue = { sufficient: false }
    assert.deepStrictEqual(RULES.evaluate(view, null, {}), [])
})

/*  A lot you can buy under clearing outranks one you have to haggle for,
    and among the haggles the smallest gap is likeliest to be accepted. */
test('purchases rank above offers, and closer offers above distant ones', () => {
    const alerts = RULES.evaluate(viewOf([
        Object.assign(lotCosting(CEILING * 1.20), { browseId: 'v1|far|0', legacyId: 'far' }),
        Object.assign(lotCosting(CEILING * 1.05), { browseId: 'v1|near|0', legacyId: 'near' }),
        Object.assign(lotCosting(CEILING * 0.90), { browseId: 'v1|buy|0', legacyId: 'buy' })
    ]), null, {})
    assert.deepStrictEqual(alerts.map(a => a.legacyId), ['buy', 'near', 'far'])
})

/*  The failure that prompted this: the offers panel's top suggestion had not
    been seen for 21.3 hours and had already sold. A Buy-It-Now lot has no end
    time and its outcome is never resolved (COL-01), so how recently a sweep
    saw it is the only evidence it still exists - and the 24-hour window that
    decides what counts as an active ask is far too loose to spend money on. */
test('a lot the sweep has stopped seeing is never worth an alert', () => {
    const stale = new Date(Date.now() - 21.3 * 3600000).toISOString()
    const fresh = new Date(Date.now() - 20 * 60000).toISOString()

    assert.strictEqual(
        RULES.evaluate(viewOf([lotCosting(CEILING * 1.09, { lastSeen: stale })]), null, {}).length, 0,
        'a lot last seen 21 hours ago must not be offered on')
    assert.strictEqual(
        RULES.evaluate(viewOf([lotCosting(CEILING * 1.09, { lastSeen: fresh })]), null, {}).length, 1,
        'a lot seen 20 minutes ago is current')

    /*  Same for the cheaper rule - a lot below clearing is no more real for
        being cheap. */
    assert.strictEqual(
        RULES.evaluate(viewOf([lotCosting(CEILING * 0.90, { lastSeen: stale })]), null, {}).length, 0)

    /*  Fails OPEN on an unrecorded last_seen: every stored row has one, so
        this only fires when a caller forgot the column, and silently emptying
        a panel looks like a true "nothing to see". */
    assert.strictEqual(
        RULES.evaluate(viewOf([lotCosting(CEILING * 1.09, { lastSeen: null })]), null, {}).length, 1)
})

test('freshness is measured in hours and described for a human', () => {
    const now = Date.now()
    const at = h => new Date(now - h * 3600000).toISOString()

    assert.ok(FRESHNESS.isActionable(at(1.9), now))
    assert.ok(!FRESHNESS.isActionable(at(2.1), now))
    assert.strictEqual(FRESHNESS.describe(at(0.5), now), 'seen 30 min ago')
    assert.strictEqual(FRESHNESS.describe(at(8), now), 'seen 8h ago')
    assert.strictEqual(FRESHNESS.describe(at(50), now), 'seen 2d ago')
    assert.strictEqual(FRESHNESS.describe(null, now), null)

    /*  The window that decides what counts as an active ask must stay looser
        than the window that decides what is worth acting on - the statistics
        need the sample and are not sending anyone to a checkout. */
    assert.ok(FRESHNESS.ACTIONABLE_HOURS < 24)
})
