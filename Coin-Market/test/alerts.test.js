'use strict'

const test = require('node:test')
const assert = require('node:assert')

const RULES = require('../src/alerts/rules.js')
const BUYER = require('../src/analytics/buyercost.js')

const CEILING = 850

/*  A lot whose all-in cost lands exactly on a target, so a test can say
    "9% over the ceiling" and mean it. Prices run through PREMIUM.totalCost,
    which charges the buyer fee, so the price is derived rather than guessed. */
function lotCosting (allIn, extra) {
    const shipping = 4.5
    return Object.assign({
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
