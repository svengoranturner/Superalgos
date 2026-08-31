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
                    /*  The id every human decision is keyed on. activeListings
                        has always selected it and this mapping has always
                        dropped it, so an alert could name a listing but not
                        offer a way to judge it. */
                    legacyId: row.legacyId,
                    title: row.title,
                    buyingOptions: row.buyingOptions,
                    endTime: row.endTime,
                    price: row.price,
                    shipping: row.shipping,
                    bidCount: row.bidCount,
                    itemWebUrl: row.itemWebUrl,
                    /*  The picture, so any page that lists a lot can show
                        one. The owner's words: the thumbnails are as
                        instructive as the titles, if not more so - a
                        gold-coloured souvenir looks like a souvenir long
                        before its title admits to it. */
                    imageUrl: row.imageUrl,
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

            /*
                The spread is Asks minus Clears at, and must use the SAME
                clearing figure the dashboard prints.

                liquidity.js computes its own plain median over sold auctions
                with no minimum sample, while the clearing column shows the
                decay-weighted p50 which needs three. So a coin type could -
                and did - display "Clears at: —" beside "Spread: 40.3%": a
                spread against a number the page had just declined to show,
                off a single sale. Two medians for one quantity is one too
                many.
            */
            liquidity.askClearingSpread = (fair.sufficient && liquidity.medianAskPremium !== null)
                ? liquidity.medianAskPremium - fair.p50
                : null

            /*
                One coin's gold, from the instrument row.

                This used to be active[0].fineOz - whichever listing sorted
                first. But a listing's fineOz is its LOT's gold: fine_oz
                multiplied by quantity, which is exactly what CLS-07 built.
                So a nine-coin set arriving at the front of its key
                multiplied that key's bid ceiling by nine, and every alert
                under it with it. Measured 2026-08-31: no key was poisoned
                that day, but a nine-coin half-sovereign lot was due at the
                front of GB.SOV.UNATTRIBUTED.HALF on 03 Sep and a four-coin
                lot at the front of GB.SOV.UNATTRIBUTED.FULL on 04 Sep.

                CLS-07 kept lot size off the shared instrument row for this
                exact reason; the read path had to learn the same lesson.
            */
            const fineOz = repository.instrumentFineOz(key)
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
