'use strict'

const test = require('node:test')
const assert = require('node:assert')
const FS = require('node:fs')
const PATH = require('node:path')

const CLASSIFY = require('../src/catalogue/classify.js')
const INSTRUMENTS = require('../src/catalogue/instruments.js')
const EXCLUSIONS = require('../src/catalogue/exclusions.js')

/*
    The golden catalogue.

    This is the safety net for pulling the catalogue apart into series packs.
    Every step of that refactor changes the code that decides which coin a
    title describes, and the failure mode is silent: instruments re-bucket,
    the 26 hard-won completed sales scatter across new keys, every clearing
    figure shifts, and the page still looks perfectly fine.

    So the fixture records what the tool believes TODAY - 1,807 instrument
    keys and their names, 682 real titles from the live store chosen to cover
    every pool, denomination, review reason and known-dangerous phrasing, and
    every category path the store has seen. If a refactor changes any of it,
    these tests say exactly which ones and how.

    IT IS A CHANGE DETECTOR, NOT A CORRECTNESS ORACLE. It records current
    behaviour, bugs included. A failure means behaviour moved - then you
    decide whether the move was intended, and if it was, you regenerate with
    scripts/golden.js and read the diff. Never hand-edit the fixture to make
    a test pass; that is the one action that destroys its whole value.

    Titles are classified with NO label and NO learned rules, so this pins
    the pipeline rather than the owner's corrections, which change weekly.
*/
const GOLDEN = JSON.parse(
    FS.readFileSync(PATH.join(__dirname, 'fixtures', 'series-golden.json'), 'utf8'))

/*  Report the first few mismatches and the total, rather than dying on the
    first one. During a refactor "412 keys changed, here are three" is a
    diagnosis; "expected X got Y" on one arbitrary key is a puzzle. */
function report (label, mismatches, total) {
    if (mismatches.length === 0) { return }
    const shown = mismatches.slice(0, 5)
        .map(m => '\n    ' + m.what + '\n      was: ' + JSON.stringify(m.was) +
                  '\n      now: ' + JSON.stringify(m.now))
        .join('')
    assert.fail(mismatches.length + ' of ' + total + ' ' + label +
        ' changed. If that was deliberate, regenerate with scripts/golden.js ' +
        'and read the diff.' + shown +
        (mismatches.length > 5 ? '\n    ... and ' + (mismatches.length - 5) + ' more' : ''))
}

test('golden: every instrument key still gets the same name', () => {
    const bad = []
    for (const k of GOLDEN.keys) {
        const now = INSTRUMENTS.displayName(k.key)
        if (now !== k.displayName) { bad.push({ what: k.key, was: k.displayName, now }) }
    }
    report('instrument names', bad, GOLDEN.keys.length)
})

/*  displayName parses its key BY POSITION and returns '' on a shape it does
    not recognise - test/store.test.js already stores a wrong-shaped key and
    gets an empty name with nobody noticing. That name is then written to a
    NOT NULL column. A blank "Coin type" cell reads as a rendering fault
    rather than a data fault, and the row becomes unfindable. */
test('golden: no key produces an empty name', () => {
    const blank = GOLDEN.keys.filter(k => !INSTRUMENTS.displayName(k.key))
    assert.deepStrictEqual(blank.map(k => k.key), [],
        'a key with no name is a row nobody can find')
})

test('golden: the gold in each coin type has not moved', () => {
    const bad = []
    for (const k of GOLDEN.keys) {
        /*  fine_oz is per COIN, never per lot - MKT-13. A change here
            silently rescales every premium filed under the key. */
        if (!Number.isFinite(k.fineOz)) { continue }
        const denomination = k.key.split('.')[3]
        const now = INSTRUMENTS.fineOzFor({ denomination })
        if (Number.isFinite(now) && Math.abs(now - k.fineOz) > 1e-12) {
            bad.push({ what: k.key, was: k.fineOz, now })
        }
    }
    report('fine ounce values', bad, GOLDEN.keys.length)
})

test('golden: the same titles still describe the same coins', () => {
    const bad = []
    for (const t of GOLDEN.titles) {
        const result = CLASSIFY.classify({ title: t.title }, { label: null, learned: null })
        const excluded = result.excluded === null || result.excluded === undefined
            ? null
            : (result.excluded.code || result.excluded.rule || result.excluded.reason || 'EXCLUDED')
        const keys = result.attributes === null || result.attributes === undefined
            ? [] : INSTRUMENTS.keysFor(result.attributes).map(k => k.key)

        if (excluded !== t.excluded) {
            bad.push({ what: t.title, was: 'excluded ' + t.excluded, now: 'excluded ' + excluded })
            continue
        }
        if (keys.join('|') !== t.keys.join('|')) {
            bad.push({ what: t.title, was: t.keys, now: keys })
        }
    }
    report('title classifications', bad, GOLDEN.titles.length)
})

/*  Separate from the keys, because a lot can land on the right coin type
    with the wrong confidence and be silently promoted past the review queue
    - or silently dropped into it, which is 682 questions nobody asked for. */
test('golden: the same titles are still as certain, or as doubtful', () => {
    const bad = []
    for (const t of GOLDEN.titles) {
        const r = CLASSIFY.classify({ title: t.title }, { label: null, learned: null })
        const confidence = Number.isFinite(r.confidence)
            ? Math.round(r.confidence * 1000) / 1000 : null
        const needsReview = r.needsReview === true
        if (confidence !== t.confidence || needsReview !== t.needsReview) {
            bad.push({
                what: t.title,
                was: { confidence: t.confidence, needsReview: t.needsReview },
                now: { confidence, needsReview }
            })
        }
    }
    report('title confidences', bad, GOLDEN.titles.length)
})

/*  The category screen runs BEFORE the title parser and is the single
    cheapest filter in the tool - it is what keeps 414 rings and 28 fishing
    reels out of the market statistics. */
test('golden: the same categories are still in or out', () => {
    const bad = []
    for (const s of GOLDEN.screens) {
        const verdict = EXCLUSIONS.screenCategory(s.categoryPath)
        const now = verdict === null || verdict === undefined
            ? null : (verdict.code || verdict.reason || 'EXCLUDED')
        if (now !== s.excluded) { bad.push({ what: s.categoryPath, was: s.excluded, now }) }
    }
    report('category screens', bad, GOLDEN.screens.length)
})

/*  The fixture is only a safety net if it still covers the ground. A
    regenerated fixture that quietly lost its excluded titles, or its
    multi-level keys, would pass everything above and protect nothing. */
test('golden: the fixture still covers what it is meant to cover', () => {
    assert.ok(GOLDEN.keys.length > 1500, 'key inventory looks truncated')
    assert.ok(GOLDEN.titles.length > 400, 'title corpus looks truncated')
    assert.ok(GOLDEN.titles.filter(t => t.excluded !== null).length > 100,
        'no excluded titles means the exclusion rules are untested')
    assert.ok(GOLDEN.titles.filter(t => t.keys.length > 0).length > 100,
        'no classified titles means the parser is untested')
    assert.ok(GOLDEN.titles.filter(t => t.needsReview).length > 50,
        'no doubtful titles means the review path is untested')

    /*  Every level of the key ladder, or the levels nobody sampled are the
        levels the refactor is free to break. */
    for (let level = 0; level <= INSTRUMENTS.MAX_LEVEL; level++) {
        assert.ok(GOLDEN.keys.some(k => k.level === level), 'no key at level ' + level)
    }
    /*  Every pool, so a change to poolFor cannot slip through on the pools
        that happen to be rare. */
    for (const pool of ['BULLION', 'EARLY', 'GRADED', 'PROOF', 'BRANCH', 'UNATTRIBUTED']) {
        assert.ok(GOLDEN.keys.some(k => k.key.split('.')[2] === pool), 'no key in pool ' + pool)
    }
    /*  And the phrasings that each cost a real bug. */
    for (const scar of ['spaced mintmark', 'negated mounting', 'packaging']) {
        assert.ok(GOLDEN.strata.some(s => s.stratum === 'scar:' + scar),
            'the fixture no longer covers: ' + scar)
    }
})
