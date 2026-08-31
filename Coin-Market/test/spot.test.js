'use strict'

const test = require('node:test')
const assert = require('node:assert')

const SPOT = require('../src/spot/spot.js')

/*
    The portfolio app on the Pi turned out to keep spot in PostgreSQL, in a
    Docker container, in GBP per GRAM - not in a SQLite file in GBP per ounce
    as the original reader assumed. These cover the reader written for what is
    actually there. The database itself is not needed: the source takes an
    injectable runner, so everything below the psql process boundary is tested
    without one.
*/

function fakePsql (output) {
    const calls = []
    const run = command => { calls.push(command); return output }
    return { run, calls }
}

const TICKS = [
    '2026-08-27T13:40:12.334Z,108.0912,tick',
    '2026-08-27T14:00:35.691Z,108.1434,tick',
    ''
].join('\n')

test('grams are converted to troy ounces, because everything downstream prices per ounce', () => {
    const psql = fakePsql(TICKS)
    const source = SPOT.newSpotSource({
        type: 'postgres', projectDir: '/somewhere', database: 'metalstack', user: 'metalstack',
        run: psql.run
    })

    const rows = source.readSince('2026-08-01T00:00:00.000Z')

    assert.strictEqual(rows.length, 2)
    /* 108.1434 GBP/g x 31.1034768 g/oz - a sovereign's spot value of its gold depends on
       getting this exactly right, so assert the number, not the ballpark. */
    assert.ok(Math.abs(rows[1].gbpPerOz - 108.1434 * 31.1034768) < 1e-9)
    assert.strictEqual(rows[1].observedAt, '2026-08-27T14:00:35.691Z')
    assert.strictEqual(rows[1].source, 'metals.dev')
})

test('a store that already keeps ounces is not scaled twice', () => {
    const psql = fakePsql(TICKS)
    const source = SPOT.newSpotSource({ type: 'postgres', units: 'gbp_per_oz', run: psql.run })
    assert.ok(Math.abs(source.readSince('2026-08-01T00:00:00.000Z')[1].gbpPerOz - 108.1434) < 1e-9)
})

test('the connection is opened read-only, so this tool cannot corrupt the portfolio store', () => {
    const psql = fakePsql(TICKS)
    const source = SPOT.newSpotSource({
        type: 'postgres', projectDir: '/apps/metal-stack', service: 'db', run: psql.run
    })
    source.readSince('2026-08-01T00:00:00.000Z')

    const command = psql.calls[0]
    const readOnly = command.args.concat(Object.values(command.env))
        .some(value => String(value).includes('default_transaction_read_only=on'))
    assert.ok(readOnly, 'expected default_transaction_read_only=on to reach libpq')
})

test('the since bound and metal go to psql as variables, never spliced into SQL', () => {
    /* A value that would end the string literal it was pasted into. psql's
       :'var' quoting is what keeps this harmless. */
    const psql = fakePsql('')
    const source = SPOT.newSpotSource({ type: 'postgres', metalValue: "Au'; DROP TABLE spot_tick; --", run: psql.run })
    source.readSince('2026-08-01T00:00:00.000Z')

    const command = psql.calls[0]
    const sql = command.input
    assert.ok(!sql.includes('DROP TABLE'), 'the metal value must not reach the SQL text')
    assert.ok(command.args.includes("metal=Au'; DROP TABLE spot_tick; --"))
    assert.ok(command.args.includes('since=2026-08-01T00:00:00.000Z'))
})

test('a table name that is not an identifier is refused rather than concatenated', () => {
    assert.throws(
        () => SPOT.newSpotSource({ type: 'postgres', tick: { table: 'spot_tick; DROP TABLE spot_price' } }),
        /identifier/i
    )
})

test('daily history is left out unless asked for, and marked coarse when it is', () => {
    const withoutDaily = SPOT.buildSpotSql({
        tick: { table: 'spot_tick', observedAt: 'priced_at', value: 'gbp_per_g', metal: 'metal' },
        daily: { table: 'spot_history', observedOn: 'priced_on', value: 'gbp_per_g', metal: 'metal' },
        includeDaily: false
    })
    assert.ok(!withoutDaily.includes('spot_history'))

    const psql = fakePsql([
        '2026-07-04T12:00:00.000Z,101.5000,daily',
        '2026-08-27T14:00:35.691Z,108.1434,tick',
        ''
    ].join('\n'))
    const source = SPOT.newSpotSource({ type: 'postgres', includeDaily: true, run: psql.run })
    const rows = source.readSince('2026-01-01T00:00:00.000Z')

    /* A daily close has no real intraday timestamp. It carries a different
       source string so a premium priced off one is visible as such rather
       than passing for a 20-minute observation. */
    assert.strictEqual(rows[0].source, 'metals.dev-daily')
    assert.strictEqual(rows[1].source, 'metals.dev')

    const sql = psql.calls[0].input
    assert.ok(sql.includes('UNION ALL'))
    /* Daily rows only for the stretch before the tick series starts - where
       both exist the intraday number is strictly better. */
    assert.ok(sql.includes('MIN(priced_at)'))
})

test('psql CSV parses, including the quoting it applies to awkward values', () => {
    const rows = SPOT.parsePsqlCsv('a,b,c\n"x,y",2,"he said ""hi"""\n')
    assert.deepStrictEqual(rows, [['a', 'b', 'c'], ['x,y', '2', 'he said "hi"']])
})

test('an empty result is no observations, not a crash', () => {
    const psql = fakePsql('\n')
    const source = SPOT.newSpotSource({ type: 'postgres', run: psql.run })
    assert.deepStrictEqual(source.readSince('2026-08-01T00:00:00.000Z'), [])
})

test('a row psql could not price is dropped rather than mirrored as zero', () => {
    const psql = fakePsql('2026-08-27T14:00:35.691Z,,tick\n2026-08-27T14:20:35.691Z,108.14,tick\n')
    const source = SPOT.newSpotSource({ type: 'postgres', run: psql.run })
    assert.strictEqual(source.readSince('2026-08-01T00:00:00.000Z').length, 1)
})

test('the docker compose route runs in the portfolio app project directory', () => {
    const psql = fakePsql('')
    const source = SPOT.newSpotSource({
        type: 'postgres', projectDir: '/home/stacker/apps/metal-stack',
        service: 'db', user: 'metalstack', database: 'metalstack', run: psql.run
    })
    source.readSince('2026-08-01T00:00:00.000Z')

    const command = psql.calls[0]
    assert.strictEqual(command.file, 'docker')
    assert.strictEqual(command.cwd, '/home/stacker/apps/metal-stack')
    assert.deepStrictEqual(command.args.slice(0, 4), ['compose', 'exec', '-T', '-e'])
    assert.ok(command.args.includes('metalstack'))
})

test('the SQL goes in on stdin, because psql does not interpolate variables in -c', () => {
    const psql = fakePsql('')
    const source = SPOT.newSpotSource({ type: 'postgres', run: psql.run })
    source.readSince('2026-08-01T00:00:00.000Z')

    const command = psql.calls[0]
    assert.ok(!command.args.includes('-c'), 'a -c string would reach the server with the colons intact')
    assert.deepStrictEqual(command.args.slice(-2), ['-f', '-'])
    assert.ok(command.input.includes(":'since'"), 'the variable reference belongs in the script psql lexes')
})

test('a local psql is used directly when there is no container in the way', () => {
    const psql = fakePsql('')
    const source = SPOT.newSpotSource({
        type: 'postgres', via: 'psql', host: '127.0.0.1', port: 5432,
        user: 'metalstack', database: 'metalstack', run: psql.run
    })
    source.readSince('2026-08-01T00:00:00.000Z')

    const command = psql.calls[0]
    assert.strictEqual(command.file, 'psql')
    assert.deepStrictEqual(command.args.slice(0, 4), ['-h', '127.0.0.1', '-p', '5432'])
})

test('an unknown source type names the ones that exist', () => {
    assert.throws(() => SPOT.newSpotSource({ type: 'mysql' }), /postgres/)
})

/*
    Market hours.

    eBay does not keep them and metals do. Auctions close all weekend while
    spot has not moved since Friday, so a tolerance that knows nothing about
    the closure withholds a premium for about fifty hours a week - including
    Sunday evening, which is prime auction-closing time.
*/

test('the metals week runs Sunday evening to Friday evening, London time', () => {
    /* Friday 2026-08-28: trading until 22:00 London, shut after. */
    assert.strictEqual(SPOT.marketClosedAt('2026-08-28T20:00:00Z'), false, 'Friday 21:00 London')
    assert.strictEqual(SPOT.marketClosedAt('2026-08-28T21:30:00Z'), true, 'Friday 22:30 London')
    /* Saturday is shut throughout. */
    assert.strictEqual(SPOT.marketClosedAt('2026-08-29T12:00:00Z'), true)
    /* Sunday: shut until 23:00 London, trading after. */
    assert.strictEqual(SPOT.marketClosedAt('2026-08-30T12:00:00Z'), true, 'Sunday midday')
    assert.strictEqual(SPOT.marketClosedAt('2026-08-30T22:30:00Z'), false, 'Sunday 23:30 London')
    /* Midweek is open. */
    assert.strictEqual(SPOT.marketClosedAt('2026-08-26T03:00:00Z'), false)
})

const { newDatabase: newSpotDb } = require('../src/store/db.js')

function spotDb (rows) {
    const db = newSpotDb(':memory:')
    for (const [observedAt, price] of rows) {
        db.prepare('INSERT INTO spot (metal, observed_at, gbp_per_oz, source) VALUES (?,?,?,?)')
            .run('XAU', observedAt, price, 'metals.dev')
    }
    return db
}

/* Friday 2026-08-28 20:41Z - the last tick before the weekend close. */
function lookupFixture () {
    return spotDb([['2026-08-28T20:41:00.000Z', 3292.21]])
}

test('a weekend lot is priced off the Friday close, and says so', () => {
    const db = lookupFixture()
    const spotAt = SPOT.newSpotLookup(db, { toleranceMinutes: 90 })
    const sunday = spotAt('2026-08-30T12:00:00Z')
    assert.ok(sunday !== null, 'a shut market should not read as a missing price')
    assert.strictEqual(sunday.gbpPerOz, 3292.21)
    assert.strictEqual(sunday.carried, true)
    db.close()
})

test('a price inside tolerance is not marked as carried', () => {
    const db = lookupFixture()
    const spotAt = SPOT.newSpotLookup(db, { toleranceMinutes: 90 })
    const friday = spotAt('2026-08-28T21:00:00Z')
    assert.ok(friday !== null)
    assert.strictEqual(friday.carried, false)
    db.close()
})

/*  The whole point of the tight tolerance is catching a dead feed. A closure
    must not become a licence to serve week-old prices midweek. */
test('a midweek gap still withholds the premium', () => {
    const db = lookupFixture()
    const spotAt = SPOT.newSpotLookup(db, { toleranceMinutes: 90 })
    assert.strictEqual(spotAt('2026-09-02T12:00:00Z'), null, 'Wednesday, feed long dead')
    db.close()
})

test('a closure does not resurrect a price older than the closure itself', () => {
    /* Two weekends back - shut now, but this is a broken feed, not a closure. */
    const db = spotDb([['2026-08-14T20:41:00.000Z', 3200.00]])
    const spotAt = SPOT.newSpotLookup(db, { toleranceMinutes: 90 })
    assert.strictEqual(spotAt('2026-08-30T12:00:00Z'), null)
    db.close()
})

/*  Monday's open says nothing about Saturday's value. */
test('prices are only ever carried forward, never backwards', () => {
    const db = spotDb([['2026-08-31T06:00:00.000Z', 3300.00]])
    const spotAt = SPOT.newSpotLookup(db, { toleranceMinutes: 90 })
    assert.strictEqual(spotAt('2026-08-29T12:00:00Z'), null, 'Saturday must not borrow Monday')
    db.close()
})

/*  The whole reason the metal is a parameter.

    A Morgan dollar holds 0.7734 oz of silver. Priced against silver at
    roughly GBP 26/oz it is worth about GBP 20; priced against gold at
    GBP 3,290/oz the same coin reads GBP 2,545 - so a lot asking GBP 30
    would show as 98% BELOW spot, which is not a small error but the single
    most attractive-looking number the tool could possibly print.

    So a metal with no ticks returns null, and null is rendered as a blank.
    Never the nearest other metal, never a fallback. */
test('a metal with no observations returns nothing, never another metal price', () => {
    const { newDatabase } = require('../src/store/db.js')
    const SPOT = require('../src/spot/spot.js')
    const db = newDatabase(':memory:')
    const when = '2026-08-31T12:00:00.000Z'

    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(when, 'XAU', 3290, null, 'test')

    const spotAt = SPOT.newSpotLookup(db)
    assert.strictEqual(spotAt(when).gbpPerOz, 3290, 'gold is still the default')
    assert.strictEqual(spotAt(when, 'XAU').gbpPerOz, 3290)
    assert.strictEqual(spotAt(when, 'XAG'), null, 'silver has no ticks: blank, not gold')

    /*  And once silver arrives, the two are kept apart. */
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run(when, 'XAG', 26.4, null, 'test')
    assert.strictEqual(spotAt(when, 'XAG').gbpPerOz, 26.4)
    assert.strictEqual(spotAt(when, 'XAU').gbpPerOz, 3290)
    db.close()
})

/*  Each metal backfills from its own high-water mark. Sharing gold's would
    make silver start at today and never acquire a history at all. */
test('mirroring a second metal does not inherit the first metal high-water mark', async () => {
    const { newDatabase } = require('../src/store/db.js')
    const SPOT = require('../src/spot/spot.js')
    const db = newDatabase(':memory:')
    db.prepare('INSERT INTO spot (observed_at, metal, gbp_per_oz, usd_per_oz, source) VALUES (?,?,?,?,?)')
        .run('2026-08-30T00:00:00.000Z', 'XAU', 3290, null, 'test')

    const asked = []
    const source = { readSince: async (since) => { asked.push(since); return [] } }

    await SPOT.mirror(db, source, { metal: 'XAU', backfillDays: 400 })
    await SPOT.mirror(db, source, { metal: 'XAG', backfillDays: 400 })

    assert.strictEqual(asked[0], '2026-08-30T00:00:00.000Z', 'gold resumes from its last tick')
    assert.ok(asked[1] < '2026-08-01', 'silver backfills from scratch, not from gold: ' + asked[1])
    db.close()
})
