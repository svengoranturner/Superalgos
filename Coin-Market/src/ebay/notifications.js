'use strict'

const CRYPTO = require('node:crypto')

/*
    eBay Marketplace Account Deletion / Closure notifications.

    eBay will not activate a production keyset until the developer either
    subscribes to these notifications or is granted an exemption. This
    module implements the subscription side.

    Two things happen at this endpoint:

      GET  ?challenge_code=...   eBay proves it can reach you, and you
                                 prove you own the endpoint, by returning
                                 SHA-256(challenge + token + url).

      POST {notification}        An eBay user deleted their account. Any
                                 data of theirs must be removed.

    The POST is handled for real rather than merely acknowledged. Because
    seller identifiers are stored as a salted hash rather than discarded,
    the same hash can be recomputed from the username in the notification
    and the matching rows purged - so the subscription is honoured rather
    than rubber-stamped.
*/

/*
    The hash is over the three values concatenated IN THIS ORDER, and the
    endpoint URL must match what is registered with eBay byte for byte -
    a trailing slash or an http/https mismatch is the usual cause of
    "endpoint validation failed".
*/
exports.challengeResponse = function (challengeCode, verificationToken, endpointUrl) {
    return CRYPTO.createHash('sha256')
        .update(String(challengeCode))
        .update(String(verificationToken))
        .update(String(endpointUrl))
        .digest('hex')
}

/*
    eBay requires the verification token to be 32-80 characters drawn from
    letters, digits, underscore and hyphen.
*/
exports.validateToken = function (token) {
    const value = String(token === undefined || token === null ? '' : token)
    if (value.length < 32 || value.length > 80) {
        return 'Verification token must be 32-80 characters (this one is ' + value.length + ')'
    }
    if (!/^[A-Za-z0-9_-]+$/.test(value)) {
        return 'Verification token may contain only letters, digits, underscore and hyphen'
    }
    return null
}

exports.generateToken = function () {
    return CRYPTO.randomBytes(32).toString('base64url').slice(0, 48)
}

/*
    Purges everything attributable to one eBay user.

    Returns the number of listing rows removed. A username we never saw
    yields zero, which is the normal case and still a successful response -
    eBay broadcasts deletions to every subscriber, not just those holding
    that user's data.
*/
exports.purgeUser = function (repository, db, username) {
    const sellerHash = repository.hashSeller(username)
    if (sellerHash === null) { return 0 }

    const doomed = db.prepare('SELECT browse_id FROM listing WHERE seller_hash = ?').all(sellerHash)
    if (doomed.length === 0) { return 0 }

    const ids = doomed.map(row => row.browse_id)
    db.exec('BEGIN')
    try {
        for (let i = 0; i < ids.length; i += 400) {
            const slice = ids.slice(i, i + 400)
            const marks = slice.map(() => '?').join(',')
            for (const table of ['listing_snapshot', 'aspect', 'listing_instrument',
                'review_queue', 'listing_outcome', 'alert', 'listing']) {
                db.prepare('DELETE FROM ' + table + ' WHERE browse_id IN (' + marks + ')').run(...slice)
            }
        }
        db.exec('COMMIT')
    } catch (err) {
        db.exec('ROLLBACK')
        throw err
    }
    return ids.length
}

/*
    The request handler, independent of any server so it can be tested
    directly and mounted anywhere.

    Returns { status, body, contentType } - never throws, because an
    exception here reads to eBay as an unreachable endpoint and costs the
    keyset its activation.
*/
exports.newHandler = function (options) {

    const { verificationToken, endpointUrl, onDeletion, log } = options
    const note = log || (() => {})

    const tokenProblem = exports.validateToken(verificationToken)
    if (tokenProblem !== null) { throw new Error(tokenProblem) }

    return function handle (method, url, bodyText) {
        try {
            if (method === 'GET') {
                const challengeCode = url.searchParams.get('challenge_code')
                if (challengeCode === null) {
                    /* A plain GET with no challenge - useful for checking
                       the route is reachable through a proxy or CDN. */
                    return { status: 200, contentType: 'text/plain', body: 'coin-market notification endpoint' }
                }
                const response = exports.challengeResponse(challengeCode, verificationToken, endpointUrl)
                note('challenge received, responded')
                return {
                    status: 200,
                    contentType: 'application/json',
                    body: JSON.stringify({ challengeResponse: response })
                }
            }

            if (method === 'POST') {
                let payload = {}
                try { payload = JSON.parse(bodyText || '{}') } catch (err) { payload = {} }

                const data = (payload.notification && payload.notification.data) || {}
                const username = data.username || null

                if (username !== null && typeof onDeletion === 'function') {
                    const removed = onDeletion(username)
                    note('account deletion for a known seller: purged ' + removed + ' listings')
                } else {
                    note('account deletion received' + (username === null ? ' (no username in payload)' : ' (no data held)'))
                }

                /*
                    eBay wants a prompt 200/204. Doing the purge first is
                    safe here because it is a local SQLite delete measured
                    in milliseconds; anything slower belongs on a queue.
                */
                return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }
            }

            return { status: 405, contentType: 'text/plain', body: 'Method not allowed' }
        } catch (err) {
            note('ERROR ' + err.message)
            /* Still a 200: eBay retries and eventually disables the
               subscription on repeated failures, and a transient bug on
               our side should not cost the keyset. */
            return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }
        }
    }
}
