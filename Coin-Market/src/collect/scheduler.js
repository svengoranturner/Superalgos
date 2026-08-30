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

    const { db, repository, discoverer, resolver, spotSource, coins, budget } = parts
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
                const result = await SPOT.mirror(db, spotSource)
                if (result.inserted > 0) { log('spot', 'mirrored ' + result.inserted + ' new observations') }
            })

            every(config.sweepMinutes, 'sweep', async () => {
                const report = await discoverer.sweep(coins)
                log('sweep', report.items + ' listings seen, ' + report.classified + ' classified, ' +
                    report.review + ' to review' +
                    (report.truncated.length > 0
                        ? ' | TRUNCATED: ' + report.truncated.join(', ') +
                          ' (result set exceeded eBay 10,000 cap - narrow these partitions)'
                        : '') +
                    (report.errors.length > 0 ? ' | errors: ' + report.errors.length : ''))
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
