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
        case 'sqlite':   return newSqliteSource(spec)
        case 'postgres': return newPostgresSource(spec)
        case 'json':     return newJsonSource(spec)
        case 'http':     return newHttpSource(spec)
        default:
            throw new Error('Unknown spot source type: ' + spec.type +
                ' (expected sqlite, postgres, json or http)')
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

/*
    Reads the portfolio app's PostgreSQL store by shelling out to psql.

    Two things about the real setup forced this, and neither was known when
    the sqlite reader above was written:

      * the portfolio app (metal-stack) keeps spot in PostgreSQL, inside a
        Docker container, not in a SQLite file on disk; and
      * it stores GBP per GRAM, while everything downstream here works in
        GBP per troy ounce.

    Shelling out to psql rather than adding a driver keeps the zero-dependency
    promise that makes this tool installable on a Pi with no compiler. It is
    also still a local read - no HTTP, no domain, no Cloudflare - which was
    the whole reason for putting this tool on the same machine.

    The connection is opened read-only at the libpq level (PGOPTIONS sets
    default_transaction_read_only), so a bug here cannot corrupt the
    portfolio app's data even though the role it connects as could.

    Two series live in that database:

      * spot_tick    - appended every refresh, ~20 minute cadence. This is
                       the analogue of what the sqlite reader expected, and
                       the only series fine-grained enough to price a lot
                       against the moment it closed.
      * spot_history - one row per day, going back decades. Read only when
                       includeDaily is set, and only for dates before the
                       tick series begins. A daily close has no true intraday
                       timestamp, so those rows are stamped at dailyHourUtc
                       and marked 'metals.dev-daily' in the source column -
                       visibly coarser, never silently mixed in.
*/
function newPostgresSource (spec) {
    const gramsPerOz = spec.gramsPerOz === undefined ? 31.1034768 : Number(spec.gramsPerOz)
    const scale = spec.units === 'gbp_per_oz' ? 1 : gramsPerOz
    const metal = spec.metalValue === undefined ? 'Au' : spec.metalValue
    const includeDaily = spec.includeDaily === true

    const tick = Object.assign(
        { table: 'spot_tick', observedAt: 'priced_at', value: 'gbp_per_g', metal: 'metal' },
        spec.tick || {}
    )
    const daily = Object.assign(
        { table: 'spot_history', observedOn: 'priced_on', value: 'gbp_per_g', metal: 'metal' },
        spec.daily || {}
    )

    /* psql quotes VALUES for us via :'var', but never identifiers. Table and
       column names come from settings.json, so they are checked rather than
       trusted. */
    for (const name of [tick.table, tick.observedAt, tick.value, tick.metal,
        daily.table, daily.observedOn, daily.value, daily.metal]) {
        assertIdentifier(name)
    }

    const sql = buildSpotSql({ tick, daily, includeDaily, dailyHourUtc: spec.dailyHourUtc })
    const run = spec.run || runPsql   /* injectable so this is testable without a database */

    return {
        describe () {
            const where = spec.via === 'psql'
                ? (spec.host || 'localhost') + '/' + (spec.database || 'postgres')
                : (spec.service || 'db') + ':' + (spec.database || 'postgres') + ' in ' + (spec.projectDir || '.')
            return 'postgres:' + where + '#' + tick.table + (includeDaily ? '+' + daily.table : '')
        },
        readSince (sinceIso) {
            const command = buildPsqlCommand(spec, sql, { since: sinceIso, metal })
            const text = run(command)
            return parsePsqlCsv(text)
                .map(fields => normaliseRow({
                    observedAt: fields[0],
                    gbpPerOz: Number(fields[1]) * scale,
                    source: fields[2] === 'daily' ? 'metals.dev-daily' : 'metals.dev'
                }))
                .filter(row => row !== null)
        }
    }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

function assertIdentifier (name) {
    if (!IDENTIFIER.test(String(name))) {
        throw new Error('Not a usable PostgreSQL identifier: ' + name +
            ' (letters, digits and underscore only - it goes into SQL unquoted)')
    }
}

/*
    Timestamps come back formatted rather than in psql's default rendering,
    because "2026-08-27 14:00:35.68+00" is not ISO 8601 and what a Date
    constructor makes of it is a matter of opinion. Ask for the one shape
    that is not.
*/
function buildSpotSql (options) {
    const tick = options.tick
    const daily = options.daily
    const hour = Number.isFinite(Number(options.dailyHourUtc)) ? Number(options.dailyHourUtc) : 12
    const stamp = String(hour).padStart(2, '0') + ':00:00.000'

    const ticks =
        'SELECT to_char(' + tick.observedAt + ' AT TIME ZONE \'UTC\', \'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"\'),' +
        ' ' + tick.value + '::float8, \'tick\'' +
        ' FROM ' + tick.table +
        ' WHERE ' + tick.metal + ' = :\'metal\' AND ' + tick.observedAt + ' >= :\'since\'::timestamptz'

    if (!options.includeDaily) { return ticks + ' ORDER BY 1' }

    /* Only for the stretch before the tick series starts: where both exist
       the intraday number is strictly better, and two rows for one day would
       just give the nearest-observation lookup a worse candidate to pick. */
    const days =
        'SELECT to_char(' + daily.observedOn + ', \'YYYY-MM-DD"T"' + stamp + '"Z"\'),' +
        ' ' + daily.value + '::float8, \'daily\'' +
        ' FROM ' + daily.table +
        ' WHERE ' + daily.metal + ' = :\'metal\'' +
        ' AND ' + daily.observedOn + ' >= (:\'since\'::timestamptz AT TIME ZONE \'UTC\')::date' +
        ' AND ' + daily.observedOn + ' < (SELECT COALESCE(MIN(' + tick.observedAt + ') AT TIME ZONE \'UTC\', \'infinity\')::date' +
        ' FROM ' + tick.table + ' WHERE ' + tick.metal + ' = :\'metal\')'

    return ticks + ' UNION ALL ' + days + ' ORDER BY 1'
}

/*
    The SQL goes in on stdin rather than after -c. psql only performs :'var'
    interpolation while lexing script input; a -c string is passed to the
    server untouched, so the variables would arrive as literal colons and the
    server would reject them. Feeding stdin is what keeps psql - rather than
    string concatenation here - responsible for quoting the values.

    -X     ignore ~/.psqlrc, which could otherwise turn on a pager or change
           the output format under us
    -t     no header and no row count, just tuples
    --csv  quoting we can parse unambiguously
    -f -   read the script from standard input
*/
function buildPsqlCommand (spec, sql, params) {
    const psqlArgs = [
        '-X', '-q', '-t', '--csv',
        '-v', 'ON_ERROR_STOP=1',
        '-v', 'since=' + params.since,
        '-v', 'metal=' + params.metal,
        '-U', spec.user || 'postgres',
        '-d', spec.database || 'postgres',
        '-f', '-'
    ]

    const readOnly = '-c default_transaction_read_only=on'

    if (Array.isArray(spec.command) && spec.command.length > 0) {
        return {
            file: spec.command[0],
            args: spec.command.slice(1).concat(psqlArgs),
            cwd: spec.projectDir,
            env: { PGOPTIONS: readOnly },
            input: sql
        }
    }

    if (spec.via === 'psql') {
        const connection = []
        if (spec.host !== undefined) { connection.push('-h', String(spec.host)) }
        if (spec.port !== undefined) { connection.push('-p', String(spec.port)) }
        return {
            file: spec.psql || 'psql',
            args: connection.concat(psqlArgs),
            cwd: spec.projectDir,
            env: { PGOPTIONS: readOnly },
            input: sql
        }
    }

    /* Default: the portfolio app's own compose project, which is where its
       database actually lives and the only place its credentials are already
       set up. */
    return {
        file: spec.docker || 'docker',
        args: ['compose', 'exec', '-T', '-e', 'PGOPTIONS=' + readOnly, spec.service || 'db', 'psql']
            .concat(psqlArgs),
        cwd: spec.projectDir,
        env: {},
        input: sql
    }
}

function runPsql (command) {
    const { spawnSync } = require('node:child_process')
    const result = spawnSync(command.file, command.args, {
        input: command.input,
        cwd: command.cwd,
        env: Object.assign({}, process.env, command.env),
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024
    })

    if (result.error) {
        throw new Error('Could not run ' + command.file + ': ' + result.error.message)
    }
    if (result.status !== 0) {
        throw new Error(command.file + ' exited ' + result.status + ': ' +
            String(result.stderr || '').trim())
    }
    return result.stdout
}

/* psql --csv quotes any field containing a comma, quote or newline, and
   doubles embedded quotes. Small enough to parse honestly. */
function parsePsqlCsv (text) {
    const rows = []
    let fields = []
    let field = ''
    let quoted = false
    let started = false

    for (let i = 0; i < text.length; i++) {
        const char = text[i]
        if (quoted) {
            if (char === '"') {
                if (text[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
            } else { field += char }
            continue
        }
        if (char === '"') { quoted = true; started = true; continue }
        if (char === ',') { fields.push(field); field = ''; started = true; continue }
        if (char === '\n' || char === '\r') {
            if (started || field.length > 0 || fields.length > 0) {
                fields.push(field)
                rows.push(fields)
                fields = []
                field = ''
                started = false
            }
            if (char === '\r' && text[i + 1] === '\n') { i++ }
            continue
        }
        field += char
        started = true
    }
    if (started || field.length > 0 || fields.length > 0) { fields.push(field); rows.push(fields) }
    return rows
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
        source: row.source || 'metals.dev'
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
exports.buildSpotSql = buildSpotSql
exports.buildPsqlCommand = buildPsqlCommand
exports.parsePsqlCsv = parsePsqlCsv

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
/*
    Is the metals market shut at this instant?

    Metals trade from about 23:00 Sunday to 22:00 Friday, London time - the
    week runs Sunday evening to Friday evening, not Monday to Friday. That is
    the same window the portfolio app's refresh timer uses, and it is stated
    in London time on purpose: New York's 18:00 open is 23:00 in London in
    both BST and GMT, because both clocks shift together.

    This matters because eBay does not keep market hours. Auctions close all
    weekend - Sunday evening is prime closing time - while spot has not moved
    since Friday. Without knowing the difference, every weekend lot looks like
    a feed outage and gets no premium at all, which is roughly fifty hours a
    week of blindness.
*/
const LONDON = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
})

exports.marketClosedAt = function (whenIso) {
    const date = new Date(whenIso)
    if (!Number.isFinite(date.getTime())) { return false }

    const parts = {}
    for (const part of LONDON.formatToParts(date)) { parts[part.type] = part.value }

    const minutes = Number(parts.hour) * 60 + Number(parts.minute)
    if (parts.weekday === 'Sat') { return true }
    if (parts.weekday === 'Fri') { return minutes >= 22 * 60 }
    if (parts.weekday === 'Sun') { return minutes < 23 * 60 }
    return false
}

exports.newSpotLookup = function (db, options) {
    const config = Object.assign({
        toleranceMinutes: 90,
        /*  How far back the Friday close may be carried across a closure.
            The gap itself is about 49 hours; this leaves margin for the last
            tick landing shortly before the close, and no more. Beyond it we
            are not looking at a shut market, we are looking at a broken feed,
            and the answer to that is still no price rather than a stale one. */
        closureCarryMinutes: 54 * 60
    }, options || {})
    const toleranceMs = config.toleranceMinutes * 60 * 1000
    const carryMs = config.closureCarryMinutes * 60 * 1000

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

        if (best !== null && bestGap <= toleranceMs) {
            return { gbpPerOz: best.gbp_per_oz, observedAt: best.observed_at, gapMinutes: bestGap / 60000, carried: false }
        }

        /*  Nothing close enough. If the market was shut at that moment, the
            last price before it is not a stale reading - it is the price,
            because nothing traded since. Carried forward only, never back:
            Monday's open says nothing about what a lot was worth on Saturday.

            Flagged as carried so a consumer can show it as such, in the same
            spirit as marking daily closes coarser than intraday ticks. */
        if (!exports.marketClosedAt(whenIso)) { return null }

        const carried = before.get('XAU', whenIso)
        if (!carried) { return null }

        const carriedGap = target - new Date(carried.observed_at).getTime()
        if (!(carriedGap >= 0) || carriedGap > carryMs) { return null }

        return {
            gbpPerOz: carried.gbp_per_oz,
            observedAt: carried.observed_at,
            gapMinutes: carriedGap / 60000,
            carried: true
        }
    }
}
