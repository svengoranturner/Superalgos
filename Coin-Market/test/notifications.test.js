'use strict'

const test = require('node:test')
const assert = require('node:assert')
const CRYPTO = require('node:crypto')

const NOTIFICATIONS = require('../src/ebay/notifications.js')
const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')

const TOKEN = 'a'.repeat(40)
const ENDPOINT = 'https://metalhead.gold/ebay/account-deletion'

test('the challenge hash is over challenge + token + url, in that order', () => {
    /*
        Getting the order wrong produces a valid-looking hash that eBay
        rejects with "endpoint validation failed" and no further detail,
        which is a miserable thing to debug against a live form.
    */
    const expected = CRYPTO.createHash('sha256')
        .update('abc123').update(TOKEN).update(ENDPOINT).digest('hex')
    assert.strictEqual(NOTIFICATIONS.challengeResponse('abc123', TOKEN, ENDPOINT), expected)

    /* Order matters - a different arrangement must not collide. */
    const wrongOrder = CRYPTO.createHash('sha256')
        .update(TOKEN).update('abc123').update(ENDPOINT).digest('hex')
    assert.notStrictEqual(NOTIFICATIONS.challengeResponse('abc123', TOKEN, ENDPOINT), wrongOrder)
})

test('the endpoint URL is part of the hash, so a trailing slash changes it', () => {
    /* This is the single most common cause of validation failure. */
    assert.notStrictEqual(
        NOTIFICATIONS.challengeResponse('x', TOKEN, ENDPOINT),
        NOTIFICATIONS.challengeResponse('x', TOKEN, ENDPOINT + '/'))
})

test('verification tokens are validated against eBay\'s rules before use', () => {
    assert.strictEqual(NOTIFICATIONS.validateToken(TOKEN), null)
    assert.match(NOTIFICATIONS.validateToken('short'), /32-80/)
    assert.match(NOTIFICATIONS.validateToken('a'.repeat(100)), /32-80/)
    assert.match(NOTIFICATIONS.validateToken('has spaces ' + 'a'.repeat(30)), /letters, digits/)
    assert.strictEqual(NOTIFICATIONS.validateToken(NOTIFICATIONS.generateToken()), null)
})

test('a challenge GET returns the hash as JSON', () => {
    const handle = NOTIFICATIONS.newHandler({ verificationToken: TOKEN, endpointUrl: ENDPOINT })
    const url = new URL(ENDPOINT + '?challenge_code=zzz')
    const result = handle('GET', url, null)

    assert.strictEqual(result.status, 200)
    assert.strictEqual(result.contentType, 'application/json')
    assert.strictEqual(JSON.parse(result.body).challengeResponse,
        NOTIFICATIONS.challengeResponse('zzz', TOKEN, ENDPOINT))
})

test('a deletion notification actually purges that seller\'s data', () => {
    /*
        The point of subscribing rather than claiming an exemption: because
        seller ids are stored as a salted hash rather than discarded, the
        hash can be recomputed from the username eBay sends and the rows
        genuinely removed.
    */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test-salt' })

    repository.saveListing({
        browseId: 'v1|1|0', legacyId: '1', title: 'Gold Sovereign 1974',
        buyingOptions: 'AUCTION', sellerId: 'departing_seller',
        endTime: new Date().toISOString()
    })
    repository.saveListing({
        browseId: 'v1|2|0', legacyId: '2', title: 'Gold Sovereign 1982',
        buyingOptions: 'AUCTION', sellerId: 'staying_seller',
        endTime: new Date().toISOString()
    })
    repository.saveSnapshot('v1|1|0', { price: 400, endTime: new Date().toISOString() })

    const handle = NOTIFICATIONS.newHandler({
        verificationToken: TOKEN,
        endpointUrl: ENDPOINT,
        onDeletion: (username) => NOTIFICATIONS.purgeUser(repository, db, username)
    })

    const result = handle('POST', new URL(ENDPOINT), JSON.stringify({
        metadata: { topic: 'MARKETPLACE_ACCOUNT_DELETION' },
        notification: { data: { username: 'departing_seller', userId: 'abc', eiasToken: 'xyz' } }
    }))

    assert.strictEqual(result.status, 200)
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM listing').get().n, 1)
    assert.strictEqual(db.prepare('SELECT browse_id FROM listing').get().browse_id, 'v1|2|0')
    assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM listing_snapshot').get().n, 0,
        'dependent rows must go too')
})

test('a deletion for a seller we never saw succeeds quietly', () => {
    /* eBay broadcasts to every subscriber, so this is the normal case. */
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test-salt' })
    assert.strictEqual(NOTIFICATIONS.purgeUser(repository, db, 'never_seen'), 0)
})

test('a malformed notification never throws', () => {
    /*
        An exception reads to eBay as an unreachable endpoint, and repeated
        failures cost the keyset its activation. Always answer 200.
    */
    const handle = NOTIFICATIONS.newHandler({
        verificationToken: TOKEN, endpointUrl: ENDPOINT,
        onDeletion: () => { throw new Error('database on fire') }
    })
    assert.strictEqual(handle('POST', new URL(ENDPOINT), 'not json at all').status, 200)
    assert.strictEqual(handle('POST', new URL(ENDPOINT),
        JSON.stringify({ notification: { data: { username: 'x' } } })).status, 200)
})

test('a handler refuses to start with an invalid token', () => {
    assert.throws(() => NOTIFICATIONS.newHandler({ verificationToken: 'tooshort', endpointUrl: ENDPOINT }),
        /32-80/)
})
