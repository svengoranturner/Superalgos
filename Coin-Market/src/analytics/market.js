'use strict'

const PREMIUM = require('./premium.js')
const FAIRVALUE = require('./fairvalue.js')
const LIQUIDITY = require('./liquidity.js')
const UPLIFT = require('./uplift.js')

const DAY_MS = 24 * 60 * 60 * 1000

/*
    The read model: everything the dashboard, alerts and report need for
    one instrument, assembled in one place so all three agree.

    Premiums are computed at READ time, not write time, against the spot
    price at the moment each lot closed. That is deliberate - the spot
    mirror may catch up after an auction ends, and computing premiums
    eagerly would freeze in whatever gold price happened to be known then.
*/

exports.newMarketView = function (repository, spotAt, options) {

    const config = Object.assign({
        windowDays: 180,
        liquidityWindowDays: 90,
        targetQuantile: 0.35,
        halfLifeDays: 45
    }, options || {})

    /* Attaches a premium to an outcome, or null when spot is unknown for
       that moment. Null premiums are counted, not silently dropped. */
    function withPremium (row, priceField, whenField) {
        const spot = spotAt(row[whenField])
        if (spot === null) { return { premium: null, spotMissing: true } }
        const total = PREMIUM.totalCost(row[priceField], row.shipping)
        return {
            premium: PREMIUM.premium(total, row.fineOz, spot.gbpPerOz),
            spotGbpPerOz: spot.gbpPerOz,
            spotMissing: false
        }
    }

    return {
        forInstrument (key, now) {
            const asOf = now === undefined ? Date.now() : new Date(now).getTime()
            const since = new Date(asOf - config.windowDays * DAY_MS).toISOString()

            const rawOutcomes = repository.clearingObservations(key, since)
            let spotGaps = 0

            const outcomes = rawOutcomes.map(row => {
                const priced = withPremium(row, 'finalPrice', 'endedAt')
                if (priced.spotMissing) { spotGaps++ }
                return {
                    browseId: row.browseId,
                    endedAt: row.endedAt,
                    listedAt: row.listedAt,
                    sold: row.sold === 1 || row.sold === true,
                    clearingPremium: priced.premium,
                    bidCount: row.bidCount,
                    saleType: row.saleType,
                    censored: row.censored === 1,
                    sellerHash: row.sellerHash,
                    sellerIdHash: row.sellerIdHash,
                    certNumber: row.certNumber,
                    title: row.title
                }
            })

            const active = repository.activeListings(key).map(row => {
                /* Live listings are priced against spot NOW. */
                const spot = spotAt(new Date(asOf).toISOString())
                const total = PREMIUM.totalCost(row.price, row.shipping)
                return {
                    browseId: row.browseId,
                    title: row.title,
                    buyingOptions: row.buyingOptions,
                    endTime: row.endTime,
                    price: row.price,
                    shipping: row.shipping,
                    bidCount: row.bidCount,
                    itemWebUrl: row.itemWebUrl,
                    fineOz: row.fineOz,
                    askPremium: spot === null ? null : PREMIUM.premium(total, row.fineOz, spot.gbpPerOz)
                }
            })

            /* Fair value is built from sold AUCTIONS only. A Buy-It-Now
               sale says what one buyer would pay on demand; an auction
               says where the market clears. Mixing them inflates the
               estimate, which is the very error the tool exists to fix. */
            const clearingObservations = outcomes
                .filter(o => o.sold && o.saleType === 'AUCTION')
                .map(o => ({ premium: o.clearingPremium, soldAt: o.endedAt, censored: o.censored }))

            const fair = FAIRVALUE.fairValue(clearingObservations, {
                now: asOf, halfLifeDays: config.halfLifeDays, windowDays: config.windowDays
            })

            const liquidity = LIQUIDITY.metrics(
                active.map(a => ({ buyingOptions: a.buyingOptions, askPremium: a.askPremium })),
                outcomes,
                { windowDays: config.liquidityWindowDays, now: asOf }
            )

            const fineOz = active.length > 0 ? active[0].fineOz
                : (rawOutcomes.length > 0 ? rawOutcomes[0].fineOz : null)
            const spotNow = spotAt(new Date(asOf).toISOString())

            const ceiling = (fair.sufficient && fineOz !== null && spotNow !== null)
                ? FAIRVALUE.bidCeiling(fair, {
                    fineOz, spotGbpPerOz: spotNow.gbpPerOz, shipping: 0,
                    targetQuantile: config.targetQuantile
                })
                : null

            return {
                key,
                fineOz,
                spot: spotNow,
                spotGaps,
                fairValue: fair,
                liquidity,
                bidCeiling: ceiling,
                active,
                outcomes
            }
        },

        /* The uplift curve is global rather than per-instrument: sniping
           behaviour is a property of eBay's auction format, not of any
           one coin, and pooling gives it enough samples to be useful in
           weeks rather than years. */
        upliftCurve (now) {
            const asOf = now === undefined ? Date.now() : new Date(now).getTime()
            const since = new Date(asOf - 365 * DAY_MS).toISOString()
            return UPLIFT.buildCurve(repository.upliftSamples(since))
        },

        config
    }
}
