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
exports.newDatabase = function (filePath) {

    if (filePath !== ':memory:') {
        FS.mkdirSync(PATH.dirname(filePath), { recursive: true })
    }

    const db = new DatabaseSync(filePath)

    /*
        WAL lets the dashboard read while the collector writes, which is the
        normal state of affairs here - the collector runs on a timer and the
        dashboard is opened at arbitrary moments.
    */
    if (filePath !== ':memory:') { db.exec('PRAGMA journal_mode = WAL') }
    db.exec('PRAGMA busy_timeout = 5000')

    migrate(db)

    return db
}

function migrate (db) {

    db.exec('CREATE TABLE IF NOT EXISTS schema_version (idx INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)')

    const applied = new Set(
        db.prepare('SELECT name FROM schema_version').all().map(r => r.name)
    )

    for (let i = 0; i < MIGRATIONS.length; i++) {
        const migration = MIGRATIONS[i]
        if (applied.has(migration.name)) { continue }

        db.exec('BEGIN')
        try {
            db.exec(migration.sql)
            db.prepare('INSERT INTO schema_version (idx, name, applied_at) VALUES (?, ?, ?)')
                .run(i, migration.name, new Date().toISOString())
            db.exec('COMMIT')
        } catch (err) {
            db.exec('ROLLBACK')
            throw new Error('Migration ' + migration.name + ' failed: ' + err.message)
        }
    }
}
