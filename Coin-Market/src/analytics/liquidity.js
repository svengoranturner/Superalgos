'use strict'

const STATS = require('./stats.js')

const DAY_MS = 24 * 60 * 60 * 1000

/*
    Liquidity metrics for a thinly traded collectible market.

    "What is it worth" is only half the question. The other half is whether
    the thing trades at all: a coin with a tight median and two sales a
    year is not a market, it is a coincidence. These metrics are what let
    the dashboard distinguish the two.
*/

/*
    listings:  [{ browseId, buyingOptions, askPremium, listedAt, sellerHash, title }]
    outcomes:  [{ browseId, sold, endedAt, clearingPremium, bidCount, saleType, censored, listedAt }]
*/
exports.metrics = function (listings, outcomes, options) {

    const config = Object.assign({ windowDays: 90, now: Date.now() }, options || {})
    const now = new Date(config.now).getTime()
    const cutoff = now - config.windowDays * DAY_MS

    const recent = outcomes.filter(o => {
        const t = new Date(o.endedAt).getTime()
        return Number.isFinite(t) && t >= cutoff
    })

    const sold = recent.filter(o => o.sold)
    const auctions = recent.filter(o => o.saleType === 'AUCTION')
    const soldAuctions = auctions.filter(o => o.sold && !o.censored)

    /* Clearing premiums come from auctions only. A Buy-It-Now sale tells
       you what one buyer would pay on demand, not where the market clears. */
    const clearingPremiums = soldAuctions
        .map(o => o.clearingPremium)
        .filter(p => Number.isFinite(p))

    /* Asking premiums come from live fixed-price listings. */
    const askPremiums = listings
        .filter(l => String(l.buyingOptions || '').includes('FIXED_PRICE'))
        .map(l => l.askPremium)
        .filter(p => Number.isFinite(p))

    const medianClearing = clearingPremiums.length > 0 ? STATS.median(clearingPremiums) : null
    const medianAsk = askPremiums.length > 0 ? STATS.median(askPremiums) : null

    /* Days-to-sale for fixed-price listings that did sell. */
    const daysToSale = recent
        .filter(o => o.sold && o.saleType !== 'AUCTION' && o.listedAt)
        .map(o => (new Date(o.endedAt).getTime() - new Date(o.listedAt).getTime()) / DAY_MS)
        .filter(d => Number.isFinite(d) && d >= 0)

    const bidCounts = auctions.map(o => o.bidCount).filter(b => Number.isFinite(b))
    const withBids = bidCounts.filter(b => b > 0)

    const weeks = config.windowDays / 7

    return {
        windowDays: config.windowDays,

        /* Depth and velocity */
        activeListings: listings.length,
        endedInWindow: recent.length,
        soldInWindow: sold.length,
        salesPerWeek: weeks > 0 ? sold.length / weeks : null,

        /* How much listed stock is fantasy pricing */
        sellThroughRate: recent.length > 0 ? sold.length / recent.length : null,
        medianDaysToSale: daysToSale.length > 0 ? STATS.median(daysToSale) : null,

        /* Genuine competition, or an empty room */
        auctionsInWindow: auctions.length,
        pctAuctionsWithBids: bidCounts.length > 0 ? withBids.length / bidCounts.length : null,
        medianBidCount: withBids.length > 0 ? STATS.median(withBids) : null,

        /* The headline: how inflated asking prices are relative to where
           the market actually clears. This is the number that says how
           much room there is to make an offer below a Buy-It-Now. */
        medianAskPremium: medianAsk,
        medianClearingPremium: medianClearing,
        askClearingSpread: (medianAsk !== null && medianClearing !== null) ? medianAsk - medianClearing : null,

        /* What patience is worth: the spread of clearing prices themselves */
        clearingIqr: clearingPremiums.length >= 4
            ? STATS.quantile(clearingPremiums, 0.75) - STATS.quantile(clearingPremiums, 0.25)
            : null,
        clearingDispersion: clearingPremiums.length > 0 ? STATS.medianAbsoluteDeviation(clearingPremiums) : null,

        /* Data-honesty counters */
        censoredOutcomes: recent.filter(o => o.censored).length,
        clearingSampleSize: clearingPremiums.length,
        askSampleSize: askPremiums.length,

        relistRate: exports.relistRate(recent)
    }
}

/*
    Relist detection.

    An unsold lot that is relisted and finally sells looks, naively, like
    two listings with a 50% sell-through. It is one coin and one sale.
    Matching on (seller, normalised title) catches the common case and
    stops sell-through being flattered by sellers who relist doggedly.
*/
exports.relistRate = function (outcomes) {
    const seen = new Map()
    let relists = 0

    const ordered = outcomes.slice().sort(
        (a, b) => new Date(a.endedAt).getTime() - new Date(b.endedAt).getTime()
    )

    for (const outcome of ordered) {
        const fingerprint = exports.fingerprint(outcome)
        if (fingerprint === null) { continue }
        if (seen.has(fingerprint)) { relists++ } else { seen.set(fingerprint, true) }
    }

    return ordered.length > 0 ? relists / ordered.length : null
}

/*
    Identifies "the same coin listed again".

    A certification number names one physical slabbed coin, so when eBay's
    standardised coin condition descriptors supply one it beats every
    heuristic: it matches the same coin even across different sellers, and
    so also catches a resale, not merely a relist.

    Without one, fall back to seller plus normalised title - which only
    catches the same seller relisting, and is defeated by a retitle.
*/
exports.fingerprint = function (outcome) {
    if (outcome.certNumber) { return 'cert|' + String(outcome.certNumber).trim().toUpperCase() }
    const seller = outcome.sellerIdHash || outcome.sellerHash
    if (!seller || !outcome.title) { return null }
    return 'seller|' + seller + '|' + normaliseTitle(outcome.title)
}

/*
    Strips the seller theatre so the same coin relisted under a new headline
    still fingerprints the same.

    Noise phrases are removed BEFORE punctuation, not after: "free p&p"
    becomes "free p p" once punctuation is stripped, which no longer
    matches its own pattern. Getting this order wrong made the fallback
    fingerprint miss the very retitles it exists to catch.
*/
const NOISE = [
    /free\s*p\s*&\s*p/g, /free\s*post(age)?/g, /free\s*(uk\s*)?delivery/g,
    /\bl@@k\b/g, /\bwow\b/g, /\brare\b/g, /\bstunning\b/g, /\blovely\b/g,
    /\bsuperb\b/g, /\bgorgeous\b/g, /\bbargain\b/g, /\bmust\s*see\b/g,
    /[!*~]+/g
]

function normaliseTitle (title) {
    let text = String(title).toLowerCase()
    for (const pattern of NOISE) { text = text.replace(pattern, ' ') }
    return text
        .replace(/[^a-z0-9 ]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
}

exports.normaliseTitle = normaliseTitle
