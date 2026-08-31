'use strict'

const UPLIFT = require('../analytics/uplift.js')
const PREMIUM = require('../analytics/premium.js')

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

    const config = Object.assign({ minEdge: 0.03, endingWithinMinutes: 120 }, options || {})
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
                maxBid: ceiling - (listing.shipping || 0),
                edge,
                minutesLeft: Math.round(secondsToEnd / 60),
                basedOn: projection.basedOn
            })
            continue
        }

        /* Fixed price / Best Offer: no uplift to model, so compare directly. */
        const edge = (ceiling - total) / ceiling
        if (edge < config.minEdge) { continue }

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
            suggestedOffer: ceiling - (listing.shipping || 0)
        })
    }

    return alerts.sort((a, b) => b.edge - a.edge)
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
    return Array.from(best.values()).sort((a, b) => b.alert.edge - a.alert.edge)
}
