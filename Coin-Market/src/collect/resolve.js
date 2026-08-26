'use strict'

/*
    Outcome resolution.

    The whole design turns on a deadline: Trading GetItem returns an ended
    listing's final price for 90 days after it closes, and nothing returns
    it afterwards. An unresolved lot is not a gap that can be backfilled
    later - it is a permanent hole in the price history.

    So resolution runs oldest-first, retries, and is given budget priority
    second only to discovery.
*/

exports.newResolver = function (tradingClient, repository) {

    return {
        async resolvePending (limit) {
            const pending = repository.pendingOutcomes(limit || 60)
            const report = { attempted: 0, resolved: 0, gone: 0, failed: 0, censored: 0 }

            for (const row of pending) {
                report.attempted++
                try {
                    const item = await tradingClient.getItem(row.legacyId)
                    repository.saveOutcome(row.browseId, {
                        endTime: item.endTime || row.endTime,
                        sold: item.sold,
                        finalPrice: item.finalPrice,
                        bidCount: item.bidCount,
                        saleType: item.saleType,
                        censored: item.censored,
                        source: 'trading_getitem'
                    })
                    if (item.censored) { report.censored++ }
                    if (item.aspects && Object.keys(item.aspects).length > 0) {
                        repository.saveAspects(row.browseId, item.aspects)
                    }
                    report.resolved++
                } catch (err) {
                    if (err.code === 'ITEM_GONE') {
                        /*
                            Past the 90-day window, or withdrawn. Fall back to
                            the last thing we observed ourselves. Less exact
                            than a hammer price - and marked as such, so the
                            analytics can weigh it accordingly - but far better
                            than discarding the lot.
                        */
                        const fallback = exports.fromLastSnapshot(repository, row.browseId)
                        if (fallback !== null) {
                            repository.saveOutcome(row.browseId, fallback)
                            report.resolved++
                        } else {
                            report.gone++
                        }
                    } else {
                        report.failed++
                    }
                }
            }
            return report
        }
    }
}

/*
    Reconstructs an outcome from our own snapshots when eBay will no longer
    tell us.

    The last price seen before close is a LOWER bound on the hammer, never
    an upper one, so this is recorded as censored rather than as a
    confirmed sale. Guessing "sold" here would inflate sell-through, which
    is one of the headline liquidity numbers - better to admit the lot's
    fate is unknown than to publish a flattering figure.
*/
exports.fromLastSnapshot = function (repository, browseId) {
    const row = repository.lastSnapshot(browseId)
    if (row === null) { return null }

    return {
        endTime: row.endTime || row.observedAt,
        sold: false,
        finalPrice: row.price,
        shipping: row.shipping,
        bidCount: row.bidCount,
        saleType: String(row.buyingOptions || '').includes('AUCTION') ? 'AUCTION' : 'FIXED_PRICE',
        censored: true,
        source: 'last_snapshot'
    }
}
