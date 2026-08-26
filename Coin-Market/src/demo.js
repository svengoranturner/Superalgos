'use strict'

const { classify } = require('./catalogue/classify.js')
const INSTRUMENTS = require('./catalogue/instruments.js')
const COINS = require('./catalogue/coins.js')

/*
    Synthetic market generator.

    Exists so the tool can be exercised end to end - classification,
    premium, fair value, liquidity, uplift curve, alerts, dashboard -
    before any eBay credentials exist, and so the test suite has a
    realistic fixture that does not depend on the network.

    The synthetic market deliberately reproduces the phenomenon that
    motivated the tool: Buy-It-Now sellers ask far above where auctions
    actually clear, and most of those BIN listings never sell.
*/

const DAY_MS = 24 * 60 * 60 * 1000

/* Deterministic PRNG so demo runs and tests are reproducible. */
function newRandom (seed) {
    let state = seed >>> 0
    return function random () {
        state = (state * 1664525 + 1013904223) >>> 0
        return state / 4294967296
    }
}

const TYPES = [
    { title: '1974 Gold Full Sovereign Elizabeth II',                     clearing: 0.055, share: 0.30 },
    { title: '1982 Gold Full Sovereign Elizabeth II',                     clearing: 0.058, share: 0.15 },
    { title: 'Gold Sovereign 1912 George V',                              clearing: 0.075, share: 0.20 },
    { title: '1900 Victoria Old Head Gold Sovereign London',              clearing: 0.105, share: 0.12 },
    { title: '1966 Gold Full Sovereign Elizabeth II',                     clearing: 0.060, share: 0.13 },
    { title: 'Half Sovereign 1982 Gold Coin Elizabeth II',                clearing: 0.095, share: 0.10 }
]

/* Noise that a real listing scrape would contain, and that the classifier
   must reject rather than price. */
const NOISE = [
    '9ct Gold Sovereign Mount Pendant Chain',
    'Gold Sovereign Coin Case Holder Empty Display Box',
    'COPY 1817 Gold Sovereign Replica Not Gold',
    '5 x Gold Sovereigns Job Lot Mixed Dates',
    'Brass Sovereign Token Medal'
]

exports.generate = function (db, options) {

    const config = Object.assign({
        days: 120, seed: 20260826, spotStart: 1950, endingSoonLots: 6, now: Date.now()
    }, options || {})

    const random = newRandom(config.seed)
    const now = config.now
    const start = now - config.days * DAY_MS

    /* ---- spot: a 20-minute feed, as the Pi would have recorded it ---- */
    const insertSpot = db.prepare(
        'INSERT OR IGNORE INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)'
    )
    let spot = config.spotStart
    const spotSeries = []
    db.exec('BEGIN')
    for (let t = start; t <= now + DAY_MS; t += 20 * 60 * 1000) {
        spot = spot * (1 + (random() - 0.5) * 0.0035)
        spotSeries.push({ t, spot })
        insertSpot.run(new Date(t).toISOString(), 'XAU', spot, spot * 1.27, 'metals.dev (demo)')
    }
    db.exec('COMMIT')

    const spotAt = (t) => {
        const index = Math.max(0, Math.min(spotSeries.length - 1,
            Math.round((t - start) / (20 * 60 * 1000))))
        return spotSeries[index].spot
    }

    /* ---- listings ---- */
    const repository = require('./store/repo.js').newRepository(db, { sellerSalt: 'demo' })
    const counts = { auctions: 0, bins: 0, noise: 0, live: 0 }
    let sequence = 0

    function pickType () {
        const roll = random()
        let cumulative = 0
        for (const type of TYPES) {
            cumulative += type.share
            if (roll <= cumulative) { return type }
        }
        return TYPES[0]
    }

    function store (item, seenAt) {
        repository.saveListing(item, seenAt)
        const result = classify({ title: item.title })
        if (result.excluded !== null) {
            repository.queueForReview(item.browseId, 'EXCLUDED: ' + result.excluded.reason, null, 0)
            return false
        }
        const keys = INSTRUMENTS.keysFor(result.attributes)
        if (keys.length > 0) {
            repository.saveClassification(item.browseId, keys, result.confidence, 'title',
                INSTRUMENTS.fineOzFor(result.attributes), result.attributes)
        }
        if (result.needsReview) {
            repository.queueForReview(item.browseId, result.reasons.join('; '), null, result.confidence)
        }
        return true
    }

    function newItem (title, buyingOptions, endTime, price, startTime) {
        sequence++
        return {
            browseId: 'v1|demo' + sequence + '|0',
            legacyId: 'demo' + sequence,
            title,
            categoryId: '3408',
            buyingOptions,
            currency: 'GBP',
            price,
            shipping: 4.95,
            endTime: new Date(endTime).toISOString(),
            startTime: new Date(startTime).toISOString(),
            itemWebUrl: 'https://www.ebay.co.uk/itm/demo' + sequence,
            sellerId: 'seller' + Math.floor(random() * 40)
        }
    }

    db.exec('BEGIN')

    /* Completed auctions: these establish where the market clears. */
    for (let day = 0; day < config.days; day++) {
        const perDay = 2 + Math.floor(random() * 3)
        for (let k = 0; k < perDay; k++) {
            const type = pickType()
            const fineOz = /half/i.test(type.title)
                ? COINS.DENOMINATIONS.HALF.fineOz : COINS.DENOMINATIONS.FULL.fineOz

            const endTime = start + day * DAY_MS + random() * DAY_MS
            const startTime = endTime - 7 * DAY_MS
            const premium = type.clearing + (random() - 0.5) * 0.05
            const finalPrice = fineOz * spotAt(endTime) * (1 + premium) - 4.95

            const item = newItem(type.title, 'AUCTION', endTime, finalPrice, startTime)
            store(item, new Date(startTime).toISOString())

            /* Snapshots on the way to close, with the late surge that makes
               the uplift curve necessary. */
            for (const secondsToEnd of [259200, 86400, 21600, 3600, 900, 300, 60, 5]) {
                const observedAt = endTime - secondsToEnd * 1000
                if (observedAt < startTime) { continue }
                const progress = Math.pow(1 - Math.min(1, secondsToEnd / 604800), 2.2)
                const fraction = 0.35 + 0.65 * progress
                repository.saveSnapshot(item.browseId, {
                    observedAt: new Date(observedAt).toISOString(),
                    endTime: item.endTime,
                    currentBidPrice: finalPrice * fraction * (0.98 + random() * 0.04),
                    shipping: 4.95,
                    bidCount: Math.round(2 + progress * 18)
                })
            }

            repository.saveOutcome(item.browseId, {
                endTime: item.endTime, sold: true, finalPrice, shipping: 4.95,
                bidCount: 8 + Math.floor(random() * 20), saleType: 'AUCTION',
                censored: false, source: 'trading_getitem'
            })
            counts.auctions++
        }
    }

    /*
        Buy-It-Now listings: asked far above clearing, and mostly unsold.
        This is the gap the tool exists to quantify.
    */
    for (let day = 0; day < config.days; day++) {
        if (random() > 0.7) { continue }
        const type = pickType()
        const fineOz = /half/i.test(type.title)
            ? COINS.DENOMINATIONS.HALF.fineOz : COINS.DENOMINATIONS.FULL.fineOz

        const endTime = start + day * DAY_MS + random() * DAY_MS
        const startTime = endTime - 30 * DAY_MS
        const askPremium = type.clearing + 0.13 + random() * 0.08
        const price = fineOz * spotAt(endTime) * (1 + askPremium) - 4.95

        const item = newItem(type.title, 'FIXED_PRICE,BEST_OFFER', endTime, price, startTime)
        store(item, new Date(startTime).toISOString())

        const sold = random() < 0.25
        repository.saveOutcome(item.browseId, {
            endTime: item.endTime, sold, finalPrice: price, shipping: 4.95, bidCount: null,
            saleType: 'BEST_OFFER',
            /* Accepted offers are censored: eBay never says what was paid. */
            censored: sold, source: 'trading_getitem'
        })
        counts.bins++
    }

    /* Live lots, including some ending shortly, so alerts have something
       to consider. */
    for (let i = 0; i < 25; i++) {
        const type = pickType()
        const fineOz = /half/i.test(type.title)
            ? COINS.DENOMINATIONS.HALF.fineOz : COINS.DENOMINATIONS.FULL.fineOz
        const auction = i < config.endingSoonLots + 8
        const endTime = auction
            ? now + (i < config.endingSoonLots ? (10 + i * 12) * 60000 : (1 + random() * 5) * DAY_MS)
            : now + (5 + random() * 20) * DAY_MS

        const premium = auction
            ? type.clearing - 0.06 + random() * 0.03      /* mid-auction, still low */
            : type.clearing + 0.13 + random() * 0.08      /* BIN ask */
        const price = fineOz * spotAt(now) * (1 + premium) - 4.95

        const item = newItem(type.title, auction ? 'AUCTION' : 'FIXED_PRICE,BEST_OFFER',
            endTime, price, now - 5 * DAY_MS)
        store(item, new Date(now).toISOString())
        repository.saveSnapshot(item.browseId, {
            observedAt: new Date(now).toISOString(),
            endTime: item.endTime,
            currentBidPrice: auction ? price : undefined,
            price,
            shipping: 4.95,
            bidCount: auction ? 3 + Math.floor(random() * 8) : null
        })
        counts.live++
    }

    /* Noise the classifier must reject. */
    for (let i = 0; i < 40; i++) {
        const title = NOISE[Math.floor(random() * NOISE.length)]
        const item = newItem(title, 'FIXED_PRICE', now + 7 * DAY_MS, 120 + random() * 300, now - DAY_MS)
        if (!store(item, new Date(now).toISOString())) { counts.noise++ }
    }

    db.exec('COMMIT')

    return counts
}
