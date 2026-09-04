'use strict'

const test = require('node:test')
const assert = require('node:assert')

const CHANNELS = require('../src/analytics/channels.js')
const FAIRVALUE = require('../src/analytics/fairvalue.js')

/*
    Premiums per sale channel.

    Not mixing an auction result with a Buy-It-Now result was always right.
    Implementing that by DISCARDING everything that was not an auction was
    not: Buy-It-Now sales were resolved, stored and rendered, and then fed no
    statistic anywhere, so "what does this coin fetch on a Buy-It-Now" had no
    answer in the tool while the rows sat in the table.

    The owner's ask, verbatim: "all the data is useful as long as I know what
    it is. I want to know what a BIN premium is vs an auction premium. as long
    as they can be calculated and displayed separately that's fine."

    So: keep everything, keep it apart, and label what each price is worth.
*/

const NOW = new Date('2026-09-04T12:00:00Z').getTime()
const DAY = 86400000

const sale = (saleType, premium, options) => Object.assign({
    sold: true,
    saleType,
    clearingPremium: premium,
    endedAt: new Date(NOW - DAY).toISOString(),
    censored: false
}, options || {})

const at = repo => CHANNELS.premiumsByChannel(repo, { now: NOW, windowDays: 90 })

/*  Premiums are ratios, so an exact float comparison fails on arithmetic
    that is correct: (0.40 + 0.44) / 2 is 0.42000000000000004. */
const near = (actual, expected, what) =>
    assert.ok(Math.abs(actual - expected) < 1e-9,
        (what || 'value') + ': expected ~' + expected + ', got ' + actual)

test('an auction premium and a Buy-It-Now premium are never averaged together', () => {
    const { byChannel } = at([
        sale('AUCTION', 0.10), sale('AUCTION', 0.12), sale('AUCTION', 0.14),
        sale('FIXED_PRICE', 0.40), sale('FIXED_PRICE', 0.44)
    ])
    assert.strictEqual(byChannel.AUCTION.n, 3)
    assert.strictEqual(byChannel.FIXED_PRICE.n, 2)
    near(byChannel.AUCTION.median, 0.12, 'auction median')
    near(byChannel.FIXED_PRICE.median, 0.42, 'buy-it-now median')
    /*  The blended median of all five would be 0.14, which describes neither
        way of buying a coin. */
    assert.notStrictEqual(byChannel.AUCTION.median, 0.14)
})

test('a plain Buy-It-Now price is marked as exact', () => {
    /*  No offers allowed on the listing, so the price is what somebody paid
        and there is nothing to hedge about. */
    const { byChannel } = at([sale('FIXED_PRICE', 0.31)])
    assert.strictEqual(byChannel.FIXED_PRICE.bound, 'exact')
    assert.strictEqual(byChannel.FIXED_PRICE.exactN, 1)
    assert.strictEqual(byChannel.FIXED_PRICE.boundedN, 0)
})

test('an offers-allowed sale is kept, and marked as a ceiling rather than a price', () => {
    /*
        This is the one that was being thrown away. eBay lets a seller enable
        Best Offer on a Buy-It-Now and then never says whether an offer was
        taken - measured on three lots whose true outcomes were known from
        eBay's own sold pages, BestOfferCount was 4 on one that sold at the
        asking price and 1 on one that sold via an accepted offer, and
        GetItem carried nothing else that differed.

        So the price is an upper bound. That is still information: a coin
        that sold at or below +18% did not sell at +40%. Discarding it threw
        away 45% of the Buy-It-Now market to avoid saying "at most".
    */
    const { byChannel } = at([
        sale('BEST_OFFER', 0.18, { censored: true }),
        sale('BEST_OFFER', 0.22, { censored: true })
    ])
    assert.strictEqual(byChannel.BEST_OFFER.n, 2, 'the offers-allowed sales were dropped')
    assert.strictEqual(byChannel.BEST_OFFER.bound, 'upper')
    near(byChannel.BEST_OFFER.median, 0.20, 'offers-allowed median')
})

test('a channel holding both kinds of price says so rather than picking one', () => {
    /*  Auctions land here: a hammer price is exact, but an outcome
        reconstructed from our own last snapshot after the 90-day window
        closed is a lower bound and is stored censored. A channel that
        silently mixed the two would report a figure with no known meaning. */
    const { byChannel } = at([
        sale('AUCTION', 0.10),
        sale('AUCTION', 0.20, { censored: true })
    ])
    assert.strictEqual(byChannel.AUCTION.bound, 'mixed')
    assert.strictEqual(byChannel.AUCTION.exactN, 1)
    assert.strictEqual(byChannel.AUCTION.boundedN, 1)
})

test('an unfamiliar sale type is counted, not filed under Buy-It-Now', () => {
    /*  An old row, or a sale type eBay adds later. A premium in the wrong
        channel is worse than a premium in no channel, because it is
        invisible. */
    const result = at([sale('SOMETHING_NEW', 0.5), sale('AUCTION', 0.1)])
    assert.strictEqual(result.unrecognised, 1)
    assert.strictEqual(result.byChannel.FIXED_PRICE.n, 0)
    assert.strictEqual(result.byChannel.AUCTION.n, 1)
})

test('unsold lots and stale sales stay out of every channel', () => {
    const { byChannel } = at([
        sale('AUCTION', 0.10, { sold: false }),
        sale('AUCTION', 0.99, { endedAt: new Date(NOW - 200 * DAY).toISOString() }),
        sale('AUCTION', 0.10, { clearingPremium: null }),
        sale('AUCTION', 0.12)
    ])
    assert.strictEqual(byChannel.AUCTION.n, 1)
    near(byChannel.AUCTION.median, 0.12, 'auction median')
})

/* ------------------------------------------------------------ fair value */

const obs = (premium, censored) => ({
    premium, soldAt: new Date(NOW - DAY).toISOString(), censored: censored === true
})

test('fair value still refuses censored prices by default', () => {
    /*  The headline figure feeds the bid ceiling, which must not drift
        upward on prices nobody paid. Unchanged, and pinned so it stays
        unchanged. */
    const fair = FAIRVALUE.fairValue(
        [obs(0.1), obs(0.12), obs(0.14), obs(0.9, true)], { now: NOW })
    assert.strictEqual(fair.n, 3)
    assert.strictEqual(fair.censored, 1)
    assert.strictEqual(fair.bound, 'exact')
    assert.ok(fair.p50 < 0.2, 'a ceiling price leaked into the headline estimate')
})

test('fair value can keep censored prices when the answer wanted is a ceiling', () => {
    const fair = FAIRVALUE.fairValue(
        [obs(0.18, true), obs(0.20, true), obs(0.22, true)],
        { now: NOW, includeCensored: true })
    assert.strictEqual(fair.sufficient, true)
    assert.strictEqual(fair.n, 3)
    assert.strictEqual(fair.bound, 'upper', 'a ceiling was reported as a price somebody paid')
})

test('asking for censored prices and receiving none still reports an exact figure', () => {
    /*  The bound is read off what actually went in, never off the caller's
        intent - otherwise a channel that happens to hold only clean prices
        would hedge about them for no reason. */
    const fair = FAIRVALUE.fairValue([obs(0.1), obs(0.12), obs(0.14)],
        { now: NOW, includeCensored: true })
    assert.strictEqual(fair.bound, 'exact')
})
