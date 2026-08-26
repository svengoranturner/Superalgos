'use strict'

const test = require('node:test')
const assert = require('node:assert')

const CONDITIONS = require('../src/catalogue/conditions.js')
const { classify } = require('../src/catalogue/classify.js')
const NOTIFICATIONS = require('../src/ebay/notifications.js')
const LIQUIDITY = require('../src/analytics/liquidity.js')
const BROWSE = require('../src/ebay/browse.js')
const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')

/* ============ eBay replaced usernames with immutable user IDs ============ */

function seededListing (repository, browseId, seller) {
    repository.saveListing(Object.assign({
        browseId, legacyId: browseId.replace(/\D/g, ''), title: 'Gold Sovereign 1974',
        buyingOptions: 'AUCTION', endTime: new Date().toISOString()
    }, seller))
}

test('a deletion keyed by immutable id purges a seller we only knew by username', () => {
    /*
        The failure this prevents: rows ingested before May 2026 carry a
        hash of the username, while the notification names the departing
        user by immutable id. Matching only one column would return 200 to
        eBay having deleted nothing - failing the exact obligation we
        subscribed in order to meet.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })

    seededListing(repository, 'v1|1|0', { sellerUsername: 'coinshop' })          /* old style */
    seededListing(repository, 'v1|2|0', { sellerUserId: 'IMM_999' })             /* new style */
    seededListing(repository, 'v1|3|0', { sellerUsername: 'someone_else' })      /* bystander */

    /* eBay names them by immutable id only. */
    assert.strictEqual(NOTIFICATIONS.purgeUser(repository, db, { userId: 'IMM_999' }), 1)
    /* And by username only. */
    assert.strictEqual(NOTIFICATIONS.purgeUser(repository, db, { username: 'coinshop' }), 1)

    const left = db.prepare('SELECT browse_id FROM listing').all().map(r => r.browse_id)
    assert.deepStrictEqual(left, ['v1|3|0'], 'only the unrelated seller should remain')
})

test('a deletion carrying both identifiers purges either match', () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    seededListing(repository, 'v1|1|0', { sellerUsername: 'coinshop' })
    seededListing(repository, 'v1|2|0', { sellerUserId: 'IMM_999' })

    assert.strictEqual(
        NOTIFICATIONS.purgeUser(repository, db, { username: 'coinshop', userId: 'IMM_999' }), 2)
})

test('purgeUser still accepts a bare username string', () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    seededListing(repository, 'v1|1|0', { sellerUsername: 'coinshop' })
    assert.strictEqual(NOTIFICATIONS.purgeUser(repository, db, 'coinshop'), 1)
})

test('the notification handler forwards whichever identifier eBay sends', () => {
    let received = null
    const handle = NOTIFICATIONS.newHandler({
        verificationToken: 'a'.repeat(40),
        endpointUrl: 'https://example.com/x',
        onDeletion: (identifiers) => { received = identifiers; return 0 }
    })
    handle('POST', new URL('https://example.com/x'), JSON.stringify({
        notification: { data: { userId: 'IMM_42' } }
    }))
    assert.deepStrictEqual(received, { username: null, userId: 'IMM_42' })
})

test('Browse summaries capture both seller identifiers', () => {
    const summary = BROWSE.normaliseSummary({
        itemId: 'v1|1|0', title: 'x', price: { value: '1', currency: 'GBP' },
        seller: { userId: 'IMM_7', username: 'shop', feedbackPercentage: '99', feedbackScore: 5 }
    })
    assert.strictEqual(summary.sellerUserId, 'IMM_7')
    assert.strictEqual(summary.sellerUsername, 'shop')
})

/* ================ standardised coin condition descriptors ================ */

test('the four standardised raw bands map onto our grade bands', () => {
    /*
        Asserted explicitly. A silent mis-mapping here would move every
        grade-level premium with nothing visibly wrong.
    */
    const band = (text) => CONDITIONS.gradeFromDescriptors(
        CONDITIONS.parseDescriptors([{ name: 'Condition', values: [text] }])).gradeBand

    assert.strictEqual(band('Uncirculated'), 'RAW_BU')
    assert.strictEqual(band('Extremely Fine to About Uncirculated'), 'RAW_EF')
    assert.strictEqual(band('Fine to Very Fine'), 'RAW_VF')
    assert.strictEqual(band('Below Fine'), 'RAW_FINE_BELOW')
})

test('graded descriptors band by numeric grade, and proofs by letter', () => {
    const graded = (company, letter, numeric) => CONDITIONS.gradeFromDescriptors(
        CONDITIONS.parseDescriptors([
            { name: 'Grader', values: [{ content: company }] },
            { name: 'Letter Grade', values: [{ content: letter }] },
            { name: 'Number Grade', values: [{ content: numeric }] }
        ])).gradeBand

    assert.strictEqual(graded('PCGS', 'MS', '66'), 'SLAB_MS65_PLUS')
    assert.strictEqual(graded('NGC', 'MS', '64'), 'SLAB_MS64')
    assert.strictEqual(graded('NGC', 'MS', '62'), 'SLAB_MS62')
    assert.strictEqual(graded('NGC', 'MS', '58'), 'SLAB_MS61_BELOW')
    assert.strictEqual(graded('PCGS', 'PF', '69'), 'SLAB_PROOF')
})

test('an unrecognised condition band is surfaced, never defaulted', () => {
    /*
        If eBay adds or rewords a band, filing it under "ungraded" would
        quietly move premiums. It must reach a human instead.
    */
    const result = classify({
        title: '1974 Gold Sovereign',
        conditionDescriptors: [{ name: 'Condition', values: ['Splendid'] }]
    })
    assert.strictEqual(result.needsReview, true)
    assert.match(result.reasons.join(' '), /Unrecognised eBay condition band/)
})

test('condition descriptors outrank a contradicting title', () => {
    const result = classify({
        title: '1974 Gold Sovereign BU Uncirculated Stunning',
        conditionDescriptors: [
            { name: 'Grader', values: [{ content: 'PCGS' }] },
            { name: 'Number Grade', values: [{ content: '62' }] },
            { name: 'Certification Number', values: [{ content: '88776655' }] }
        ]
    })
    assert.strictEqual(result.attributes.gradeBand, 'SLAB_MS62')
    assert.strictEqual(result.attributes.gradeSource, 'descriptor')
    assert.strictEqual(result.attributes.certNumber, '88776655')
})

test('listings without descriptors still classify from the title', () => {
    const result = classify({ title: 'Gold Sovereign NGC MS63 1957 Elizabeth II' })
    assert.strictEqual(result.attributes.gradeBand, 'SLAB_MS63')
    assert.strictEqual(result.attributes.gradeSource, 'title')
})

test('descriptor fields persist and survive re-ingestion', () => {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const base = {
        browseId: 'v1|1|0', legacyId: '1', title: 'Gold Sovereign',
        buyingOptions: 'AUCTION', endTime: new Date().toISOString()
    }
    repository.saveListing(Object.assign({}, base, {
        conditionDescriptors: [
            { name: 'Grader', values: [{ content: 'NGC' }] },
            { name: 'Certification Number', values: [{ content: '55443322' }] }
        ]
    }))
    /* A later sweep that returns no descriptors must not erase them. */
    repository.saveListing(base)

    const row = db.prepare('SELECT cert_number, grading_company FROM listing').get()
    assert.strictEqual(row.cert_number, '55443322')
    assert.strictEqual(row.grading_company, 'NGC')
})

/* ====================== relist / resale fingerprinting ==================== */

test('a certification number tracks the same coin across different sellers', () => {
    /*
        The seller+title fingerprint can only catch one seller relisting.
        A cert number names one physical coin, so it also catches a resale.
    */
    const day = (i) => new Date(Date.parse('2026-08-01') + i * 86400000).toISOString()
    const outcomes = [
        { endedAt: day(1), sellerHash: 'a', title: 'Sovereign 1974', certNumber: '88776655' },
        { endedAt: day(2), sellerHash: 'b', title: '1974 Gold Sovereign PCGS', certNumber: '88776655' }
    ]
    assert.strictEqual(LIQUIDITY.relistRate(outcomes), 0.5)
})

test('title normalisation strips seller theatre before punctuation', () => {
    /*
        Regression: noise phrases were stripped AFTER punctuation removal,
        so "free p&p" had already become "free p p" and never matched its
        own pattern - defeating the retitle detection it existed for.
    */
    const same = (a, b) => LIQUIDITY.normaliseTitle(a) === LIQUIDITY.normaliseTitle(b)
    assert.ok(same('RARE!! Sovereign 1974 free p&p', 'Sovereign 1974'))
    assert.ok(same('STUNNING 1912 Gold Sovereign L@@K', '1912 Gold Sovereign'))
    assert.ok(same('Gold Sovereign 1974 *** FREE POSTAGE ***', 'Gold Sovereign 1974'))
})

test('the immutable seller id is preferred over the username for fingerprinting', () => {
    /* A seller who renames themselves must not read as two people. */
    const withId = LIQUIDITY.fingerprint({ sellerIdHash: 'stable', sellerHash: 'old_name', title: 'Sovereign' })
    const renamed = LIQUIDITY.fingerprint({ sellerIdHash: 'stable', sellerHash: 'new_name', title: 'Sovereign' })
    assert.strictEqual(withId, renamed)
})
