'use strict'

const PREMIUM = require('./premium.js')
const FAIRVALUE = require('./fairvalue.js')
const LIQUIDITY = require('./liquidity.js')
const UPLIFT = require('./uplift.js')
const CHANNELS = require('./channels.js')
const SERIES = require('../catalogue/series/index.js')

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

    /*  The last sweep's clock, read once per view rather than per instrument:
        a view is built per request, so this is as current as the page is. */
    let sweepAt
    function lastSweepAt () {
        if (sweepAt === undefined) {
            sweepAt = repository.lastSweepAt ? repository.lastSweepAt() : null
        }
        return sweepAt
    }

    /* Attaches a premium to an outcome, or null when spot is unknown for
       that moment. Null premiums are counted, not silently dropped. */
    function withPremium (row, priceField, whenField) {
        /*  row.metal comes from the instrument, which gets it from the
            series. A silver coin measured against gold is not a small error. */
        const spot = spotAt(row[whenField], row.metal)
        if (spot === null) { return { premium: null, spotMissing: true } }
        const total = PREMIUM.totalCost(row[priceField], row.shipping)
        return {
            premium: PREMIUM.premium(total, row.fineOz, spot.gbpPerOz),
            spotGbpPerOz: spot.gbpPerOz,
            spotMissing: false
        }
    }

    /*  One curve, kept until its inputs change. Per view instance, which is
        per process - there is one dashboard. */
    let curveMemo = null

    /*  Markets, kept until something they are computed from changes.

        Keyed on the watermark AND on the minute, because these are not a pure
        function of the store: activeListings admits a lot only while
        end_time is still in the future, so an auction ending drops out with
        the clock rather than with a write. A minute bounds how long a lot can
        look live after it has ended, against an hourly sweep behind it.

        The stamp is taken ONCE per batch and handed down. Taking it per
        instrument would cost 80 x 37ms and lose more than the memo saves,
        which is the whole reason marketsFor exists rather than a cache
        hidden inside forInstrument. */
    let marketMemo = { stamp: null, byKey: new Map() }
    let compositionMemo = { stamp: null, byId: new Map() }

    /*  The stamp, read fresh on every question.

        The watermark costs 37ms and a page asks four of these - two series of
        markets, two of composition - so 148ms goes on deciding whether to
        spend about 2.7s. Worth it, and the alternative was measured and
        rejected.

        CACHING THE STAMP FOR ONE TURN OF THE EVENT LOOP WAS TRIED. It is
        correct in production, where a verdict POSTs and the redirect is a new
        request and so a new tick - and it broke all four invalidation tests
        at once, because a test writes and reads back inside a single turn.
        That is not a test artefact worth working around: it is the shape of
        the bug that cache would cause the first time anything wrote and
        re-rendered without going round the network, and a decision written
        into the store but not shown to the reader is the failure this whole
        memo is not allowed to have. 148ms is the price of it never being
        possible. */

    return {
        /*  Several coin types at once, computed once per change.

            forInstrument is left uncached: it is called by the CLI and the
            report builder, one key at a time in a fresh process, where a memo
            would only add a watermark query to a single use. This is for the
            caller that asks for eighty in a row.
        */
        marketsFor (keys, now) {
            const asOf = now === undefined ? Date.now() : new Date(now).getTime()
            const stamp = repository.marketWatermark() + '|' + Math.floor(asOf / 60000)
            if (marketMemo.stamp !== stamp) { marketMemo = { stamp, byKey: new Map() } }

            const out = new Map()
            for (const key of keys) {
                if (!marketMemo.byKey.has(key)) {
                    marketMemo.byKey.set(key, this.forInstrument(key, now))
                }
                out.set(key, marketMemo.byKey.get(key))
            }
            return out
        },

        /*  What one series' market is made of, cached like the markets are.

            Six COUNTs over 29,672 listings, each with a correlated EXISTS, run
            once per series: 517ms of an 1,100ms render once everything else
            was fixed. It is derived from the same tables under the same
            watermark, so it invalidates on exactly the same events - and it
            carries the minute for the same reason marketsFor does, since two
            of the six count what is live and that changes as auctions end.
        */
        compositionFor (seriesId, now) {
            const asOf = now === undefined ? Date.now() : new Date(now).getTime()
            const stamp = repository.marketWatermark() + '|' + Math.floor(asOf / 60000)
            if (compositionMemo.stamp !== stamp) { compositionMemo = { stamp, byId: new Map() } }

            const id = seriesId === undefined || seriesId === null ? '' : String(seriesId)
            if (!compositionMemo.byId.has(id)) {
                compositionMemo.byId.set(id, repository.marketComposition(seriesId))
            }
            return compositionMemo.byId.get(id)
        },

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
                const spot = spotAt(new Date(asOf).toISOString(), row.metal)
                const total = PREMIUM.totalCost(row.price, row.shipping)
                return {
                    browseId: row.browseId,
                    /*  The id every human decision is keyed on. activeListings
                        has always selected it and this mapping has always
                        dropped it, so an alert could name a listing but not
                        offer a way to judge it. */
                    legacyId: row.legacyId,
                    lastSeen: row.lastSeen,
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
            const observationsIn = (saleType) => outcomes
                .filter(o => o.sold && o.saleType === saleType)
                .map(o => ({ premium: o.clearingPremium, soldAt: o.endedAt, censored: o.censored }))

            const fairOptions = {
                now: asOf, halfLifeDays: config.halfLifeDays, windowDays: config.windowDays
            }
            const fair = FAIRVALUE.fairValue(observationsIn('AUCTION'), fairOptions)

            /*
                And the other channels, kept apart rather than discarded.

                Not mixing them was right; implementing that by filtering them
                out of every statistic was not. A Buy-It-Now sale was resolved,
                stored, rendered - and then fed nothing, so the question "what
                does a coin fetch on a Buy-It-Now" had no answer anywhere in
                the tool despite the data sitting in the table.

                The offers-allowed channel is computed WITH its censored rows,
                because there its ceiling is the whole point: eBay will not say
                whether an offer was taken, so every one of those prices is an
                upper bound and the result is marked as one. `fair` above is
                untouched - the bid ceiling still rests on auctions alone.
            */
            const fairByChannel = {
                AUCTION: fair,
                FIXED_PRICE: FAIRVALUE.fairValue(observationsIn('FIXED_PRICE'), fairOptions),
                BEST_OFFER: FAIRVALUE.fairValue(observationsIn('BEST_OFFER'),
                    Object.assign({ includeCensored: true }, fairOptions))
            }

            const premiums = CHANNELS.premiumsByChannel(outcomes, {
                now: asOf, windowDays: config.liquidityWindowDays
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
            /*  One metal for the whole instrument, read from the store
                rather than from whichever listing sorted first - the same
                lesson as fineOz (MKT-13). */
            const metal = SERIES.metalForKey(key)
            const spotNow = spotAt(new Date(asOf).toISOString(), metal)

            const ceiling = (fair.sufficient && fineOz !== null && spotNow !== null)
                ? FAIRVALUE.bidCeiling(fair, {
                    fineOz, spotGbpPerOz: spotNow.gbpPerOz, shipping: 0,
                    targetQuantile: config.targetQuantile
                })
                : null

            return {
                key,
                metal,
                /*  Carried on the view so a consumer cannot forget to ask for
                    it - the freshness guard is only as good as its anchor. */
                sweepAt: lastSweepAt(),
                fineOz,
                spot: spotNow,
                spotGaps,
                fairValue: fair,
                /*  The same question asked per sale channel, so a Buy-It-Now
                    premium and an auction premium can be read side by side and
                    never averaged together. */
                fairByChannel,
                premiums,
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
        /*  MEMOISED ON ITS OWN INPUTS, not on a clock.

            This reads a year of sold auctions - 201,616 snapshot rows for 461
            auctions on the live store - to produce about ten numbers, and it
            cost 2.1s of a 6.4s page. It is also the same answer on two page
            loads a second apart: the curve can only move when the collector
            resolves another outcome.

            So the key is the outcome population itself rather than a TTL. A
            time-based cache would be wrong in both directions at once - still
            stale the moment a sweep lands, still recomputing when nothing has
            changed - whereas this recomputes exactly when there is something
            new to learn from and never otherwise.

            `since` is part of the key to the day. The window is the last 365
            days, so it does move at midnight; keeping the full timestamp in
            the key would mean every request missed, which is the same as no
            cache at all.
        */
        upliftCurve (now) {
            const asOf = now === undefined ? Date.now() : new Date(now).getTime()
            const since = new Date(asOf - 365 * DAY_MS).toISOString()

            const mark = repository.outcomeWatermark()
            const key = since.slice(0, 10) + '|' + mark.n + '|' + mark.newest
            if (curveMemo !== null && curveMemo.key === key) { return curveMemo.curve }

            const curve = UPLIFT.buildCurve(repository.upliftSamples(since))
            curveMemo = { key, curve }
            return curve
        },

        config
    }
}
