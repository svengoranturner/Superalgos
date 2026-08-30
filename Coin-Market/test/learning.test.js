'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const LEARNED = require('../src/catalogue/learned.js')
const { classify } = require('../src/catalogue/classify.js')
const INSTRUMENTS = require('../src/catalogue/instruments.js')
const COINS = require('../src/catalogue/coins.js')

const DAY_MS = 86400000

function fixture () {
    const db = newDatabase(':memory:')
    return { db, repository: newRepository(db, { sellerSalt: 'test' }) }
}

/* ------------------------------------------------------ a stored call */

/*  The whole point: a person who knows the market outranks every rule
    written by somebody who does not. */
test('your verdict beats the classifier', () => {
    const title = '1907 Edward VII Gold Sovereign London'
    assert.strictEqual(classify({ title }).excluded, null)

    const overridden = classify({ title }, {
        label: { verdict: LEARNED.VERDICT.NOT_SOVEREIGN }
    })
    assert.strictEqual(overridden.excluded.code, 'HUMAN')
    assert.strictEqual(overridden.labelled, true)
})

/*  The direction that matters more. A rule quietly eating genuine coins is
    the failure mode worth catching, and the review queue is where it would
    be caught - so confirming something there has to be able to undo it. */
test('confirming a coin rescues it from an exclusion rule', () => {
    const title = 'Sovereign Vintage Ladies Watch Swiss Made'
    assert.strictEqual(classify({ title }).excluded.code, 'JEWELLERY')

    const rescued = classify({ title }, {
        label: { verdict: LEARNED.VERDICT.SOVEREIGN, denomination: 'FULL' }
    })
    assert.strictEqual(rescued.excluded, null)
    assert.strictEqual(rescued.attributes.denomination, 'FULL')
    assert.strictEqual(rescued.needsReview, false)
})

/*  Confirming it is genuine does not say which coin it is, and melt against
    the wrong denomination is how a real sovereign came to read "below
    melt". It stays in the queue until that question is answered too. */
test('a confirmed coin with no denomination is still not priceable', () => {
    const rescued = classify({ title: '22ct gold coin from a house clearance' }, {
        label: { verdict: LEARNED.VERDICT.SOVEREIGN }
    })
    assert.strictEqual(rescued.excluded, null)
    assert.strictEqual(rescued.needsReview, true)
    assert.match(rescued.reasons[0], /which denomination/)
})

/*  Confirming used to exclude and then restore, which threw away everything
    the parser knew: a lot marked genuine came back with no year, no portrait
    and no denomination, so answering one question created three. The rules
    exist to guess in the absence of a human, and there is a human here. */
test('confirming a coin keeps what the parser already worked out', () => {
    const title = '1911 Gold Half Sovereign George V Ring Mount'
    assert.strictEqual(classify({ title }).excluded.code, 'JEWELLERY')

    const confirmed = classify({ title }, { label: { verdict: LEARNED.VERDICT.SOVEREIGN } })
    assert.strictEqual(confirmed.excluded, null)
    assert.strictEqual(confirmed.attributes.denomination, 'HALF', 'no need to re-pick the denomination')
    assert.strictEqual(confirmed.attributes.year, 1911)
    assert.strictEqual(confirmed.attributes.portrait, 'GEORGE_V')
    assert.strictEqual(confirmed.needsReview, false)
})

/*  A multi-coin lot is excluded by default because a job lot's per-coin price
    is not a single-coin sale. That is a default, not a law - somebody can see
    it is three of the same coin, and then it prices against three coins worth
    of gold. */
test('a lot can be admitted at the right melt by saying how many coins it holds', () => {
    const title = '3 x Gold Sovereign 1912 George V'
    assert.strictEqual(classify({ title }).excluded.code, 'PROOF_SET_OR_BUNDLE')

    const one = classify({ title }, { label: { verdict: LEARNED.VERDICT.SOVEREIGN } })
    assert.strictEqual(INSTRUMENTS.fineOzFor(one.attributes), COINS.DENOMINATIONS.FULL.fineOz)

    const three = classify({ title }, { label: { verdict: LEARNED.VERDICT.SOVEREIGN, quantity: 3 } })
    assert.strictEqual(three.attributes.quantity, 3)
    assert.ok(Math.abs(INSTRUMENTS.fineOzFor(three.attributes) - 3 * COINS.DENOMINATIONS.FULL.fineOz) < 1e-9)
})

/* ------------------------------------------------------ learned rules */

test('an accepted rule generalises to listings nobody has looked at', () => {
    const learned = LEARNED.compile([
        { phrase: 'hardy', kind: LEARNED.VERDICT.NOT_SOVEREIGN, enabled: 1 }
    ])
    const result = classify({ title: 'Hardy Gold Sovereign 7/8 Golden Japan' }, { learned })
    assert.strictEqual(result.excluded.code, 'LEARNED')
    assert.match(result.excluded.reason, /hardy/)
    /* And leaves everything else alone. */
    assert.strictEqual(classify({ title: '1974 Gold Sovereign' }, { learned }).excluded, null)
})

test('a phrase is matched literally, never as a pattern', () => {
    /*  Phrases are stored as text and escaped here. A stored string must
        never be able to become a pattern that eats the collector. */
    const test1 = LEARNED.phrasePattern('.999')
    assert.ok(test1.test('Gold Bar .999 fine'))
    assert.ok(!test1.test('Gold Bar a999 fine'))

    const test2 = LEARNED.phrasePattern('1/8')
    assert.ok(test2.test('Hattons 1/8 Sovereign'))
    assert.ok(!test2.test('Hattons 128 Sovereign'))
})

test('a rule someone taught can name a denomination too', () => {
    const learned = LEARNED.compile([
        { phrase: 'sov half', kind: 'DENOMINATION', value: 'HALF', enabled: 1 }
    ])
    const result = classify({ title: 'Royal Mint 2013 Gold Proof Sov Half Box COA' }, { learned })
    assert.strictEqual(result.attributes.denomination, 'HALF')
})

/* --------------------------------------------------------- induction */

/*  Sized so the document-frequency cap behaves as it does on the real
    corpus. A phrase that covers half of six listings genuinely is too broad
    to be a rule; the same phrase over three of twenty-three is not. */
const CORPUS = [
    { legacyId: '1', title: 'Hardy Gold Sovereign 7/8 Fly Reel with Case', priced: 0 },
    { legacyId: '2', title: 'Hardy Gold Sovereign 9/10 Salmon Fly Reel', priced: 0 },
    { legacyId: '3', title: 'Vintage Hardy Sovereign 5/6 Fly Reel and Spool', priced: 0 },
    { legacyId: '4', title: '1974 Gold Sovereign Elizabeth II', priced: 1 },
    { legacyId: '5', title: '1911 Gold Sovereign George V London', priced: 1 },
    { legacyId: '6', title: '1974 Gold Sovereign bullion grade', priced: 1 }
].concat(Array.from({ length: 17 }, (unused, i) => ({
    legacyId: 'f' + i, title: (1890 + i) + ' Gold Sovereign Victoria Old Head', priced: 1
})))

test('a rejected listing proposes the phrase that generalises it', () => {
    const proposals = LEARNED.induce(
        { title: 'Hardy Gold Sovereign 7/8 Fly Reel with Case', verdict: LEARNED.VERDICT.NOT_SOVEREIGN },
        CORPUS, [])

    const phrases = proposals.map(p => p.phrase)
    assert.ok(phrases.includes('hardy'), 'expected "hardy": ' + phrases.join(', '))
    const hardy = proposals.find(p => p.phrase === 'hardy')
    assert.strictEqual(hardy.support, 3)
    assert.strictEqual(hardy.conflicts.length, 0)
})

/*  Reach alone cannot tell a good rule from a destructive one. The first
    version of this offered to drop every listing containing "london" - 233
    matches, 97 of them sovereigns then in the market statistics - because
    it ranked on support and nothing else. */
test('a rule that would stop pricing real coins ranks below one that would not', () => {
    const proposals = LEARNED.induce(
        { title: 'Hardy Gold Sovereign 7/8 Fly Reel with Case', verdict: LEARNED.VERDICT.NOT_SOVEREIGN },
        CORPUS, [])

    const hardy = proposals.find(p => p.phrase === 'hardy')
    assert.strictEqual(hardy.breaks, 0, 'the reels are not priced, so this rule breaks nothing')

    const damaging = proposals.filter(p => p.breaks > 0)
    const safe = proposals.filter(p => p.breaks === 0)
    for (const d of damaging) {
        for (const s of safe) {
            assert.ok(proposals.indexOf(s) < proposals.indexOf(d),
                '"' + d.phrase + '" (' + d.breaks + ' broken) outranked "' + s.phrase + '"')
        }
    }
})

/*  Frequent, and meaningless. */
test('function words are never offered as rules', () => {
    const proposals = LEARNED.induce(
        { title: 'Hardy Gold Sovereign 7/8 Fly Reel with Case', verdict: LEARNED.VERDICT.NOT_SOVEREIGN },
        CORPUS, [])
    for (const junk of ['of', 'with', 'the', 'and']) {
        assert.ok(!proposals.some(p => p.phrase === junk), junk + ' was offered as a rule')
    }
})

/*  A bare year generalises catastrophically - rejecting one 1984 fantasy
    piece must not offer to drop every 1984 sovereign. */
test('a year is never offered as a rule on its own', () => {
    const proposals = LEARNED.induce(
        { title: '1974 Gold Sovereign bullion grade', verdict: LEARNED.VERDICT.NOT_SOVEREIGN },
        CORPUS, [])
    assert.ok(!proposals.some(p => p.phrase === '1974'), 'a bare year was offered as a rule')
})

/*  "sovereign" is every listing in the corpus, and a rule on it would empty
    the market. Anything above the document-frequency cap is withheld. */
test('a phrase that matches most of the corpus is never offered', () => {
    const proposals = LEARNED.induce(
        { title: '1974 Gold Sovereign Elizabeth II', verdict: LEARNED.VERDICT.NOT_SOVEREIGN },
        CORPUS, [])
    assert.ok(!proposals.some(p => p.phrase === 'sovereign'))
    assert.ok(!proposals.some(p => p.phrase === 'gold'))
})

/*  The conflict is the useful part of the proposal: it says the phrase is
    too broad and needs another word, and it is shown rather than silently
    suppressing the rule. */
test('a proposal that contradicts an earlier call says so', () => {
    const labels = [
        { legacyId: '4', title: '1974 Gold Sovereign Elizabeth II', verdict: LEARNED.VERDICT.SOVEREIGN }
    ]
    const proposals = LEARNED.induce(
        { title: '1974 Gold Sovereign bullion grade', verdict: LEARNED.VERDICT.NOT_SOVEREIGN },
        CORPUS, labels)

    const conflicted = proposals.filter(p => p.conflicts.length > 0)
    for (const p of conflicted) {
        assert.ok(p.conflicts[0].includes('Elizabeth II'))
    }
    /* Clean proposals rank above contradicted ones. */
    const firstConflictAt = proposals.findIndex(p => p.conflicts.length > 0)
    const lastCleanAt = proposals.map(p => p.conflicts.length).lastIndexOf(0)
    if (firstConflictAt !== -1) { assert.ok(lastCleanAt < firstConflictAt) }
})

/* ------------------------------------------------------------- store */

test('a label is stored once per coin and re-labelling corrects it', () => {
    const { db, repository } = fixture()
    repository.label({ legacyId: '99', title: 'Gold Sovereign', verdict: LEARNED.VERDICT.NOT_SOVEREIGN })
    repository.label({ legacyId: '99', title: 'Gold Sovereign', verdict: LEARNED.VERDICT.SOVEREIGN, denomination: 'FULL' })

    const labels = repository.labels()
    assert.strictEqual(labels.length, 1)
    assert.strictEqual(labels[0].verdict, LEARNED.VERDICT.SOVEREIGN)
    assert.strictEqual(labels[0].denomination, 'FULL')
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM listing_label').get().n, 1)
})

/*  Raw eBay rows roll off under retention. A judgement about them is ours
    and is kept, or the training set evaporates on a 180-day cycle. */
test('labels outlive the listings they were made on', () => {
    const { repository } = fixture()
    const expired = new Date(Date.now() - 400 * DAY_MS).toISOString()
    repository.saveListing({
        browseId: 'v1|7|0', legacyId: '7', title: 'Hardy Gold Sovereign Fly Reel',
        buyingOptions: 'FIXED_PRICE', endTime: expired, expiresAt: expired
    })
    repository.label({ legacyId: '7', title: 'Hardy Gold Sovereign Fly Reel', verdict: LEARNED.VERDICT.NOT_SOVEREIGN })

    repository.purgeExpired(new Date().toISOString())

    assert.strictEqual(repository.labels().length, 1, 'the label was purged with the listing')
})

test('a learned rule is stored once per phrase and can be removed', () => {
    const { repository } = fixture()
    repository.saveLearnedRule({ phrase: 'Fly Reel', kind: LEARNED.VERDICT.NOT_SOVEREIGN, support: 3, agreement: 1 })
    repository.saveLearnedRule({ phrase: 'fly reel', kind: LEARNED.VERDICT.NOT_SOVEREIGN, support: 27, agreement: 1 })

    let rules = repository.learnedRules()
    assert.strictEqual(rules.length, 1, 'case should not create a second rule')
    assert.strictEqual(rules[0].support, 27)

    repository.deleteLearnedRule(rules[0].id)
    assert.strictEqual(repository.learnedRules().length, 0)
})

/* -------------------------------------------------------- end to end */

test('a decision changes what gets priced', () => {
    const { db, repository } = fixture()
    const soon = new Date(Date.now() + DAY_MS).toISOString()
    for (const [browseId, legacyId, title] of [
        ['v1|10|0', '10', '1974 Gold Sovereign Elizabeth II'],
        ['v1|11|0', '11', 'Hardy Gold Sovereign 7/8 Fly Reel with Case'],
        ['v1|12|0', '12', 'Hardy Gold Sovereign 9/10 Salmon Fly Reel']
    ]) {
        repository.saveListing({ browseId, legacyId, title, buyingOptions: 'FIXED_PRICE', endTime: soon })
    }

    const RECLASSIFY = require('../src/catalogue/reclassify.js')

    /*  The reels are caught by a title rule already, so to test the loop
        itself we teach it something the rules do not know. */
    repository.label({ legacyId: '10', title: '1974 Gold Sovereign Elizabeth II', verdict: LEARNED.VERDICT.NOT_SOVEREIGN })
    const after = RECLASSIFY.run(db, repository)

    assert.strictEqual(after.labelled, 1)
    const reasons = db.prepare('SELECT reason FROM review_queue WHERE browse_id = ?').get('v1|10|0')
    assert.match(reasons.reason, /not a sovereign/)
    assert.strictEqual(
        db.prepare('SELECT COUNT(*) AS n FROM listing_instrument WHERE browse_id = ?').get('v1|10|0').n, 0)
})

/*  A verdict cannot affect any listing but its own, and rebuilding all five
    thousand per click was slow enough on the Pi that the button timed out. */
test('one verdict reclassifies one coin, not the whole store', () => {
    const { db, repository } = fixture()
    const soon = new Date(Date.now() + DAY_MS).toISOString()
    for (const [browseId, legacyId, title] of [
        ['v1|k1|0', 'k1', '1974 Gold Sovereign Elizabeth II'],
        ['v1|k2|0', 'k2', '1911 Gold Sovereign George V London'],
        /* A relist: same coin, second browse id. Both must be reclassified. */
        ['v1|k1b|0', 'k1', '1974 Gold Sovereign Elizabeth II']
    ]) {
        repository.saveListing({ browseId, legacyId, title, buyingOptions: 'FIXED_PRICE', endTime: soon })
    }

    const RECLASSIFY = require('../src/catalogue/reclassify.js')
    RECLASSIFY.run(db, repository)
    const otherBefore = db.prepare(
        'SELECT COUNT(*) AS n FROM listing_instrument WHERE browse_id = ?').get('v1|k2|0').n
    assert.ok(otherBefore > 0)

    repository.label({ legacyId: 'k1', title: '1974 Gold Sovereign Elizabeth II', verdict: LEARNED.VERDICT.NOT_SOVEREIGN })
    const counts = RECLASSIFY.one(db, repository, 'k1')

    assert.strictEqual(counts.total, 2, 'both browse ids of the relisted coin')
    assert.strictEqual(counts.labelled, 2)
    /* The labelled coin is out of the statistics, under both its ids. */
    for (const id of ['v1|k1|0', 'v1|k1b|0']) {
        assert.strictEqual(db.prepare(
            'SELECT COUNT(*) AS n FROM listing_instrument WHERE browse_id = ?').get(id).n, 0, id)
    }
    /* And nothing else was touched. */
    assert.strictEqual(db.prepare(
        'SELECT COUNT(*) AS n FROM listing_instrument WHERE browse_id = ?').get('v1|k2|0').n, otherBefore)
    db.close()
})

/*  Undoing has to put it back, or a mis-click is unrecoverable without a
    command line. */
test('undoing a verdict restores the listing to the statistics', () => {
    const { db, repository } = fixture()
    repository.saveListing({
        browseId: 'v1|u1|0', legacyId: 'u1', title: '1974 Gold Sovereign Elizabeth II',
        buyingOptions: 'FIXED_PRICE', endTime: new Date(Date.now() + DAY_MS).toISOString()
    })
    const RECLASSIFY = require('../src/catalogue/reclassify.js')
    RECLASSIFY.run(db, repository)
    const before = db.prepare('SELECT COUNT(*) AS n FROM listing_instrument WHERE browse_id = ?').get('v1|u1|0').n

    repository.label({ legacyId: 'u1', title: 'x', verdict: LEARNED.VERDICT.NOT_SOVEREIGN })
    RECLASSIFY.one(db, repository, 'u1')
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM listing_instrument WHERE browse_id = ?').get('v1|u1|0').n, 0)

    repository.unlabel('u1')
    RECLASSIFY.one(db, repository, 'u1')
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM listing_instrument WHERE browse_id = ?').get('v1|u1|0').n, before)
    db.close()
})
