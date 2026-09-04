'use strict'

const TRADING = require('../ebay/trading.js')

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
            const report = {
                attempted: 0, resolved: 0, gone: 0, failed: 0, censored: 0,
                stillLive: 0, budgetStopped: false,
                /*  What the offer-record question bought us, so its value and
                    its error rate are both readable in the journal rather
                    than assumed. */
                pricedByOffers: 0, acceptedOffer: 0, offerUnknown: 0
            }

            for (const row of pending) {
                let item = null
                try {
                    item = await tradingClient.getItem(row.legacyId)
                } catch (err) {
                    if (err.code === 'BUDGET_EXHAUSTED') {
                        /*  Stop, rather than walking the rest of the queue
                            collecting the same refusal sixty times. The queue
                            is ordered by deadline, so what is left is exactly
                            what should be tried first next cycle. */
                        report.budgetStopped = true
                        break
                    }
                    report.attempted++
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
                    continue
                }

                report.attempted++

                /*
                    A listing eBay still calls Active has not ended, whatever
                    made us ask about it, and recording an outcome for it
                    would be a fabrication: it would enter the clearing
                    statistics as an unsold lot and vanish from the live
                    market on the same write.

                    This is what makes the quiet Buy-It-Now trigger safe to
                    tune. That trigger guesses that a lot which has not been
                    seen for three days has ended, and it will sometimes be
                    wrong - a lot can drop out of search results and come
                    back. Because of this check, being wrong costs one
                    Trading call and the lot is simply offered again later;
                    without it, every wrong guess would quietly become a
                    false negative in the sell-through figures.

                    Ended auctions pass through here untouched: an auction
                    whose end time has passed is never Active.
                */
                if (item.listingStatus === 'Active') {
                    report.stillLive++
                    /*  Remember the answer. Being alive leaves no other
                        trace - no outcome is written - so without this the
                        lot stays quiet and is asked again every cycle. */
                    if (typeof repository.markAliveNow === 'function') {
                        repository.markAliveNow(row.browseId)
                    }
                    continue
                }

                /*
                    ONE MORE QUESTION, ONLY WHERE IT CAN CHANGE THE ANSWER.

                    A sold fixed-price lot whose seller allowed offers is
                    stamped censored by parseItem, because eBay reports only
                    that offers were ALLOWED and never whether one was taken.
                    That is true as far as GetItem goes, and it throws away
                    every such lot that simply sold at its asking price -
                    roughly a quarter to a third of them, on a channel
                    holding 45% of the Buy-It-Now market.

                    GetBestOffers answers it. The lot's offer records carry a
                    status each, and an Accepted among them is the whole
                    distinction: measured on three lots of known outcome it
                    was right three times out of three, where BestOfferCount
                    and a price comparison were both blind.

                    Asked only when the answer could move: a sold lot that
                    parseItem censored. An auction never reaches here (offer
                    records under-report on those), nor does an unsold lot,
                    nor a plain Buy-It-Now that was already exact. That is
                    about nine extra Trading calls a day in this store.

                    A failure leaves the row exactly as parseItem stamped it.
                    The call is a chance to REMOVE a censor mark, never to
                    add doubt, so nothing about the existing behaviour depends
                    on it succeeding.
                */
                let censored = item.censored
                if (item.censored && typeof tradingClient.getBestOffers === 'function') {
                    try {
                        const verdict = TRADING.soldAtAsk(item,
                            await tradingClient.getBestOffers(row.legacyId))
                        if (verdict === true) {
                            censored = false
                            report.pricedByOffers++
                        } else if (verdict === false) {
                            report.acceptedOffer++
                        } else {
                            report.offerUnknown++
                        }
                    } catch (err) {
                        /*  Including an exhausted budget: the outcome still
                            gets written, just with its ceiling intact. */
                        report.offerUnknown++
                    }
                }

                repository.saveOutcome(row.browseId, {
                    endTime: item.endTime || row.endTime,
                    sold: item.sold,
                    finalPrice: item.finalPrice,
                    bidCount: item.bidCount,
                    saleType: item.saleType,
                    censored,
                    source: 'trading_getitem'
                })
                if (censored) { report.censored++ }
                if (item.aspects && Object.keys(item.aspects).length > 0) {
                    repository.saveAspects(row.browseId, item.aspects)
                }
                report.resolved++
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
