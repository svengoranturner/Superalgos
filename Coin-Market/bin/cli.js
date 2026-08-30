#!/usr/bin/env node
'use strict'

/*
    Node version guard.

    The tool has no dependencies because it uses node:sqlite, which landed
    in Node 22.5.0. Debian 13 on the Pi ships 20.19 through apt - and the
    Pi had no node at all - so the most likely first-run failure on the
    target machine is a cryptic "Cannot find module node:sqlite". Fail with
    something actionable, and point at what actually worked there rather
    than at a NodeSource script that has no trixie repository.
*/
{
    const parts = process.versions.node.split('.').map(Number)
    if (parts[0] < 22 || (parts[0] === 22 && parts[1] < 5)) {
        console.error('')
        console.error('coin-market needs Node 22.5 or newer (found ' + process.versions.node + ').')
        console.error('')
        console.error('It uses node:sqlite, built into Node since 22.5 - which is why this tool')
        console.error('has no dependencies and needs no compiler on a Pi.')
        console.error('')
        console.error('On Debian / Raspberry Pi OS, apt ships an older Node. Install a current one -')
        console.error('this is the arm64 build, and DEPLOY.md section 1 has the whole sequence:')
        console.error('  V=v24.20.0; cd /tmp')
        console.error('  curl -fsSL -O https://nodejs.org/dist/$V/node-$V-linux-arm64.tar.xz')
        console.error('  sudo mkdir -p /usr/local/lib/nodejs')
        console.error('  sudo tar -xJf node-$V-linux-arm64.tar.xz -C /usr/local/lib/nodejs')
        console.error('  sudo ln -sfn /usr/local/lib/nodejs/node-$V-linux-arm64/bin/node /usr/local/bin/node')
        console.error('')
        process.exit(1)
    }
}

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

/*
    Ask for one value on the terminal.

    init takes its credentials this way rather than from the command line
    because a pasted command line is the thing that goes wrong: the
    placeholder gets run verbatim, and the real keys - when they are
    finally right - land in shell history and in ps output for anyone on
    the machine. Nothing to substitute, nothing left behind.
*/
function newPrompter () {
    const READLINE = require('node:readline')
    const rl = READLINE.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

    let muted = false
    let closed = false
    rl.once('close', () => { closed = true })
    rl._writeToOutput = function (chunk) { if (!muted) { rl.output.write(chunk) } }

    return {
        /*  One interface for the whole run, not one per question: closing an
            interface takes stdin with it, and the second question then never
            arrives. */
        ask (question, options) {
            const secret = options !== undefined && options.secret === true
            /*  Input already ended - asking again throws. Answer empty and
                let the caller's placeholder check report it properly. */
            if (closed) { return Promise.resolve('') }
            return new Promise(resolve => {
                let settled = false
                const finish = value => {
                    if (settled) { return }
                    settled = true
                    muted = false
                    resolve(value)
                }
                /*  EOF instead of an answer resolves empty rather than
                    hanging - the caller rejects it as unfilled, which is a
                    better ending than a process that exits saying nothing. */
                rl.once('close', () => finish(''))
                rl.question(question, answer => {
                    if (muted) { rl.output.write('\n') }
                    finish(answer.trim())
                })
                /* Set after question(), so the prompt itself still prints. */
                muted = secret
            })
        },
        close () { rl.close() }
    }
}

/* The example template may still hold placeholders at init time, so this
   never lets a bad spot block stop settings.json being written. */
function describeSpot (spec) {
    try { return SPOT.newSpotSource(spec).describe() } catch (err) { return spec.type + ' (' + err.message + ')' }
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

/* ------------------------------------------------------ reclassify */

COMMANDS.reclassify = {
    describe: 'Re-run classification over every stored listing (after a rule change)',
    async run (args) {
        const { db, repository } = open(args[0])
        const CLASSIFY = require('../src/catalogue/classify.js').classify

        /*  Classification is derived, so it can always be rebuilt from the
            stored titles. That matters whenever a rule changes: without this
            the old keys linger beside the new ones and the same coin is
            counted under both, which is worse than either alone.

            Only derived tables are cleared. Listings, snapshots and outcomes
            - everything that cost an API call or can never be re-observed -
            are untouched. */
        const before = db.prepare('SELECT COUNT(*) AS n FROM listing_instrument').get().n
        db.exec('DELETE FROM listing_instrument')
        db.exec('DELETE FROM instrument')
        db.exec('DELETE FROM review_queue')
        try { db.exec('DELETE FROM instrument_stat') } catch (err) { /* older stores may not have it */ }

        const listings = db.prepare('SELECT browse_id AS browseId, title FROM listing').all()
        let classified = 0
        let reviewed = 0
        let excluded = 0

        for (const listing of listings) {
            const result = CLASSIFY({ title: listing.title })

            if (result.excluded !== null) {
                repository.queueForReview(listing.browseId, 'EXCLUDED: ' + result.excluded.reason, null, 0)
                excluded++
                continue
            }

            const keys = INSTRUMENTS.keysFor(result.attributes)
            if (keys.length === 0 || result.needsReview) {
                repository.queueForReview(
                    listing.browseId,
                    result.reasons.join('; ') || 'Low confidence',
                    keys.length > 0 ? keys[keys.length - 1].key : null,
                    result.confidence
                )
                reviewed++
            }
            if (keys.length > 0) {
                repository.saveClassification(
                    listing.browseId, keys, result.confidence, 'title',
                    INSTRUMENTS.fineOzFor(result.attributes), result.attributes
                )
                classified++
            }
        }

        console.log('Reclassified ' + listings.length + ' stored listings')
        console.log('  assignments : ' + before + ' -> ' +
            db.prepare('SELECT COUNT(*) AS n FROM listing_instrument').get().n)
        console.log('  classified  : ' + classified)
        console.log('  excluded    : ' + excluded)
        console.log('  to review   : ' + reviewed)
        console.log('  instruments : ' + db.prepare('SELECT COUNT(*) AS n FROM instrument').get().n)
        db.close()
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

        const QUOTA = require('../src/ebay/quota.js')

        const scheduler = require('../src/collect/scheduler.js').newScheduler({
            db, repository, discoverer, resolver, budget,
            browseRemaining: () => QUOTA.browseRemaining(auth),
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

        /*  Without this the URL still prints, with redirect_uri=YOUR-RUNAME
            in it, and the failure surfaces on eBay's own error page - which
            says nothing about a placeholder in a local config file. */
        if (CONFIG.looksUnfilled(settings.ebay.ruName)) {
            console.log('ebay.ruName is still placeholder text: ' + JSON.stringify(settings.ebay.ruName))
            console.log('')
            console.log('A RuName is eBay\'s name for your OAuth redirect. Create one at')
            console.log('developer.ebay.com > your keyset > "User tokens" > Get a Token from')
            console.log('eBay via Your Application, then re-run init with it:')
            console.log('')
            console.log('  node bin/cli.js init --runame=<the RuName> --force=')
            console.log('')
            console.log('Note: init regenerates the seller salt. Harmless now, before any')
            console.log('listings are stored - a new salt orphans existing seller hashes.')
            process.exitCode = 1
            return
        }

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
        const refreshToken = token.refreshToken || token.value

        /*  Stored, not printed. This is good for ~18 months, and the old
            behaviour put it in the terminal scrollback and then asked for
            it to be hand-edited into the very file init exists to spare
            anyone editing. Written in place so nothing else is disturbed. */
        const target = PATH.join(CONFIG.ROOT, 'config', 'settings.json')
        const current = JSON.parse(FS.readFileSync(target, 'utf8'))
        current.ebay = current.ebay || {}
        const replacing = typeof current.ebay.refreshToken === 'string' &&
            current.ebay.refreshToken.length > 0
        current.ebay.refreshToken = refreshToken
        FS.writeFileSync(target, JSON.stringify(current, null, 2) + '\n', { mode: 0o600 })

        console.log((replacing ? 'Replaced' : 'Stored') + ' the refresh token in ' + target)
        console.log('  ' + refreshToken.length + ' characters, mode 0600, gitignored - not printed here.')
        console.log('')
        console.log('Next:  node bin/cli.js smoke')
    }
}

COMMANDS['notify-endpoint'] = {
    describe: 'Serve the eBay account-deletion endpoint (needed to activate production keys)',
    async run () {
        const settings = CONFIG.load()
        const NOTIFICATIONS = require('../src/ebay/notifications.js')
        const spec = settings.ebay.accountDeletion || {}

        if (!spec.endpointUrl || !spec.verificationToken) {
            throw new Error(
                'Set ebay.accountDeletion.endpointUrl and .verificationToken in config/settings.json.\n' +
                'Generate a token with:  node bin/cli.js notify-token\n' +
                'The endpointUrl must match what you register with eBay EXACTLY - a trailing\n' +
                'slash or an http/https mismatch is the usual cause of "validation failed".')
        }

        const db = newDatabase(settings.databasePath)
        const repository = newRepository(db, { sellerSalt: settings.sellerSalt })

        const handle = NOTIFICATIONS.newHandler({
            verificationToken: spec.verificationToken,
            endpointUrl: spec.endpointUrl,
            onDeletion: (username) => NOTIFICATIONS.purgeUser(repository, db, username),
            log: (message) => console.log(new Date().toISOString().slice(0, 19) + '  ' + message)
        })

        const port = spec.port || 34261
        const host = spec.host || '127.0.0.1'

        require('node:http').createServer((request, response) => {
            const chunks = []
            request.on('data', chunk => chunks.push(chunk))
            request.on('end', () => {
                const url = new URL(request.url, spec.endpointUrl)
                const result = handle(request.method, url, Buffer.concat(chunks).toString('utf8'))
                response.writeHead(result.status, { 'Content-Type': result.contentType })
                response.end(result.body)
            })
        }).listen(port, host, () => {
            console.log('Account-deletion endpoint listening on http://' + host + ':' + port)
            console.log('Registered URL must be exactly: ' + spec.endpointUrl)
            console.log('')
            console.log('Put your reverse proxy in front of this, and make sure the path is')
            console.log('NOT behind an auth gate - eBay must reach it unauthenticated.')
        })
    }
}

COMMANDS['notify-token'] = {
    describe: 'Generate a verification token for the account-deletion endpoint',
    async run () {
        const NOTIFICATIONS = require('../src/ebay/notifications.js')
        const token = NOTIFICATIONS.generateToken()
        console.log(token)
        console.log('')
        console.log('Paste this into BOTH eBay\'s subscription form and')
        console.log('config/settings.json under ebay.accountDeletion.verificationToken.')
    }
}

COMMANDS['notify-check'] = {
    describe: 'Verify your endpoint answers eBay\'s challenge correctly',
    async run (args) {
        const settings = CONFIG.load()
        const NOTIFICATIONS = require('../src/ebay/notifications.js')
        const spec = settings.ebay.accountDeletion || {}
        const target = args[0] || spec.endpointUrl

        const challenge = 'test_' + Date.now()
        const expected = NOTIFICATIONS.challengeResponse(challenge, spec.verificationToken, spec.endpointUrl)

        const url = new URL(target)
        url.searchParams.set('challenge_code', challenge)
        console.log('GET ' + url.toString())

        const response = await fetch(url, { headers: { accept: 'application/json' } })
        const text = await response.text()
        let actual = null
        try { actual = JSON.parse(text).challengeResponse } catch (err) { actual = null }

        console.log('')
        console.log('  HTTP status      : ' + response.status)
        console.log('  content-type     : ' + (response.headers.get('content-type') || '(none)'))
        console.log('  expected hash    : ' + expected)
        console.log('  endpoint returned: ' + (actual === null ? '(not JSON: ' + text.slice(0, 80) + ')' : actual))
        console.log('')
        if (actual === expected) {
            console.log('  MATCH - eBay will accept this endpoint.')
        } else {
            console.log('  MISMATCH. Almost always one of:')
            console.log('   - endpointUrl in settings.json differs from the URL registered with eBay')
            console.log('     (trailing slash, http vs https, www) - the URL is part of the hash')
            console.log('   - the verification token differs between eBay and settings.json')
            console.log('   - an auth gate or CDN is intercepting the request before it reaches you')
            process.exitCode = 1
        }
    }
}

COMMANDS.init = {
    describe: 'Write config/settings.json from your eBay keys (no hand-editing JSON)',
    async run (args) {
        const flags = {}
        for (const arg of args) {
            const match = arg.match(/^--([a-zA-Z-]+)=([\s\S]*)$/)
            if (match !== null) { flags[match[1]] = match[2] }
        }

        const target = PATH.join(CONFIG.ROOT, 'config', 'settings.json')

        /* Checked before anything is asked for: refusing after three
           prompts, one of them a secret, would be its own small insult. */
        if (FS.existsSync(target) && flags.force === undefined) {
            console.log(target + ' already exists. Pass --force= to overwrite.')
            console.log('(the trailing = is required - flags are --name=value)')
            process.exitCode = 1
            return
        }

        /*  Read before it is overwritten: some of what is in there has to
            survive, and a malformed file should say so rather than quietly
            losing a verification token eBay is still holding. */
        let existing = null
        if (FS.existsSync(target)) {
            try { existing = JSON.parse(FS.readFileSync(target, 'utf8')) }
            catch (err) {
                console.log('Warning: ' + target + ' is not valid JSON (' + err.message + ')')
                console.log('Nothing can be carried forward from it.')
                console.log('')
            }
        }

        const FIELDS = [
            { flag: 'app-id', label: 'App ID (Client ID)   ' },
            { flag: 'cert-id', label: 'Cert ID (Client Secret)', secret: true },
            { flag: 'dev-id', label: 'Dev ID               ' }
        ]

        /*  Re-running init to change one setting - a RuName, say - should not
            demand all three credentials again. Anything already stored and
            real is reused; an explicit flag still wins. */
        const reused = []
        if (existing !== null && existing.ebay !== undefined && existing.ebay !== null) {
            const stored = {
                'app-id': existing.ebay.clientId,
                'cert-id': existing.ebay.clientSecret,
                'dev-id': existing.ebay.devId
            }
            for (const field of FIELDS) {
                if (flags[field.flag] === undefined && !CONFIG.looksUnfilled(stored[field.flag])) {
                    flags[field.flag] = stored[field.flag]
                    reused.push(field.flag)
                }
            }
        }

        const missing = FIELDS.filter(f => flags[f.flag] === undefined)
        if (missing.length > 0 && !process.stdin.isTTY) {
            console.log('Usage:')
            console.log('  node bin/cli.js init            (asks for the keys - preferred)')
            console.log('  node bin/cli.js init --app-id=<id> --cert-id=<secret> --dev-id=<id>')
            console.log('      [--env=sandbox|production] [--marketplace=EBAY_GB]')
            console.log('      [--spot-project=/path/to/portfolio/app] [--spot-db=/path/to/prices.db]')
            console.log('')
            console.log('Missing: ' + missing.map(f => f.flag).join(', '))
            process.exitCode = 1
            return
        }

        if (missing.length > 0) {
            console.log('eBay keys from developer.ebay.com - paste each one.')
            console.log('The Cert ID will not echo. Nothing is stored in shell history.')
            console.log('')
            const prompter = newPrompter()
            try {
                for (const field of missing) {
                    flags[field.flag] = await prompter.ask('  ' + field.label + ': ', { secret: field.secret })
                }
            } finally { prompter.close() }
            console.log('')
        }

        /* A placeholder that reached this far would write a settings.json
           that looks complete and fails at the first eBay call instead. */
        const unfilled = FIELDS.filter(f => CONFIG.looksUnfilled(flags[f.flag]))
        if (unfilled.length > 0) {
            console.log('That is still placeholder text, not a key: ' +
                unfilled.map(f => f.flag + '=' + JSON.stringify(flags[f.flag])).join(', '))
            console.log('Paste the actual values from developer.ebay.com. Nothing was written.')
            process.exitCode = 1
            return
        }

        const template = JSON.parse(
            FS.readFileSync(PATH.join(CONFIG.ROOT, 'config', 'settings.example.json'), 'utf8'))

        /* Prose keys in the example file are documentation, not settings. */
        for (const key of Object.keys(template)) {
            if (key.startsWith('_')) { delete template[key] }
        }

        template.ebay.clientId = flags['app-id']
        template.ebay.clientSecret = flags['cert-id']
        template.ebay.devId = flags['dev-id']
        template.ebay.environment = flags.env || 'sandbox'
        template.ebay.marketplaceId = flags.marketplace || 'EBAY_GB'
        if (flags.runame !== undefined) { template.ebay.ruName = flags.runame }
        /* The portfolio app on the Pi keeps spot in PostgreSQL; --spot-project
           points at its compose project. --spot-db is still there for a
           portfolio store that is a SQLite file, which switches the whole
           source over rather than setting a path the postgres reader ignores. */
        if (flags['spot-project'] !== undefined) { template.spot.projectDir = flags['spot-project'] }
        if (flags['spot-db'] !== undefined) {
            template.spot = {
                type: 'sqlite',
                path: flags['spot-db'],
                table: 'spot_prices',
                metalValue: 'XAU',
                columns: { observedAt: 'observed_at', gbpPerOz: 'gbp_per_oz', usdPerOz: 'usd_per_oz', metal: 'metal' },
                toleranceMinutes: template.spot.toleranceMinutes || 90
            }
        }

        /* A salt that is generated, not left as the placeholder - it is
           what keeps stored seller hashes from being reversible by anyone
           holding a copy of the database. */
        template.sellerSalt = require('node:crypto').randomBytes(24).toString('base64url')
        template.ebay.accountDeletion.verificationToken =
            require('../src/ebay/notifications.js').generateToken()

        /*  Overwriting an existing setup keeps the values that something
            outside this file already depends on - eBay holds the
            verification token, and every stored seller hash was computed
            with the salt. Regenerating either silently breaks a working
            install; see CONFIG.carryForward. */
        let settings = template
        if (existing !== null && flags['regenerate-secrets'] === undefined) {
            settings = CONFIG.carryForward(existing, template)
        }

        FS.writeFileSync(target, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
        console.log('Wrote ' + target + ' (mode 0600, gitignored)')
        console.log('')
        const carried = settings.carriedForward || []
        const wasKept = name => carried.includes(name)

        if (reused.length > 0) {
            console.log('  eBay keys          : reused from the existing file (' + reused.join(', ') + ')')
        }
        console.log('  environment        : ' + settings.ebay.environment)
        console.log('  marketplace        : ' + settings.ebay.marketplaceId)
        console.log('  seller salt        : ' + (wasKept('sellerSalt')
            ? 'kept (stored seller hashes still match)'
            : 'generated'))
        console.log('  deletion token     : ' + (wasKept('ebay.accountDeletion.verificationToken')
            ? 'kept (eBay holds this one - do not re-register)'
            : 'generated (register it with eBay)'))
        console.log('  spot store         : ' + describeSpot(settings.spot))
        if (carried.length > 0) {
            console.log('')
            console.log('  Carried over from the previous file: ' + carried.join(', '))
            console.log('  Use --regenerate-secrets= to start fresh instead.')
        }
        console.log('')
        console.log('Next:  node bin/cli.js smoke')
    }
}

COMMANDS.smoke = {
    describe: 'Probe every eBay API path and report pass/fail/unknown per capability',
    async run (args) {
        const settings = CONFIG.load()
        const SMOKE = require('../src/ebay/smoke.js')

        const probeItemId = args.find(a => /^\d{9,}$/.test(a)) || process.env.COIN_MARKET_PROBE_ITEM || null
        const report = await SMOKE.run(settings, { probeItemId })

        console.log(SMOKE.format(report))

        /* The response shapes matter as much as the verdicts: several
           readers were written tolerantly because eBay documents these
           ambiguously. Dumped so they can be inspected or shared. */
        const dump = PATH.join(CONFIG.ROOT, 'smoke-shapes.json')
        FS.writeFileSync(dump, JSON.stringify(report.shapes, null, 2) + '\n')
        console.log('  Response shapes written to ' + dump)
        console.log('  (no credentials in that file - safe to share)')
        console.log('')

        if (report.results.some(r => r.status === 'FAIL')) { process.exitCode = 1 }
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

        await check('Coin condition descriptors present on UK listings', async () => {
            /* eBay's mandatory-condition-detail phase-in was announced for
               May 2026; the UK timing is not confirmed. This reports what
               is actually arriving rather than assuming. */
            const browse = BROWSE.newBrowseClient(auth, { marketplaceId: settings.ebay.marketplaceId })
            const payload = await browse.search({
                q: 'gold sovereign',
                filter: BROWSE.buildFilter({ buyingOptions: ['AUCTION', 'FIXED_PRICE'] }),
                limit: 50
            })
            const items = payload.itemSummaries || []
            const withDescriptors = items.filter(i => Array.isArray(i.conditionDescriptors) && i.conditionDescriptors.length > 0)
            const names = new Set()
            for (const item of withDescriptors) {
                for (const descriptor of item.conditionDescriptors) {
                    if (descriptor && descriptor.name) { names.add(descriptor.name) }
                }
            }
            return withDescriptors.length + '/' + items.length + ' listings carry descriptors' +
                (names.size > 0 ? '; fields seen: ' + Array.from(names).join(', ') : '') +
                (withDescriptors.length === 0
                    ? '  <-- not yet live on EBAY_GB, or absent from search results (try getItem)'
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
        console.log('The GetItem check is the load-bearing one: if Trading GetItem does not')
        console.log('work for listings you do not own, outcome resolution falls back to the')
        console.log('last snapshot before close, which is less exact. Everything else still works.')
        console.log('')
        console.log('The condition-descriptor check is informational. Descriptors give structured')
        console.log('grade data and, for slabbed coins, a certification number that identifies')
        console.log('one physical coin across relistings. Absent them, grade falls back to')
        console.log('parsing the title, which is what the tool did before they existed.')
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
        const width = Math.max(...Object.keys(COMMANDS).map(name => name.length)) + 2
        for (const [name, entry] of Object.entries(COMMANDS)) {
            console.log('  ' + name.padEnd(width) + entry.describe)
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
