'use strict'

const STATS = require('./stats.js')

const DAY_MS = 24 * 60 * 60 * 1000

/*
    Sale channels, and what a price from each one is actually worth.

    A premium is only meaningful next to the way the coin changed hands. An
    auction result is where a room full of bidders stopped; a Buy-It-Now
    result is what one buyer would pay on demand without waiting. Averaging
    the two produces a number that describes neither, which is why the
    clearing figure has always been auction-only.

    But auction-only was implemented by DISCARDING everything else, and that
    is a different decision wearing the same clothes. Buy-It-Now sales were
    resolved, stored, rendered - and then filtered out of fair value and out
    of the clearing median, so they informed nothing. The owner's ask is the
    correct one: keep every sale, and keep them apart.

    THE THIRD CHANNEL IS THE SUBTLE ONE. eBay lets a seller enable Best
    Offer on a Buy-It-Now listing. If the lot then sells, eBay says only
    that it sold - never whether an offer was accepted, and never for how
    much. Measured on three lots whose real outcomes were known from eBay's
    own sold pages: BestOfferCount was 4 on one that sold at the asking
    price and 1 on one that sold via an accepted offer, and every other
    field in GetItem was identical in kind. eBay's own web page marks the
    difference by striking the price through; the API does not carry it.

    So for that channel the listed price is an UPPER BOUND on what changed
    hands, and nothing better. It is still information - a coin that sold at
    or below +12% did not sell at +40% - and 45% of the Buy-It-Now corpus
    lives here, so throwing it away is not free. It is kept, and it is
    labelled, and it is never blended with a price somebody actually paid.
*/

const CHANNELS = {
    AUCTION: {
        id: 'AUCTION',
        label: 'Auction',
        short: 'auction',
        /*  A hammer price is exact, but an auction outcome reconstructed
            from our own snapshots (the 90-day window having closed) is not -
            hence exactness is read per row from `censored`, never assumed
            from the channel. */
        blurb: 'What a room full of bidders stopped at.'
    },
    FIXED_PRICE: {
        id: 'FIXED_PRICE',
        label: 'Buy-It-Now',
        short: 'buy-it-now',
        blurb: 'Bought outright at the asking price. Exact, and known.'
    },
    BEST_OFFER: {
        id: 'BEST_OFFER',
        label: 'Buy-It-Now, offers allowed',
        short: 'offers allowed',
        blurb: 'The seller accepted offers on this lot. eBay never says ' +
               'whether one was taken, so the price shown is what it sold ' +
               'at or below.'
    }
}

const ORDER = ['AUCTION', 'FIXED_PRICE', 'BEST_OFFER']

exports.CHANNELS = CHANNELS
exports.ORDER = ORDER

/*
    The channel a stored outcome belongs to.

    Anything unrecognised - an old row, a sale type eBay adds later - comes
    back null rather than being quietly filed under Buy-It-Now, because a
    premium in the wrong channel is worse than a premium in no channel.
*/
exports.channelOf = function (outcome) {
    if (outcome === null || outcome === undefined) { return null }
    const id = outcome.saleType === undefined ? outcome.sale_type : outcome.saleType
    return CHANNELS[id] === undefined ? null : CHANNELS[id]
}

/*
    Premium statistics per channel, kept strictly apart.

    outcomes: [{ sold, endedAt, clearingPremium, saleType, censored }]

    Each channel reports its own n, quantiles and bound. `bound` is derived
    from the rows that went in, never from the channel name:

      exact - every observation is a price somebody paid
      upper - every observation is a ceiling; the true figure is at or below
      mixed - both, so read the median as a ceiling too

    A caller that wants only prices people actually paid reads the channels
    whose bound is 'exact'. A caller that wants the whole market reads them
    all and shows the bound. Neither has to know which sale types exist.
*/
exports.premiumsByChannel = function (outcomes, options) {
    const config = Object.assign({ windowDays: 90, now: Date.now(), minObservations: 1 },
        options || {})
    const cutoff = new Date(config.now).getTime() - config.windowDays * DAY_MS

    const buckets = new Map(ORDER.map(id => [id, { exact: [], bounded: [] }]))
    let unrecognised = 0

    for (const outcome of outcomes || []) {
        if (!outcome || !outcome.sold) { continue }
        const channel = exports.channelOf(outcome)
        if (channel === null) { unrecognised++; continue }

        const premium = outcome.clearingPremium
        if (premium === null || premium === undefined || !Number.isFinite(premium)) { continue }

        const endedAt = new Date(outcome.endedAt).getTime()
        if (!Number.isFinite(endedAt) || endedAt < cutoff) { continue }

        const bucket = buckets.get(channel.id)
        if (outcome.censored) { bucket.bounded.push(premium) } else { bucket.exact.push(premium) }
    }

    const byChannel = {}
    for (const id of ORDER) {
        const bucket = buckets.get(id)
        const values = bucket.exact.concat(bucket.bounded).sort((a, b) => a - b)
        const bound = bucket.bounded.length === 0
            ? 'exact'
            : (bucket.exact.length === 0 ? 'upper' : 'mixed')

        byChannel[id] = {
            channel: CHANNELS[id],
            n: values.length,
            exactN: bucket.exact.length,
            boundedN: bucket.bounded.length,
            bound,
            sufficient: values.length >= config.minObservations,
            median: values.length > 0 ? STATS.median(values) : null,
            p25: values.length > 0 ? STATS.quantile(values, 0.25) : null,
            p75: values.length > 0 ? STATS.quantile(values, 0.75) : null,
            dispersion: values.length > 0 ? STATS.medianAbsoluteDeviation(values) : null
        }
    }

    return { byChannel, unrecognised, windowDays: config.windowDays }
}
