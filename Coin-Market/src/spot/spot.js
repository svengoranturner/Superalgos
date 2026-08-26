'use strict'

const FS = require('node:fs')

const DAY_MS = 24 * 60 * 60 * 1000

/*
    Gold spot, sourced from the metals.dev feed the portfolio app already
    runs on the same Pi.

    We deliberately do NOT poll metals.dev ourselves. Two independent
    pollers would drift apart, and then the portfolio and the coin tracker
    would quote different premiums for the same metal on the same day -
    a discrepancy that is maddening to debug and quietly corrosive to
    trust in both tools. One feed, one number.

    The concrete shape of the portfolio store is configurable because it
    is the one thing about your setup this code cannot know in advance.
    Everything downstream depends only on the SpotSource contract:

        readSince(isoTimestamp) -> [{ observedAt, gbpPerOz, usdPerOz, source }]
*/

exports.newSpotSource = function (config) {
    const spec = config || {}
    switch (spec.type) {
        case 'sqlite': return newSqliteSource(spec)
        case 'json':   return newJsonSource(spec)
        case 'http':   return newHttpSource(spec)
        default:
            throw new Error('Unknown spot source type: ' + spec.type +
                ' (expected sqlite, json or http)')
    }
}

/*
    Reads directly from the portfolio app's SQLite database. Column names
    are configurable so we adapt to its schema rather than asking it to
    change. Opened read-only - this tool must never be able to corrupt the
    portfolio app's data.
*/
function newSqliteSource (spec) {
    const { DatabaseSync } = require('node:sqlite')

    const table = spec.table || 'spot'
    const columns = Object.assign(
        { observedAt: 'observed_at', gbpPerOz: 'gbp_per_oz', usdPerOz: 'usd_per_oz', metal: 'metal' },
        spec.columns || {}
    )

    return {
        describe: () => 'sqlite:' + spec.path + '#' + table,
        readSince (sinceIso) {
            const db = new DatabaseSync(spec.path, { readOnly: true })
            try {
                const where = [columns.observedAt + ' >= ?']
                const params = [sinceIso]
                if (spec.metalValue !== undefined) {
                    where.push(columns.metal + ' = ?')
                    params.push(spec.metalValue)
                }
                const sql = 'SELECT ' + columns.observedAt + ' AS observedAt, ' +
                    columns.gbpPerOz + ' AS gbpPerOz, ' +
                    columns.usdPerOz + ' AS usdPerOz FROM ' + table +
                    ' WHERE ' + where.join(' AND ') +
                    ' ORDER BY ' + columns.observedAt + ' ASC'
                return db.prepare(sql).all(...params).map(normaliseRow)
            } finally {
                db.close()
            }
        }
    }
}

/* Reads a JSON file the portfolio app writes - an array of observations,
   or an object keyed by timestamp. */
function newJsonSource (spec) {
    const fields = Object.assign(
        { observedAt: 'timestamp', gbpPerOz: 'gbp', usdPerOz: 'usd' },
        spec.fields || {}
    )
    return {
        describe: () => 'json:' + spec.path,
        readSince (sinceIso) {
            const raw = JSON.parse(FS.readFileSync(spec.path, 'utf8'))
            const rows = Array.isArray(raw) ? raw : Object.values(raw)
            const since = new Date(sinceIso).getTime()
            return rows
                .map(row => normaliseRow({
                    observedAt: row[fields.observedAt],
                    gbpPerOz: row[fields.gbpPerOz],
                    usdPerOz: row[fields.usdPerOz]
                }))
                .filter(row => row !== null && new Date(row.observedAt).getTime() >= since)
                .sort((a, b) => new Date(a.observedAt) - new Date(b.observedAt))
        }
    }
}

/*
    Reads over HTTPS - for the case where the tracker does not sit on the
    same box as the portfolio app. Supports Cloudflare Access service
    tokens so a headless process can get through the gate.
*/
function newHttpSource (spec) {
    return {
        describe: () => 'http:' + spec.url,
        async readSince (sinceIso) {
            const url = new URL(spec.url)
            url.searchParams.set('since', sinceIso)

            const headers = Object.assign({ accept: 'application/json' }, spec.headers || {})
            if (spec.cloudflareClientId !== undefined) {
                headers['CF-Access-Client-Id'] = spec.cloudflareClientId
                headers['CF-Access-Client-Secret'] = spec.cloudflareClientSecret
            }

            const response = await fetch(url, { headers })
            if (!response.ok) {
                throw new Error('Spot feed returned HTTP ' + response.status + ' from ' + spec.url)
            }
            const payload = await response.json()
            const rows = Array.isArray(payload) ? payload : (payload.data || payload.observations || [])
            return rows.map(normaliseRow).filter(row => row !== null)
        }
    }
}

function normaliseRow (row) {
    if (row === null || row === undefined) { return null }
    const observedAt = toIso(row.observedAt)
    const gbpPerOz = Number(row.gbpPerOz)
    if (observedAt === null || !Number.isFinite(gbpPerOz) || gbpPerOz <= 0) { return null }
    return {
        observedAt,
        gbpPerOz,
        usdPerOz: Number.isFinite(Number(row.usdPerOz)) ? Number(row.usdPerOz) : null,
        source: 'metals.dev'
    }
}

function toIso (value) {
    if (value === null || value === undefined) { return null }
    /* Accept ISO strings, epoch seconds and epoch milliseconds. */
    if (typeof value === 'number') {
        const ms = value > 1e11 ? value : value * 1000
        const date = new Date(ms)
        return Number.isNaN(date.getTime()) ? null : date.toISOString()
    }
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

exports.toIso = toIso
exports.normaliseRow = normaliseRow

/* ------------------------------------------------------------ mirror */

/*
    Copies new observations into our own spot table. Mirroring rather than
    querying the portfolio store on every read means analytics has one
    place to look, and our premium history survives the portfolio app
    rotating or compacting its own data.
*/
exports.mirror = async function (db, source, options) {
    const config = Object.assign({ backfillDays: 400 }, options || {})

    const latest = db.prepare('SELECT MAX(observed_at) AS latest FROM spot WHERE metal = ?').get('XAU')
    const since = latest && latest.latest
        ? latest.latest
        : new Date(Date.now() - config.backfillDays * DAY_MS).toISOString()

    const rows = await source.readSince(since)

    const insert = db.prepare(
        'INSERT OR IGNORE INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?, ?, ?, ?, ?)'
    )

    let inserted = 0
    db.exec('BEGIN')
    try {
        for (const row of rows) {
            const result = insert.run(row.observedAt, 'XAU', row.gbpPerOz, row.usdPerOz, row.source)
            inserted += result.changes
        }
        db.exec('COMMIT')
    } catch (err) {
        db.exec('ROLLBACK')
        throw err
    }

    return { read: rows.length, inserted, since }
}

/* ------------------------------------------------------------ lookup */

/*
    Spot at a moment in time - specifically, at the moment an auction
    closed, which is what a premium must be measured against.

    Returns null when no observation lies within tolerance. That null
    propagates: the observation is recorded as having no premium rather
    than being silently priced against a stale figure. A gap in the gold
    feed must never quietly corrupt price history.
*/
exports.newSpotLookup = function (db, options) {
    const config = Object.assign({ toleranceMinutes: 90 }, options || {})
    const toleranceMs = config.toleranceMinutes * 60 * 1000

    const before = db.prepare(
        'SELECT observed_at, gbp_per_oz FROM spot WHERE metal = ? AND observed_at <= ? ORDER BY observed_at DESC LIMIT 1'
    )
    const after = db.prepare(
        'SELECT observed_at, gbp_per_oz FROM spot WHERE metal = ? AND observed_at >= ? ORDER BY observed_at ASC LIMIT 1'
    )

    return function spotAt (whenIso) {
        const target = new Date(whenIso).getTime()
        if (!Number.isFinite(target)) { return null }

        const candidates = [before.get('XAU', whenIso), after.get('XAU', whenIso)].filter(Boolean)
        let best = null
        let bestGap = Infinity

        for (const candidate of candidates) {
            const gap = Math.abs(new Date(candidate.observed_at).getTime() - target)
            if (gap < bestGap) { bestGap = gap; best = candidate }
        }

        if (best === null || bestGap > toleranceMs) { return null }
        return { gbpPerOz: best.gbp_per_oz, observedAt: best.observed_at, gapMinutes: bestGap / 60000 }
    }
}
