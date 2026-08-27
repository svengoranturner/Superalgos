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
