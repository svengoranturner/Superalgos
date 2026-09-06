'use strict'

const { DatabaseSync } = require('node:sqlite')
const FS = require('node:fs')
const PATH = require('node:path')
const { MIGRATIONS } = require('./migrations.js')

/*
    Opens the database and brings it up to the current schema version.

    Uses node:sqlite - built into Node 22.5+ - so the tool has no native
    dependencies and drops onto a Raspberry Pi without a compiler.
*/
/*
    Ten seconds, not five.

    Five was under the observed worst case on this hardware: RECLASSIFY.run
    holds the write lock for roughly twenty thousand writes and is fired from
    a button in the dashboard, and the front page has been measured at nearly
    seven seconds cold. Ten covers a full rebuild with headroom and is still
    far inside any browser's patience. Deliberately not higher: past about ten
    seconds a request that is going to fail should fail visibly rather than
    hang, and the retry in inTransaction covers the busies no timeout can
    help with.
*/
const BUSY_TIMEOUT_MS = 10000

exports.newDatabase = function (filePath, options) {
    const config = Object.assign({ busyTimeoutMs: BUSY_TIMEOUT_MS }, options || {})

    if (filePath !== ':memory:') {
        FS.mkdirSync(PATH.dirname(filePath), { recursive: true })
    }

    const db = new DatabaseSync(filePath)

    /*
        EVERYTHING, AND IN THIS ORDER.

        busy_timeout is a per-CONNECTION setting and it used to be installed
        AFTER the journal switch below, so the switch itself ran at a timeout
        of zero. That switch takes a brief exclusive lock, and three
        long-running processes hold this file open - the collector, the
        dashboard and the eBay deletion endpoint - so a restart landing inside
        somebody else's write failed to switch and opened in DELETE mode
        instead, where a reader DOES block a writer. That is the exact failure
        WAL is here to prevent, and it was invisible, because PRAGMA
        journal_mode reports the mode it ended up in rather than whether it got
        the one you asked for. So it is checked now.
    */
    db.exec('PRAGMA busy_timeout = ' + Number(config.busyTimeoutMs))

    if (filePath !== ':memory:') {
        /*  WAL lets the dashboard read while the collector writes, which is
            the normal state of affairs here - the collector runs on a timer
            and the dashboard is opened at arbitrary moments. Persisted in the
            file header, so only the first open has to set it. */
        const got = db.prepare('PRAGMA journal_mode = WAL').get()
        const mode = String((got && got.journal_mode) || '').toLowerCase()
        if (mode !== 'wal') {
            throw new Error('Could not put ' + filePath + ' into WAL mode (it is in "' + mode +
                '"). Another process is probably mid-write; try again in a moment. Running in "' +
                mode + '" would mean a dashboard read blocks a collector write, which is the ' +
                'thing WAL is here to prevent.')
        }

        /*
            NORMAL, NOT THE FULL DEFAULT.

            Under WAL, FULL fsyncs the log on every commit; NORMAL fsyncs only
            when the log is checkpointed back into the database. What that
            changes is narrower than it sounds. On a PROCESS crash - node
            killed, an unhandled throw, the service restarted - nothing at all
            is lost: the log is an ordinary file the kernel still holds, and
            the next connection replays every committed transaction from it.
            What can be lost is only a power cut or a kernel panic: the commits
            that reached the page cache but not the card. The database is never
            corrupted either way, because WAL frames are checksummed, so a torn
            tail is discarded whole rather than half-applied - you lose recent
            transactions, never a mangled row.

            That is the right trade here. Everything the collector writes is a
            re-observable read of a live eBay search that the next sweep
            re-fetches within the hour, while the irreplaceable rows - the
            owner's labels and rules - are single writes made from a page that
            stays open, where a failure is visible. FULL was buying durability
            against a Raspberry Pi power cut, for data eBay will hand back, at
            the price of an fsync per commit on an SD card.
        */
        db.exec('PRAGMA synchronous = NORMAL')
    }

    migrate(db)

    return db
}

/*
    SQLITE_BUSY, OUT OF AN ERROR OBJECT THAT DOES NOT SAY "BUSY".

    node:sqlite throws a plain Error with code 'ERR_SQLITE_ERROR' for
    everything and puts the real result code on `errcode` - verified on
    v24.19, where a "no such table" arrives as { code: 'ERR_SQLITE_ERROR',
    errcode: 1, errstr: 'SQL logic error' }. So `errcode` is the field, not
    `code`, and it is masked to its low byte because SQLite may hand back an
    EXTENDED code: SQLITE_BUSY is 5, and BUSY_RECOVERY 261, BUSY_SNAPSHOT 517
    and BUSY_TIMEOUT 773 are all 5 in the low byte. SQLITE_LOCKED (6) is here
    because a table-level conflict reaches a caller as the same thing.

    The message test underneath is deliberate belt and braces: this reads a
    property of a built-in module still marked as evolving, and the failure
    mode of guessing wrong is a write silently dropped instead of retried,
    which is the exact bug this exists to fix.
*/
const BUSY_CODES = new Set([5, 6])
function isBusy (err) {
    if (err === null || typeof err !== 'object') { return false }
    if (Number.isInteger(err.errcode) && BUSY_CODES.has(err.errcode & 0xff)) { return true }
    return /database (?:table )?is locked/i.test(String(err.message || ''))
}
exports.isBusy = isBusy

/*  A synchronous sleep, because everything around it is synchronous. An async
    one would be a lie in a sync API, and a spin loop would burn the only core
    the Pi has. */
const SLEEPER = new Int32Array(new SharedArrayBuffer(4))
function sleep (ms) { Atomics.wait(SLEEPER, 0, 0, ms) }

/*
    ONE TRANSACTION HELPER FOR THE WHOLE APP.

    There were three copies of BEGIN/try/COMMIT/ROLLBACK - here, in
    reclassify.js and in repo.js - and none of them retried, took the lock up
    front, or could be nested.

    IMMEDIATE, NOT DEFERRED. This is the correction that matters most. A bare
    BEGIN takes the write lock at the first WRITE; every caller in this
    codebase reads first, and SQLite cannot honour busy_timeout on that
    upgrade - waiting would mean handing back a snapshot another connection
    has already contradicted - so it returns SQLITE_BUSY immediately, whatever
    the timeout says. Taking the lock up front is what makes busy_timeout mean
    anything at all here.

    RE-ENTRANT. db.isTransaction says whether one is already open, and an
    inner block joins it rather than throwing "cannot start a transaction
    within a transaction". Joining rather than SAVEPOINT, on purpose: a
    savepoint would let an inner block roll back part of an outer one, and no
    caller here wants half a batch applied.

    THE RETRY IS OUTSIDE THE TRANSACTION, AND THAT IS THE WHOLE POINT. A
    transaction that failed busy is already rolled back, so re-running it from
    BEGIN is correct by construction. A retry INSIDE would be re-running one
    statement of a unit whose other statements are gone.
*/
function inTransaction (db, work, options) {
    if (db.isTransaction) { return work() }

    const config = Object.assign({ attempts: 4, waitMs: 20, deadlineMs: 20000 }, options || {})
    const deadline = Date.now() + config.deadlineMs
    let wait = config.waitMs

    for (let attempt = 1; ; attempt++) {
        db.exec('BEGIN IMMEDIATE')
        try {
            const result = work()
            db.exec('COMMIT')
            return result
        } catch (err) {
            /*  Guarded: some failures unwind the transaction themselves, and
                a ROLLBACK with nothing to roll back throws over the top of the
                error that actually matters. */
            try { if (db.isTransaction) { db.exec('ROLLBACK') } } catch (ignored) { }

            /*  busy_timeout has already waited inside SQLite before this
                threw, so the backoff here is for the busies it cannot wait on
                - the deferred-upgrade and snapshot ones, which return at once.
                A deadline caps the total, because four attempts times a
                ten-second timeout is forty seconds and nobody is still
                holding the page. */
            if (!isBusy(err) || attempt >= config.attempts || Date.now() >= deadline) { throw err }
            sleep(wait)
            wait *= 2
        }
    }
}
exports.inTransaction = inTransaction

/*
    RESET THE LOG, OR GIVE UP AT ONCE - NEVER WAIT.

    wal_autocheckpoint has been running all along and has never reset the
    file. A PASSIVE checkpoint copies pages back into the database but can
    only rewind the log when no reader holds it, and with the dashboard and
    the deletion endpoint both open there is nearly always one. So the log
    reached 149 MB against a 4 MB threshold on a 635 MB database - and every
    reader pays for that, because a log that size is a WAL index that size.
    A slow read is then itself a window in which no checkpoint can rewind, so
    the two feed each other.

    TRUNCATE is the only mode that resets the file, and also the only one that
    will block on a reader - so this connection is given the shortest temper
    in the system for the duration. A busy result is not an error; it is
    "somebody is reading, try after the next sweep".
*/
function checkpoint (db) {
    /*  :memory: has no log, and location() returns null there. */
    if (db.location() === null) { return null }

    const restore = db.prepare('PRAGMA busy_timeout').get().timeout
    db.exec('PRAGMA busy_timeout = 400')
    try {
        /*  busy=1 means it gave up. `log` and `checkpointed` are in PAGES,
            and log === 0 is the ONLY proof the file was reset: a checkpoint
            that copied every page but could not rewind reports busy=0 with a
            non-zero log, which is precisely the state that has been happening
            unnoticed for months. Telling those two apart is the whole reason
            this reads the result rather than using exec(). */
        return db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get()
    } finally {
        db.exec('PRAGMA busy_timeout = ' + restore)
    }
}
exports.checkpoint = checkpoint

function migrate (db) {

    db.exec('CREATE TABLE IF NOT EXISTS schema_version (idx INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')

    const applied = new Set(
        db.prepare('SELECT name FROM schema_version').all().map(r => r.name)
    )

    for (let i = 0; i < MIGRATIONS.length; i++) {
        const migration = MIGRATIONS[i]
        if (applied.has(migration.name)) { continue }

        /*  Through the shared helper, so a migration gets BEGIN IMMEDIATE
            and the retry like everything else. Startup is the worst possible
            place for a deferred begin: three processes can come up at once
            after a reboot, and the loser used to throw its way out of the
            service rather than wait. */
        try {
            inTransaction(db, () => {
                db.exec(migration.sql)
                db.prepare('INSERT INTO schema_version (idx, name, applied_at) VALUES (?, ?, ?)')
                    .run(i, migration.name, new Date().toISOString())
            })
        } catch (err) {
            throw new Error('Migration ' + migration.name + ' failed: ' + err.message)
        }
    }
}
