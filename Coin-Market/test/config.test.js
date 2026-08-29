'use strict'

const test = require('node:test')
const assert = require('node:assert')

const CONFIG = require('../src/config.js')

/*
    Placeholder detection for init's credentials.

    This is here because the failure it prevents is silent: an init run with
    the instructions' own placeholder text in it writes a settings.json that
    looks entirely complete, and the first sign of trouble is an eBay auth
    error that mentions nothing about placeholders.
*/

test('the placeholder text people actually paste is refused', () => {
    for (const value of [
        'REAL_APP_ID', 'REAL_CERT_ID', 'REAL_DEV_ID',
        'YOUR-APP-ID', 'YOUR-CERT-ID', 'YOUR-DEV-ID',
        '...', '<app id>', 'xxxx', 'APP_ID', 'cert-secret'
    ]) {
        assert.strictEqual(CONFIG.looksUnfilled(value), true, value + ' should be refused')
    }
})

/*  The RuName placeholder is the same trap one step later: auth-url would
    otherwise print a consent URL carrying redirect_uri=YOUR-RUNAME, and the
    failure appears on eBay's error page rather than here. */
test('the RuName placeholder is refused too', () => {
    for (const value of ['YOUR-RUNAME', 'RU_NAME', 'your-redirect-url', 'my-runame']) {
        assert.strictEqual(CONFIG.looksUnfilled(value), true, value + ' should be refused')
    }
})

test('a real RuName is accepted', () => {
    assert.strictEqual(CONFIG.looksUnfilled('Rhys_Turner-RhysTurn-metalh-abcdef'), false)
})

test('an absent or blank value counts as unfilled', () => {
    for (const value of [undefined, null, '', '   ']) {
        assert.strictEqual(CONFIG.looksUnfilled(value), true)
    }
})

test('keys shaped like real eBay ones are accepted', () => {
    for (const value of [
        'Rhysturn-coinmark-SBX-9f2a1c4b7-4a5b6c7d',
        'a1b2c3d4-5e6f-7081-92a3-b4c5d6e7f809',
        'SBX-9f2a1c4b7e0d-1a2b-3c4d',
        'PRD-1a2b3c4d5e6f-7081-92a3'
    ]) {
        assert.strictEqual(CONFIG.looksUnfilled(value), false, value + ' should be accepted')
    }
})

/*  The anchor matters: a real key may well begin with one of the placeholder
    words without being one. Only the whole string counts. */
test('a real key is not refused for merely starting with a placeholder word', () => {
    assert.strictEqual(CONFIG.looksUnfilled('realistic-app-PRD-1a2b3c4d'), false)
    assert.strictEqual(CONFIG.looksUnfilled('yourcompany-tracker-SBX-9f2a1c'), false)
})

/*
    Carrying values through an "init --force=".

    The failure this prevents is silent and expensive: eBay holds a copy of
    the verification token, and every stored seller hash was computed with
    the salt. Regenerating either leaves a settings.json that looks correct
    and a subscription that no longer validates.
*/

const EXISTING = {
    sellerSalt: 'oldSaltThatHashesWereBuiltWith',
    ebay: {
        ruName: 'Rhys_Turner-RhysTurn-metalh-abcdef',
        refreshToken: 'v1.1#i#a-long-refresh-token-value',
        accountDeletion: {
            verificationToken: 'tokenEbayIsHoldingRightNow-1234567890abcd',
            endpointUrl: 'https://metalhead.gold/ebay/account-deletion'
        }
    }
}

function freshTemplate () {
    return {
        sellerSalt: 'brandNewSalt',
        ebay: {
            ruName: 'YOUR-RUNAME',
            accountDeletion: { verificationToken: 'brandNewToken', endpointUrl: 'https://example.com/x' }
        }
    }
}

test('the salt and the verification token survive an overwrite', () => {
    const out = CONFIG.carryForward(EXISTING, freshTemplate())
    assert.strictEqual(out.sellerSalt, EXISTING.sellerSalt)
    assert.strictEqual(out.ebay.accountDeletion.verificationToken,
        EXISTING.ebay.accountDeletion.verificationToken)
})

test('a hard-won RuName, refresh token and endpoint survive too', () => {
    const out = CONFIG.carryForward(EXISTING, freshTemplate())
    assert.strictEqual(out.ebay.ruName, EXISTING.ebay.ruName)
    assert.strictEqual(out.ebay.refreshToken, EXISTING.ebay.refreshToken)
    assert.strictEqual(out.ebay.accountDeletion.endpointUrl,
        EXISTING.ebay.accountDeletion.endpointUrl)
})

test('placeholder values in the old file are not carried forward', () => {
    const stale = { ebay: { ruName: 'YOUR-RUNAME', accountDeletion: { verificationToken: '' } } }
    const out = CONFIG.carryForward(stale, freshTemplate())
    assert.strictEqual(out.ebay.ruName, 'YOUR-RUNAME')
    assert.strictEqual(out.ebay.accountDeletion.verificationToken, 'brandNewToken')
})

test('a first install has nothing to carry and is returned untouched', () => {
    const template = freshTemplate()
    assert.strictEqual(CONFIG.carryForward(null, template), template)
})

test('the source object is never mutated', () => {
    const template = freshTemplate()
    CONFIG.carryForward(EXISTING, template)
    assert.strictEqual(template.sellerSalt, 'brandNewSalt')
    assert.strictEqual(EXISTING.sellerSalt, 'oldSaltThatHashesWereBuiltWith')
})

test('what was carried is reported, so init can say so', () => {
    const out = CONFIG.carryForward(EXISTING, freshTemplate())
    assert.ok(out.carriedForward.includes('sellerSalt'))
    assert.ok(out.carriedForward.includes('ebay.accountDeletion.verificationToken'))
    /* Non-enumerable, so it never lands in the written JSON. */
    assert.ok(!Object.keys(out).includes('carriedForward'))
    assert.ok(!('carriedForward' in JSON.parse(JSON.stringify(out))))
})
