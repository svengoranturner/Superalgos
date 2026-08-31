'use strict'

const UPLIFT = require('../analytics/uplift.js')
const PREMIUM = require('../analytics/premium.js')
const BUYER = require('../analytics/buyercost.js')

/*
    Alert rules.

    The discipline here is to fire on PROJECTED outcomes, not current
    prices. An auction sitting below fair value with an hour to go is the
    normal state of every auction on eBay - alerting on that would produce
    a stream of notifications with no information in it, and you would
    switch them off within a day.

    So a lot only alerts when, after applying the closing-uplift curve
    learned from our own snapshots, it still looks cheap.
*/

exports.evaluate = function (view, curve, options) {

    const config = Object.assign(
        { minEdge: 0.03, endingWithinMinutes: 120, maxOfferGap: 0.25 }, options || {})
    const alerts = []

    if (!view.fairValue.sufficient || view.bidCeiling === null || view.spot === null) {
        return alerts        /* no opinion without evidence */
    }

    const now = Date.now()
    const ceiling = view.bidCeiling.allInValue

    for (const listing of view.active) {
        const total = PREMIUM.totalCost(listing.price, listing.shipping)
        if (!Number.isFinite(total) || total <= 0) { continue }

        const isAuction = String(listing.buyingOptions).includes('AUCTION')
        const secondsToEnd = listing.endTime
            ? (new Date(listing.endTime).getTime() - now) / 1000
            : null

        if (isAuction) {
            if (secondsToEnd === null || secondsToEnd < 0) { continue }
            if (secondsToEnd > config.endingWithinMinutes * 60) { continue }

            const projection = UPLIFT.project(total, secondsToEnd, curve)
            /*
                No projection means the curve has not learned this bucket
                yet. Staying silent is correct: assuming an uplift of 1.0
                during the cold-start weeks would flag every early auction
                as a bargain and train you to ignore the alerts.
            */
            if (projection === null) { continue }

            const edge = (ceiling - projection.expected) / ceiling
            if (edge < config.minEdge) { continue }

            alerts.push({
                rule: 'AUCTION_PROJECTED_BELOW_CEILING',
                browseId: listing.browseId,
                title: listing.title,
                url: listing.itemWebUrl,
                imageUrl: listing.imageUrl,
                legacyId: listing.legacyId,
                currentTotal: total,
                projectedFinal: projection.expected,
                projectedRange: [projection.optimistic, projection.pessimistic],
                bidCeiling: ceiling,
                maxBid: BUYER.priceForCost(ceiling) - (listing.shipping || 0),
                edge,
                minutesLeft: Math.round(secondsToEnd / 60),
                basedOn: projection.basedOn
            })
            continue
        }

        /* Fixed price / Best Offer: no uplift to model, so compare directly. */
        const edge = (ceiling - total) / ceiling
        if (edge >= config.minEdge) {
            alerts.push({
                rule: 'BIN_BELOW_CLEARING',
                browseId: listing.browseId,
                title: listing.title,
                url: listing.itemWebUrl,
                imageUrl: listing.imageUrl,
                legacyId: listing.legacyId,
                currentTotal: total,
                bidCeiling: ceiling,
                edge,
                askPremium: listing.askPremium,
                suggestedOffer: BUYER.priceForCost(ceiling) - (listing.shipping || 0)
            })
            continue
        }

        /*
            Best Offer, within reach.

            BIN_BELOW_CLEARING asks whether the ask is already under the
            ceiling. For a negotiable lot that is the wrong question: the
            whole point of the Best Offer button is that the ask sits ABOVE
            what you would pay, and you offer less. Measured over the live
            corpus, a Best Offer lot asks a median 33.0pp over clearing
            against 31.8pp for a rigid one - the button signals willingness
            to haggle, not a keener price, so a rule that waits for the ask
            to fall below the ceiling will simply never fire on one.

            The cap matters as much as the rule. An offer a quarter under the
            ask is already optimistic; beyond that the alert is noise, and
            noise in this panel is what UI-01 was written to undo.
        */
        if (!String(listing.buyingOptions).includes('BEST_OFFER')) { continue }

        const gap = (total - ceiling) / ceiling
        if (gap > config.maxOfferGap) { continue }

        const suggestedOffer = BUYER.priceForCost(ceiling) - (listing.shipping || 0)
        /*  If the ceiling is at or above what they are already asking, this
            is not a negotiation - either it cleared the edge test above, or
            the margin is too thin to be worth an offer. Suggesting a number
            above the ask would be nonsense in either case. */
        if (!(suggestedOffer > 0) || suggestedOffer >= listing.price) { continue }

        alerts.push({
            rule: 'BEST_OFFER_IN_REACH',
            browseId: listing.browseId,
            title: listing.title,
            url: listing.itemWebUrl,
            imageUrl: listing.imageUrl,
            legacyId: listing.legacyId,
            currentTotal: total,
            bidCeiling: ceiling,
            gap,
            askPrice: listing.price,
            shipping: listing.shipping,
            buyingOptions: listing.buyingOptions,
            askPremium: listing.askPremium,
            suggestedOffer,
            discount: 1 - (suggestedOffer / listing.price),
            daysToSale: listing.medianDaysToSale === undefined ? null : listing.medianDaysToSale
        })
    }

    return alerts.sort(byPromise)
}

/*  A lot already below clearing beats one you have to negotiate for, so the
    edge alerts rank first; within the offers, the smallest gap is the
    likeliest to be accepted. An offer alert has no edge, so comparing on it
    directly yields NaN and leaves the order to chance. */
function byPromise (a, b) {
    const ae = Number.isFinite(a.edge) ? a.edge : -Infinity
    const be = Number.isFinite(b.edge) ? b.edge : -Infinity
    if (ae !== be) { return be - ae }
    return (a.gap === undefined ? 0 : a.gap) - (b.gap === undefined ? 0 : b.gap)
}

exports.format = function (alert, instrumentName) {
    const pct = (value) => (value * 100).toFixed(1) + '%'
    const gbp = (value) => 'GBP ' + value.toFixed(2)

    if (alert.rule === 'AUCTION_PROJECTED_BELOW_CEILING') {
        return [
            instrumentName + ' - auction ending in ' + alert.minutesLeft + ' min',
            alert.title,
            'At ' + gbp(alert.currentTotal) + ', projected to finish ' + gbp(alert.projectedFinal) +
                ' (' + gbp(alert.projectedRange[0]) + '-' + gbp(alert.projectedRange[1]) + ')',
            'Your ceiling ' + gbp(alert.bidCeiling) + ' -> edge ' + pct(alert.edge),
            'Max bid ' + gbp(alert.maxBid) + '  [curve from ' + alert.basedOn + ' samples]',
            alert.url
        ].join('\n')
    }

    if (alert.rule === 'BEST_OFFER_IN_REACH') {
        return [
            instrumentName + ' - Best Offer within reach',
            alert.title,
            'Asking ' + gbp(alert.currentTotal) + ' all-in, ' + pct(alert.gap) +
                ' over your ceiling of ' + gbp(alert.bidCeiling),
            'Offer ' + gbp(alert.suggestedOffer) + ' - ' + pct(alert.discount) + ' under the ask',
            alert.url
        ].join('\n')
    }

    return [
        instrumentName + ' - listed below clearing',
        alert.title,
        gbp(alert.currentTotal) + ' all-in vs ceiling ' + gbp(alert.bidCeiling) + ' -> edge ' + pct(alert.edge),
        'Suggested offer ' + gbp(alert.suggestedOffer),
        alert.url
    ].join('\n')
}

/*
    A listing belongs to an instrument at every level of the hierarchy, so
    a naive sweep alerts on the same coin once per level - three or four
    notifications for one lot. Keep only the most specific instrument that
    had enough data to form an opinion: that is the estimate built from the
    most comparable coins, and it is the one worth acting on.
*/
exports.dedupeByListing = function (entries) {
    const best = new Map()
    for (const entry of entries) {
        const existing = best.get(entry.alert.browseId)
        if (existing === undefined || entry.level > existing.level) { best.set(entry.alert.browseId, entry) }
    }
    return Array.from(best.values()).sort((a, b) => byPromise(a.alert, b.alert))
}
