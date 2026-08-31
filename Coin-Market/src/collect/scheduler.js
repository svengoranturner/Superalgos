'use strict'

const SPOT = require('../spot/spot.js')

/*
    The collector loop.

    Cadences are chosen around one asymmetry: a lot can only be DISCOVERED
    while it is live, but its outcome can be RESOLVED any time in the
    following 90 days. So discovery and the ending-soon refresh are
    time-critical and run often; resolution is a queue that drains.

    Every job is budget-aware and independently recoverable - one failing
    job must never stop the others, because a collector that dies quietly
    at 2am loses every auction that closed overnight.
*/

exports.newScheduler = function (parts, options) {

    const { db, repository, discoverer, resolver, spotSource, spotMetals: given, coins, budget } = parts

    /*  A caller that supplied only the old single source still works: it
        becomes the gold entry, which is what it always was. */
    const spotMetals = given && given.length > 0
        ? given
        : [{ store: 'XAU', source: spotSource }]
    const config = Object.assign({
        sweepMinutes: 60,
        endingSoonMinutes: 5,
        resolveMinutes: 30,
        spotMinutes: 20,
        reconcileMinutes: 30,
        purgeHours: 24
    }, options || {})

    const timers = []
    let stopping = false

    function log (job, message) {
        console.log(new Date().toISOString().slice(0, 19) + '  ' + job.padEnd(12) + message)
    }

    /* Runs a job now and on an interval, surviving its own failures. */
    function every (minutes, name, job) {
        const run = async () => {
            if (stopping) { return }
            try { await job() } catch (err) { log(name, 'ERROR ' + err.message) }
        }
        run()
        timers.push(setInterval(run, minutes * 60 * 1000))
    }

    return {
        start () {
            log('scheduler', 'starting; budget ' + budget.remaining() + ' calls remaining today')

            every(config.spotMinutes, 'spot', async () => {
                /*  One source per metal, each with its own high-water mark,
                    so silver backfills its own history rather than starting
                    wherever gold happens to have reached. */
                for (const metal of spotMetals) {
                    const result = await SPOT.mirror(db, metal.source, { metal: metal.store })
                    if (result.inserted > 0) {
                        log('spot', 'mirrored ' + result.inserted + ' new ' + metal.store + ' observations')
                    }
                }
            })

            every(config.sweepMinutes, 'sweep', async () => {
                const report = await discoverer.sweep(coins)
                log('sweep', report.items + ' listings seen, ' + report.classified + ' classified, ' +
                    report.review + ' to review' +
                    (report.truncated.length > 0
                        ? ' | TRUNCATED: ' + report.truncated.join(', ') +
                          ' (result set exceeded eBay 10,000 cap - narrow these partitions)'
                        : '') +
                    (report.errors.length > 0
                        ? ' | errors: ' + report.errors.length +
                          ' (' + exports.summariseErrors(report.errors) + ')'
                        : ''))
            })

            every(config.endingSoonMinutes, 'ending-soon', async () => {
                const report = await discoverer.endingSoon(coins)
                if (report.items > 0) { log('ending-soon', 'refreshed ' + report.items + ' closing lots') }
            })

            every(config.resolveMinutes, 'resolve', async () => {
                if (resolver === null) { return }
                const report = await resolver.resolvePending(60)
                if (report.attempted > 0) {
                    log('resolve', report.resolved + '/' + report.attempted + ' outcomes resolved' +
                        (report.censored > 0 ? ', ' + report.censored + ' censored (Best Offer)' : '') +
                        (report.gone > 0 ? ', ' + report.gone + ' past the 90-day window' : ''))
                }
            })

            /*  Our call count against eBay's, which is authoritative. Ours
                rolls at UTC midnight while eBay's Browse window resets at
                07:00, so without this the collector believes it has a fresh
                quota for seven hours a day that it does not have. Optional:
                if no reader was supplied the collector still runs, just on
                its own estimate. */
            if (typeof parts.browseRemaining === 'function') {
                every(config.reconcileMinutes, 'quota', async () => {
                    const remaining = await parts.browseRemaining()
                    if (!Number.isFinite(remaining)) { return }
                    const before = budget.remaining()
                    budget.reconcile(remaining)
                    const after = budget.remaining()
                    if (after !== before) {
                        log('quota', 'eBay reports ' + remaining + ' left; corrected ours ' +
                            before + ' -> ' + after)
                    }
                })
            }

            every(config.purgeHours * 60, 'retention', async () => {
                const purged = repository.purgeExpired()
                if (purged > 0) { log('retention', 'purged ' + purged + ' expired raw listings') }
            })
        },

        stop () {
            stopping = true
            for (const timer of timers) { clearInterval(timer) }
            log('scheduler', 'stopped')
        }
    }
}

/*
    Turns a pile of error strings into something an operator can act on.

    A bare count is unactionable: "errors: 8" gives no way to tell eight
    transient timeouts apart from one partition failing every single sweep,
    and this runs unattended for months. Distinct messages, most frequent
    first, capped so a storm cannot flood the journal.
*/
exports.summariseErrors = function (messages, limit) {
    const counts = new Map()
    for (const message of messages) {
        const key = String(message)
        counts.set(key, (counts.get(key) || 0) + 1)
    }
    const ordered = [...counts.entries()].sort((a, b) => b[1] - a[1])
    const cap = limit === undefined ? 3 : limit
    const shown = ordered.slice(0, cap).map(([message, n]) => (n > 1 ? n + 'x ' : '') + message)
    if (ordered.length > shown.length) {
        shown.push('and ' + (ordered.length - shown.length) + ' more')
    }
    return shown.join('; ')
}
