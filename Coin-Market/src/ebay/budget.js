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

/*  Not an API. A signed correction row holding the gap between the calls we
    recorded and the spend eBay attributes to us - see reconcile(). */
const ADJUSTMENT = 'reconciliation'

exports.newBudget = function (db, options) {

    /*  dailyLimit is the BROWSE allowance - spent() excludes Trading
        deliberately, so the two never compete. tradingDailyLimit is the
        separate ceiling for it; eBay has never told this repo what the
        real Trading grant is (smoke.js keeps only the Browse entry from
        getRateLimits), so this is a conservative default rather than a
        measured one. */
    const config = Object.assign(
        { dailyLimit: 5000, reserve: 250, tradingDailyLimit: 5000 }, options || {})

    const today = () => new Date().toISOString().slice(0, 10)

    const upsert = db.prepare(
        'INSERT INTO call_budget (day, api, calls) VALUES (?, ?, 1) ' +
        'ON CONFLICT(day, api) DO UPDATE SET calls = calls + 1'
    )
    const spentToday = db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM call_budget WHERE day = ? AND api != ?')
    const spentOnApi = db.prepare('SELECT COALESCE(SUM(calls), 0) AS n FROM call_budget WHERE day = ? AND api = ?')

    return {
        record (api) { upsert.run(today(), api) },

        spent () { return spentToday.get(today(), 'trading').n },

        /*
            Trading has its own allowance and its own ceiling.

            It is excluded from spent() above so that outcome resolution
            cannot eat the Browse budget that discovery runs on - but nothing
            was capping it either. Every Trading call site only ever
            record()ed, so a job that resolved one listing per vanished
            Buy-It-Now would have been free to spend without limit. That was
            fine while the only caller resolved a handful of ended auctions a
            day; it is not fine for anything that scales with the size of the
            corpus.
        */
        spentOn (api) { return spentOnApi.get(today(), api).n },

        allowsTrading (cost) {
            return (config.tradingDailyLimit - this.spentOn('trading') - (cost || 1)) >= 0
        },

        tradingRemaining () {
            return Math.max(0, config.tradingDailyLimit - this.spentOn('trading'))
        },

        /*  Clamped at both ends: the adjustment below is signed, so a large
            negative one must not hand out more than a window actually holds. */
        remaining () {
            return Math.min(config.dailyLimit, Math.max(0, config.dailyLimit - this.spent()))
        },

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
            Ours drifts on retries and network failures, and drifting
            optimistically is how quotas get blown.

            The adjustment row is a CORRECTION, not a count of calls, so it
            has to be measured against our own calls alone - excluding
            itself. Measuring against spent(), which already contains the
            last correction, and then overwriting that correction, means each
            pass throws away the previous one. That ran in production for
            days: every other reconciliation handed back some 3,500
            imaginary calls, so the budget oscillated between the truth and a
            fantasy every thirty minutes.

            The correction is signed, and that is the point. Our day rolls at
            UTC midnight; eBay's Browse window rolls at 07:00 UTC. A
            correction that could only ever ADD spend meant that when eBay's
            window reset and ours did not, the ledger stayed pinned at
            exhausted until midnight - the collector sat blind for seventeen
            hours holding a full allowance it was refusing to spend. Trusting
            eBay in both directions makes the mismatch self-heal within one
            reconcile interval, without this module needing to know when
            either window turns over.

            Between readings the arithmetic still holds: the correction is
            fixed, our own count keeps rising as calls are recorded, so
            remaining() tracks eBay's last figure minus what we have spent
            since it.
        */
        reconcile (remainingPerEbay) {
            if (!Number.isFinite(remainingPerEbay)) { return }
            const impliedSpend = config.dailyLimit - remainingPerEbay
            const ourOwnCalls = this.spent() - this.spentOn(ADJUSTMENT)
            const correction = impliedSpend - ourOwnCalls
            db.prepare(
                'INSERT INTO call_budget (day, api, calls) VALUES (?, ?, ?) ' +
                'ON CONFLICT(day, api) DO UPDATE SET calls = ?'
            ).run(today(), ADJUSTMENT, correction, correction)
        },

        config
    }
}

exports.PRIORITY = PRIORITY
