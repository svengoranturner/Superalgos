#!/usr/bin/env node
'use strict'

const PATH = require('node:path')
const FS = require('node:fs')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const SPOT = require('../src/spot/spot.js')
const MARKET = require('../src/analytics/market.js')
const INSTRUMENTS = require('../src/catalogue/instruments.js')
const ALERT_RULES = require('../src/alerts/rules.js')
const CONFIG = require('../src/config.js')

const COMMANDS = {}

function pct (value, digits) {
    if (value === null || value === undefined || !Number.isFinite(value)) { return '   -  ' }
    return (value * 100).toFixed(digits === undefined ? 1 : digits) + '%'
}
function gbp (value) {
    if (value === null || value === undefined || !Number.isFinite(value)) { return '-' }
    return 'GBP ' + value.toFixed(2)
}

/* ------------------------------------------------------------- demo */

COMMANDS.demo = {
    describe: 'Build a synthetic market and show the analysis (no eBay account needed)',
    async run (args) {
        const target = args[0] || PATH.join(CONFIG.ROOT, 'demo.db')
        if (FS.existsSync(target)) { FS.unlinkSync(target) }

        const db = newDatabase(target)
        const counts = require('../src/demo.js').generate(db)

        console.log('Synthetic market built at ' + target)
        console.log('  completed auctions : ' + counts.auctions)
        console.log('  buy-it-now listings: ' + counts.bins)
        console.log('  live lots          : ' + counts.live)
        console.log('  junk listings the classifier rejected: ' + counts.noise)
        console.log('')
        await COMMANDS.report.run([target])
    }
}

/* ----------------------------------------------------------- report */

COMMANDS.report = {
    describe: 'Print the market summary for every tracked coin type',
    async run (args) {
        const { db, view, repository } = open(args[0])

        const instruments = repository.instruments(0, 2).filter(i => i.listingCount >= 3)
        if (instruments.length === 0) {
            console.log('No instruments tracked yet. Run "coin-market demo" to see the tool work.')
            return
        }

        const curve = view.upliftCurve()

        console.log('COIN MARKET  -  premium over gold content, and where the market clears')
        console.log('')
        console.log([
            'Coin type'.padEnd(52), 'n'.padStart(4), 'clears'.padStart(8), 'asks'.padStart(8),
            'SPREAD'.padStart(8), 'sell-thru'.padStart(10), 'bid to'.padStart(10)
        ].join(' '))
        console.log('-'.repeat(106))

        for (const instrument of instruments) {
            const market = view.forInstrument(instrument.key)
            const fair = market.fairValue
            const liquidity = market.liquidity

            console.log([
                INSTRUMENTS.displayName(instrument.key).slice(0, 52).padEnd(52),
                String(fair.n).padStart(4),
                pct(fair.p50).padStart(8),
                pct(liquidity.medianAskPremium).padStart(8),
                pct(liquidity.askClearingSpread).padStart(8),
                pct(liquidity.sellThroughRate, 0).padStart(10),
                (market.bidCeiling ? gbp(market.bidCeiling.maxBid) : '-').padStart(10)
            ].join(' '))
        }

        /* The headline, spelled out. */
        const headline = view.forInstrument(instruments[0].key)
        const spread = headline.liquidity.askClearingSpread
        console.log('')
        if (spread !== null && headline.spot !== null) {
            const overpay = spread * headline.fineOz * headline.spot.gbpPerOz
            console.log('For ' + INSTRUMENTS.displayName(instruments[0].key) + ':')
            console.log('  gold content is worth ' + gbp(headline.fineOz * headline.spot.gbpPerOz) +
                ' at spot ' + gbp(headline.spot.gbpPerOz) + '/oz')
            console.log('  auctions clear at ' + pct(headline.fairValue.p50) + ' over melt (' +
                gbp(headline.fineOz * headline.spot.gbpPerOz * (1 + headline.fairValue.p50)) + ')')
            console.log('  buy-it-now asks at ' + pct(headline.liquidity.medianAskPremium) + ' over melt')
            console.log('  => paying the asking price costs you about ' + gbp(overpay) + ' more per coin')
            if (headline.bidCeiling !== null) {
                console.log('  => bid up to ' + gbp(headline.bidCeiling.maxBid) +
                    ' to buy at the ' + Math.round(view.config.targetQuantile * 100) + 'th percentile of clearing prices')
            }
        }

        /* Uplift curve - the thing that makes early alerts possible. */
        const learned = Object.entries(curve).filter(([, entry]) => entry.sufficient)
        console.log('')
        if (learned.length === 0) {
            console.log('Closing-uplift curve: not learned yet (needs completed auctions with snapshots).')
        } else {
            console.log('Closing-uplift curve - how much lots rise before the hammer:')
            for (const bucket of require('../src/analytics/uplift.js').BUCKETS) {
                const entry = curve[bucket.code]
                if (!entry.sufficient) { continue }
                console.log('  ' + bucket.label.padEnd(14) + ' x' + entry.median.toFixed(3) +
                    '   (n=' + entry.n + ')')
            }
        }

        /* Live opportunities. */
        const alerts = []
        for (const instrument of instruments) {
            const market = view.forInstrument(instrument.key)
            for (const alert of ALERT_RULES.evaluate(market, curve, { minEdge: 0.02 })) {
                alerts.push({ alert, name: INSTRUMENTS.displayName(instrument.key), level: instrument.level })
            }
        }
        const deduped = ALERT_RULES.dedupeByListing(alerts)
        console.log('')
        if (deduped.length === 0) {
            console.log('No live lot is currently below your bid ceiling.')
        } else {
            console.log('LIVE OPPORTUNITIES (' + deduped.length + '):')
            for (const entry of deduped.slice(0, 8)) {
                console.log('')
                console.log(ALERT_RULES.format(entry.alert, entry.name).split('\n').map(l => '  ' + l).join('\n'))
            }
        }

        const review = repository.reviewQueue(5)
        if (review.length > 0) {
            console.log('')
            console.log('Needs review (' + review.length + ' shown): listings the classifier would not guess at')
            for (const row of review) {
                console.log('  ' + (row.reason || '').slice(0, 44).padEnd(46) + row.title.slice(0, 44))
            }
        }

        db.close()
    }
}

/* -------------------------------------------------------- dashboard */

COMMANDS.dashboard = {
    describe: 'Serve the local dashboard',
    async run (args) {
        const opened = open(args[0])
        const settings = safeSettings()
        const port = (settings && settings.dashboard && settings.dashboard.port) || 34260
        const host = (settings && settings.dashboard && settings.dashboard.host) || '127.0.0.1'
        require('../src/web/server.js').start(opened, { port, host })
    }
}

COMMANDS.html = {
    describe: 'Write a self-contained HTML report you can open on a phone or share',
    async run (args) {
        const opened = open(args[1])
        const result = require('../src/report/build.js').build(opened, args[0])
        console.log('Wrote ' + result.path + ' (' + (result.bytes / 1024).toFixed(1) + ' kb, ' +
            result.instruments + ' coin types)')
        opened.db.close()
    }
}

/* ------------------------------------------------------------ spot */

COMMANDS.spot = {
    describe: 'Mirror the portfolio app\'s metals.dev feed into the local store',
    async run () {
        const settings = CONFIG.load()
        const db = newDatabase(settings.databasePath)
        const source = SPOT.newSpotSource(settings.spot)
        console.log('Reading spot from ' + source.describe())
        const result = await SPOT.mirror(db, source)
        console.log('Read ' + result.read + ' observations since ' + result.since +
            ', inserted ' + result.inserted + ' new.')
        db.close()
    }
}

COMMANDS.run = {
    describe: 'Run the collector continuously (this is what lives on the Pi)',
    async run () {
        const settings = CONFIG.load()
        const AUTH = require('../src/ebay/auth.js')
        const BROWSE = require('../src/ebay/browse.js')
        const TRADING = require('../src/ebay/trading.js')
        const BUDGET = require('../src/ebay/budget.js')

        const db = newDatabase(settings.databasePath)
        const repository = newRepository(db, {
            sellerSalt: settings.sellerSalt,
            rawRetentionDays: settings.collector.rawRetentionDays
        })
        const budget = BUDGET.newBudget(db, { dailyLimit: settings.ebay.dailyCallLimit })
        const auth = AUTH.newAuth(settings.ebay, { environment: settings.ebay.environment })

        const browse = BROWSE.newBrowseClient(auth, {
            marketplaceId: settings.ebay.marketplaceId, budget
        })
        const discoverer = require('../src/collect/discover.js').newDiscoverer(browse, repository, {
            marketplace: settings.ebay.marketplaceId, currency: settings.coins.currency
        })

        /* Outcome resolution needs a user token. Without one the collector
           still runs - it just cannot learn how lots finished, so it says
           so rather than failing silently. */
        let resolver = null
        if (settings.ebay.refreshToken) {
            const trading = TRADING.newTradingClient(auth, settings.ebay, {
                siteId: settings.ebay.siteId, budget
            })
            resolver = require('../src/collect/resolve.js').newResolver(trading, repository)
        } else {
            console.log('No eBay refresh token configured: discovery and snapshots will run,')
            console.log('but final sale prices cannot be resolved. Run "coin-market auth-url" to fix.')
        }

        const scheduler = require('../src/collect/scheduler.js').newScheduler({
            db, repository, discoverer, resolver, budget,
            spotSource: SPOT.newSpotSource(settings.spot),
            coins: settings.coins
        }, settings.collector)

        process.on('SIGINT', () => { scheduler.stop(); db.close(); process.exit(0) })
        scheduler.start()
    }
}

COMMANDS['auth-url'] = {
    describe: 'Print the eBay consent URL for the watch-list / outcome-resolution token',
    async run () {
        const settings = CONFIG.load()
        const auth = require('../src/ebay/auth.js').newAuth(settings.ebay, {
            environment: settings.ebay.environment
        })
        console.log('Open this in a browser, approve, then copy the "code" parameter')
        console.log('from the URL you land on and run:  coin-market auth-code <code>')
        console.log('')
        console.log(auth.consentUrl('coin-market'))
    }
}

COMMANDS['auth-code'] = {
    describe: 'Exchange the consent code for a refresh token (lasts ~18 months)',
    async run (args) {
        if (args[0] === undefined) { throw new Error('Usage: coin-market auth-code <code>') }
        const settings = CONFIG.load()
        const auth = require('../src/ebay/auth.js').newAuth(settings.ebay, {
            environment: settings.ebay.environment
        })
        const token = await auth.exchangeCode(decodeURIComponent(args[0]))
        console.log('Add this to config/settings.json under ebay.refreshToken:')
        console.log('')
        console.log(JSON.stringify(token.refreshToken || token.value))
    }
}

/* ---------------------------------------------------------- doctor */

COMMANDS.doctor = {
    describe: 'Run the Phase 0 checks against eBay before trusting the collector',
    async run () {
        const settings = CONFIG.load()
        const AUTH = require('../src/ebay/auth.js')
        const BROWSE = require('../src/ebay/browse.js')
        const TRADING = require('../src/ebay/trading.js')

        const auth = AUTH.newAuth(settings.ebay, { environment: settings.ebay.environment })
        const checks = []

        async function check (name, fn) {
            try { checks.push({ name, ok: true, detail: await fn() }) }
            catch (err) { checks.push({ name, ok: false, detail: err.message }) }
        }

        await check('Application token (client credentials)', async () => {
            const token = await auth.applicationToken()
            return 'obtained, ' + token.length + ' chars'
        })

        await check('Browse search returns auctions', async () => {
            const browse = BROWSE.newBrowseClient(auth, { marketplaceId: settings.ebay.marketplaceId })
            const payload = await browse.search({
                q: 'gold sovereign',
                filter: BROWSE.buildFilter({ buyingOptions: ['AUCTION'] }),
                limit: 10
            })
            const items = payload.itemSummaries || []
            const withBids = items.filter(i => i.bidCount !== undefined).length
            return items.length + ' items, ' + withBids + ' carrying bidCount' +
                (withBids === 0 && items.length > 0
                    ? '  <-- WARNING: no bidCount in search results, snapshotting would need per-item calls'
                    : '')
        })

        await check('Trading GetItem on a listing you do not own', async () => {
            if (!settings.ebay.refreshToken) { throw new Error('needs a user token - run "coin-market auth-url" first') }
            const trading = TRADING.newTradingClient(auth, settings.ebay, { siteId: settings.ebay.siteId })
            const probe = process.env.COIN_MARKET_PROBE_ITEM
            if (!probe) { throw new Error('set COIN_MARKET_PROBE_ITEM to any ended eBay item id to test this') }
            const item = await trading.getItem(probe)
            return 'resolved: sold=' + item.sold + ' final=' + item.finalPrice + ' bids=' + item.bidCount
        })

        console.log('')
        for (const result of checks) {
            console.log((result.ok ? '  PASS  ' : '  FAIL  ') + result.name)
            console.log('        ' + result.detail)
        }
        console.log('')
        console.log('The third check is the load-bearing one: if Trading GetItem does not work')
        console.log('for listings you do not own, outcome resolution falls back to the last')
        console.log('snapshot before close, which is less exact. Everything else still works.')
    }
}

/* ----------------------------------------------------------- helpers */

function safeSettings () {
    try { return CONFIG.load() } catch (err) { return null }
}

function open (explicitDbPath) {
    const settings = safeSettings()
    const dbPath = explicitDbPath ||
        (settings ? settings.databasePath : PATH.join(CONFIG.ROOT, 'demo.db'))

    if (!FS.existsSync(dbPath)) {
        throw new Error('No database at ' + dbPath + '\nRun "coin-market demo" first, or configure config/settings.json.')
    }

    const db = newDatabase(dbPath)
    const repository = newRepository(db, {
        sellerSalt: (settings && settings.sellerSalt) || 'demo',
        rawRetentionDays: (settings && settings.collector && settings.collector.rawRetentionDays) || 180
    })
    const spotAt = SPOT.newSpotLookup(db, {
        toleranceMinutes: (settings && settings.spot && settings.spot.toleranceMinutes) || 90
    })
    const view = MARKET.newMarketView(repository, spotAt, {
        targetQuantile: (settings && settings.coins && settings.coins.watchlist)
            ? settings.coins.watchlist.targetQuantile : 0.35
    })
    return { db, repository, spotAt, view, settings, dbPath }
}

/* -------------------------------------------------------------- main */

async function main () {
    const [, , command, ...args] = process.argv

    if (command === undefined || command === 'help' || command === '--help') {
        console.log('coin-market  -  eBay lot tracking, catalogue grouping, premium and liquidity\n')
        console.log('USAGE: coin-market <command> [args]\n')
        for (const [name, entry] of Object.entries(COMMANDS)) {
            console.log('  ' + name.padEnd(12) + entry.describe)
        }
        console.log('')
        console.log('Start with:  node bin/cli.js demo')
        return
    }

    const entry = COMMANDS[command]
    if (entry === undefined) {
        console.error('Unknown command: ' + command)
        process.exitCode = 1
        return
    }

    try {
        await entry.run(args)
    } catch (err) {
        console.error('\n' + err.message)
        process.exitCode = 1
    }
}

if (require.main === module) { main() }

exports.open = open
