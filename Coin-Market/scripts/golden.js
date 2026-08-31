'use strict'

/*
    Builds test/fixtures/series-golden.json: a frozen record of what this
    tool currently believes a sovereign is.

        node scripts/golden.js [path/to/coin-market.db] [out.json]

    WHY THIS EXISTS. The catalogue is about to be pulled apart into series
    packs so a second coin can be added. Every step of that refactors the
    code that decides which coin a title describes, and the failure mode is
    silent: instruments re-bucket, the hard-won completed sales scatter
    across new keys, every clearing figure shifts, and the page still looks
    perfectly fine. This turns "did I just change what a sovereign is?" into
    a yes/no answer in milliseconds instead of a discovery weeks later.

    WHAT IT IS NOT. A change detector, not a correctness oracle. It records
    what the code does today, bugs included. A failure means behaviour
    moved - then you decide whether the move was intended, and if it was,
    you regenerate and read the diff. Never hand-edit the fixture to make a
    test pass; that is the one action that destroys its entire value.

    DETERMINISM. Titles are chosen by a stable sort, never at random, and
    classification runs with NO human labels and NO learned rules - so this
    pins the pipeline rather than the owner's evolving corrections, which
    change weekly and would otherwise make it fail on every judgement
    instead of on every regression.
*/

const FS = require('node:fs')
const PATH = require('node:path')
const { DatabaseSync } = require('node:sqlite')

const CLASSIFY = require('../src/catalogue/classify.js')
const INSTRUMENTS = require('../src/catalogue/instruments.js')
const EXCLUSIONS = require('../src/catalogue/exclusions.js')

/*  Per stratum. Enough to catch a rule that changes for one phrasing but not
    another; small enough that the fixture stays readable in a diff. */
const PER_STRATUM = 6

/*  Phrasings that have each cost this project a real bug, listed by hand
    because the store cannot know which of its titles are the dangerous ones.
    CLS-02 to CLS-06 all hid behind ordinary-looking listings. Anything
    matching these is pulled in whatever else is sampled. */
const SCARS = [
    { name: 'spaced mintmark', re: /\b1[89]\d{2}\s+[SMPCIA]\b/ },
    { name: 'punctuation before denomination', re: /[*#(\[,]\s*(half|quarter|full)/i },
    { name: 'negated mounting', re: /never\s+(been\s+)?(cleaned|mounted)/i },
    { name: 'packaging', re: /capsule|boxed|presentation case/i },
    { name: 'multi weight', re: /(two|five|double|quintuple|piedfort) pound/i },
    { name: 'pick your coin', re: /choose\s+your|pick\s+your|you\s+choose/i },
    { name: 'novelty or copy', re: /\b(copy|replica|style|fantasy)\b/i },
    { name: 'multi coin lot', re: /\b(set of|job\s?lot|full set)\b/i },
    { name: 'another coin entirely', re: /\b(krugerrand|britannia|eagle|maple|pond|pesos|franc)\b/i }
]

function outcomeOf (verdict) {
    if (verdict === null || verdict === undefined) { return null }
    return verdict.code || verdict.rule || verdict.reason || 'EXCLUDED'
}

function classifyTitle (title) {
    const result = CLASSIFY.classify({ title }, { label: null, learned: null })
    const keys = result.attributes === null || result.attributes === undefined
        ? [] : INSTRUMENTS.keysFor(result.attributes)
    const fineOz = result.attributes === null || result.attributes === undefined
        ? null : INSTRUMENTS.fineOzFor(result.attributes)
    return {
        title,
        excluded: outcomeOf(result.excluded),
        needsReview: result.needsReview === true,
        confidence: Number.isFinite(result.confidence)
            ? Math.round(result.confidence * 1000) / 1000 : null,
        keys: keys.map(k => k.key),
        fineOz: Number.isFinite(fineOz) ? fineOz : null,
        reasons: (result.reasons || []).slice().sort()
    }
}

function build (dbPath) {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    const all = (sql, ...a) => db.prepare(sql).all(...a)

    /* ---- every instrument key, and the name the tool gives it ---------- */
    const keys = all('SELECT key, level, fine_oz AS fineOz, metal, display_name AS storedName ' +
                     'FROM instrument ORDER BY key')
        .map(r => ({
            key: r.key,
            level: r.level,
            fineOz: r.fineOz,
            metal: r.metal,
            displayName: INSTRUMENTS.displayName(r.key),
            /*  What the store has written for this key. Recorded separately
                because saveClassification PERSISTS the name, so the computed
                and the stored one can drift and nothing would say so. */
            storedName: r.storedName
        }))

    /* ---- titles, stratified by the behaviour they exercise ------------- */
    const chosen = new Map()
    const strata = []
    const take = (stratum, rows) => {
        let n = 0
        for (const row of rows) {
            if (n >= PER_STRATUM) { break }
            if (chosen.has(row.title)) { continue }
            chosen.set(row.title, stratum)
            n++
        }
        if (n > 0) { strata.push({ stratum, added: n }) }
    }

    /*  One stratum per level-0 coin type, so every pool and denomination the
        store has produced is represented. Ordered by title, so the choice is
        stable across runs rather than dependent on row order. */
    for (const k of all('SELECT DISTINCT key FROM instrument WHERE level = 0 ORDER BY key')) {
        take('key:' + k.key, all(
            'SELECT DISTINCT l.title AS title FROM listing l ' +
            'JOIN listing_instrument li ON li.browse_id = l.browse_id ' +
            'WHERE li.key = ? ORDER BY l.title', k.key))
    }

    /*  One per distinct review or exclusion reason: the paths a title takes
        when the parser is unsure or says no, which is exactly what a
        refactor breaks quietly. */
    for (const r of all('SELECT DISTINCT reason FROM review_queue ' +
                        'WHERE reason IS NOT NULL ORDER BY reason')) {
        take('reason:' + r.reason, all(
            'SELECT DISTINCT l.title AS title FROM listing l ' +
            'JOIN review_queue q ON q.browse_id = l.browse_id ' +
            'WHERE q.reason = ? ORDER BY l.title', r.reason))
    }

    /*  And the scars. */
    const everyTitle = all('SELECT DISTINCT title AS title FROM listing ORDER BY title')
    for (const scar of SCARS) {
        take('scar:' + scar.name, everyTitle.filter(t => scar.re.test(t.title)))
    }

    const titles = Array.from(chosen.keys()).sort()
        .map(t => Object.assign({ stratum: chosen.get(t) }, classifyTitle(t)))

    /* ---- the category screen, which runs BEFORE the title parser ------- */
    const screens = all('SELECT DISTINCT category_path AS p FROM listing ' +
                        'WHERE category_path IS NOT NULL ORDER BY category_path')
        .map(r => ({ categoryPath: r.p, excluded: outcomeOf(EXCLUSIONS.screenCategory(r.p)) }))

    db.close()
    return {
        note: 'Generated by scripts/golden.js. A change detector, not a correctness oracle. ' +
              'Never hand-edit to make a test pass - regenerate deliberately and read the diff.',
        counts: { keys: keys.length, titles: titles.length, screens: screens.length },
        strata,
        keys,
        titles,
        screens
    }
}

const dbPath = process.argv[2] || PATH.join(__dirname, '..', 'coin-market.db')
const outPath = process.argv[3] || PATH.join(__dirname, '..', 'test', 'fixtures', 'series-golden.json')
const fixture = build(dbPath)
FS.mkdirSync(PATH.dirname(outPath), { recursive: true })
FS.writeFileSync(outPath, JSON.stringify(fixture, null, 1) + '\n')
console.log('golden: ' + fixture.counts.keys + ' keys, ' + fixture.counts.titles + ' titles, ' +
            fixture.counts.screens + ' category screens -> ' + outPath)
