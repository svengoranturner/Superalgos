'use strict'

const CRYPTO = require('node:crypto')
const STORE = require('../store/db.js')

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
exports.purgeUser = function (repository, db, identifiers) {
    /*
        eBay replaced usernames with immutable user IDs in May 2026, and a
        notification may name the departing user by either. Accepts a bare
        string (legacy callers) or {username, userId}, and matches on ANY
        hash we hold - a purge keyed on only one of them would answer eBay
        200 while deleting nothing, which is the precise obligation we
        subscribed in order to meet.
    */
    const spec = typeof identifiers === 'string' ? { username: identifiers } : (identifiers || {})

    const hashes = [spec.username, spec.userId]
        .filter(value => value !== null && value !== undefined && String(value).length > 0)
        .map(value => repository.hashSeller(value))

    if (hashes.length === 0) { return 0 }

    const marks = hashes.map(() => '?').join(',')
    const doomed = db.prepare(
        'SELECT browse_id FROM listing WHERE seller_hash IN (' + marks + ') ' +
        'OR seller_id_hash IN (' + marks + ')'
    ).all(...hashes, ...hashes)
    if (doomed.length === 0) { return 0 }

    const ids = doomed.map(row => row.browse_id)
    /*
        ONE TRANSACTION, AND IT TAKES THE LOCK UP FRONT.

        This was a bare `db.exec('BEGIN')` with no retry. A bare BEGIN is
        DEFERRED: it takes the write lock at the first write, and SQLite
        cannot honour busy_timeout on that upgrade - it would have to hand
        back a snapshot another connection has already contradicted - so it
        returns SQLITE_BUSY at once however long the timeout is. This process
        shares the file with the collector, which writes every five minutes,
        so losing that race was routine rather than exotic.

        And the comment on the handler below called this "a local SQLite
        delete measured in milliseconds", which stopped being true the moment
        anything else could hold the lock for longer.

        Deliberately ONE transaction across every chunk, unlike purgeExpired
        beside it: that one is retention housekeeping, where a half-finished
        pass is finished tomorrow. This is a deletion obligation. Half a
        user's rows removed and half left is the state that must not exist,
        and the row count here is one seller's listings rather than every
        expired row in the store.
    */
    STORE.inTransaction(db, () => {
        for (let i = 0; i < ids.length; i += 400) {
            const slice = ids.slice(i, i + 400)
            const marks = slice.map(() => '?').join(',')
            for (const table of ['listing_snapshot', 'aspect', 'listing_instrument',
                'review_queue', 'listing_outcome', 'alert', 'listing']) {
                db.prepare('DELETE FROM ' + table + ' WHERE browse_id IN (' + marks + ')').run(...slice)
            }
        }
    })
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
                const identifiers = { username: data.username || null, userId: data.userId || null }
                const named = identifiers.username !== null || identifiers.userId !== null

                if (named && typeof onDeletion === 'function') {
                    try {
                        const removed = onDeletion(identifiers)
                        note('account deletion: purged ' + removed + ' listings')
                    } catch (err) {
                        /*
                            A FAILED PURGE MUST NOT ANSWER 200.

                            This used to fall through to the catch below and
                            answer 200 with {ok:false} - so eBay recorded the
                            deletion as delivered and moved on, while the
                            user's rows were still on disk and nothing
                            anywhere remembered that they should not be. The
                            module's own header says the POST is "handled for
                            real rather than merely acknowledged"; a 200 here
                            is exactly the rubber stamp it promises not to be.

                            The comment defending it worried that failures
                            cost the keyset its activation, and that is true
                            of SUSTAINED failure - eBay retries with backoff
                            and disables a subscription that never recovers.
                            But that is the right trade in both directions: a
                            transient failure gets retried and the data does
                            go, and a persistent one is a broken database that
                            ought to be loud rather than papered over. The
                            purge itself now retries and takes the write lock
                            up front, so contention - the one realistic cause
                            - no longer reaches here at all.

                            Only the deletion path answers this way. A
                            malformed payload still gets 200, because we hold
                            no data for it and there is nothing to retry.
                        */
                        note('ERROR account deletion FAILED, data still held: ' + err.message)
                        return {
                            status: 503,
                            contentType: 'application/json',
                            body: JSON.stringify({ ok: false, retry: true })
                        }
                    }
                } else {
                    note('account deletion received' + (named ? ' (no data held)' : ' (no identifier in payload)'))
                }

                /*  eBay wants a prompt 200/204, and by here the purge has
                    actually happened. */
                return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }
            }

            return { status: 405, contentType: 'text/plain', body: 'Method not allowed' }
        } catch (err) {
            note('ERROR ' + err.message)
            /*  Still a 200, and only for what is left after the deletion
                path takes its own failures above: a challenge we could not
                answer, or a body we could not parse. We hold no data for
                either, so there is nothing for eBay to retry and no reason
                to spend the keyset's activation on it. */
            return { status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false }) }
        }
    }
}
