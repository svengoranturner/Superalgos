'use strict'

/*
    Call budget ledger.

    A standard eBay developer keyset gets 5,000 calls a day, application
    wide. Blowing that at 11am means the tool is blind for thirteen hours,
    including every auction that closes in them - so spend is metered
    rather than hoped about.

    Degradation is ordered deliberately: snapshot cadence is sacrificed
    before discovery. A missed snapshot costs precision on one lot; a
    missed discovery loses the lot entirely, and with it the outcome that
    would have taught the uplift curve.
*/

const PRIORITY = { discover: 1, resolve: 2, endingSoon: 3, snapshot: 4, hydrate: 5 }

exports.newBudget = function (db, options) {

    const config = Object.assign({ dailyLimit: 5000, reserve: 250 }, options || {})

    const today = () => new Date().toISOString().slice(0, 10)

    const upsert = db.prepare(
        'INSERT INTO call_budget (day, api, calls) VALUES (?, ?, 1) ' +
        'ON CONFLICT(day, api) DO UPDATE SET calls = calls + 1'
    )
    const spentToday = db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM call_budget WHERE day = ? AND api != ?')

    return {
        record (api) { upsert.run(today(), api) },

        spent () { return spentToday.get(today(), 'trading').n },

        remaining () { return Math.max(0, config.dailyLimit - this.spent()) },

        /*
            Whether a job of the given kind may spend `cost` calls now.
            Lower-priority work is cut off earlier, leaving a reserve that
            only discovery and outcome resolution can touch.
        */
        allows (job, cost) {
            const priority = PRIORITY[job] !== undefined ? PRIORITY[job] : 5
            const remaining = this.remaining()
            const floor = priority <= 2 ? 0 : config.reserve
            return (remaining - cost) >= floor
        },

        /*
            Reconciles our own count against eBay's, which is authoritative.
            Ours can drift on retries and network failures, and drifting
            optimistically is how quotas get blown.
        */
        reconcile (remainingPerEbay) {
            if (!Number.isFinite(remainingPerEbay)) { return }
            const impliedSpend = config.dailyLimit - remainingPerEbay
            if (impliedSpend > this.spent()) {
                db.prepare(
                    'INSERT INTO call_budget (day, api, calls) VALUES (?, ?, ?) ' +
                    'ON CONFLICT(day, api) DO UPDATE SET calls = ?'
                ).run(today(), 'reconciliation', impliedSpend - this.spent(), impliedSpend - this.spent())
            }
        },

        config
    }
}

exports.PRIORITY = PRIORITY
