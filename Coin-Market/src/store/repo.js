'use strict'

const CRYPTO = require('node:crypto')

/*
    Data access.

    Two policies are enforced here rather than left to callers:

      - Seller identifiers are salted-hashed on the way in and the raw
        username is never stored. Relist detection needs to know that two
        listings share a seller; it does not need to know who. Holding no
        third-party personal data is also what makes it legitimate to opt
        out of eBay's account-deletion notification requirement.

      - Every raw listing row carries an expiry. Derived per-instrument
        statistics are ours and are kept; raw eBay item data is not, and
        rolls off.
*/

const DAY_MS = 24 * 60 * 60 * 1000

/*
    node:sqlite refuses to bind `undefined`, and an object that simply
    omits an optional field is the normal case here - a Browse summary
    without shipping options, a listing with no condition label. Coercing
    at this boundary keeps every call site from having to remember.
*/
function bindable (value) {
    if (value === undefined) { return null }
    if (typeof value === 'number' && !Number.isFinite(value)) { return null }
    if (typeof value === 'boolean') { return value ? 1 : 0 }
    return value
}

function bindAll (statement, values) {
    return statement.run(...values.map(bindable))
}

exports.newRepository = function (db, options) {

    const config = Object.assign({ sellerSalt: 'coin-market', rawRetentionDays: 180 }, options || {})

    const hashSeller = (sellerId) => sellerId === null || sellerId === undefined
        ? null
        : CRYPTO.createHash('sha256').update(config.sellerSalt + '|' + sellerId).digest('hex').slice(0, 16)

    const statements = {
        upsertListing: db.prepare(`
            INSERT INTO listing (browse_id, legacy_id, marketplace, title, category_id, condition_label,
                                 buying_options, currency, seller_hash, seller_id_hash,
                                 seller_feedback_pct, seller_feedback_cnt,
                                 item_web_url, image_url, start_time, end_time, first_seen, last_seen, expires_at,
                                 cert_number, grading_company, grade_numeric, grade_letter, condition_band)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(browse_id) DO UPDATE SET
                last_seen = excluded.last_seen,
                end_time = COALESCE(excluded.end_time, listing.end_time),
                legacy_id = COALESCE(excluded.legacy_id, listing.legacy_id),
                buying_options = excluded.buying_options,
                expires_at = excluded.expires_at,
                /* Backfill identity and condition detail as eBay starts
                   supplying them, without clobbering what we already hold. */
                seller_id_hash = COALESCE(excluded.seller_id_hash, listing.seller_id_hash),
                cert_number = COALESCE(excluded.cert_number, listing.cert_number),
                grading_company = COALESCE(excluded.grading_company, listing.grading_company),
                grade_numeric = COALESCE(excluded.grade_numeric, listing.grade_numeric),
                grade_letter = COALESCE(excluded.grade_letter, listing.grade_letter),
                condition_band = COALESCE(excluded.condition_band, listing.condition_band)
        `),
        insertSnapshot: db.prepare(`
            INSERT OR REPLACE INTO listing_snapshot (browse_id, observed_at, price, shipping, bid_count, seconds_to_end)
            VALUES (?,?,?,?,?,?)
        `),
        insertOutcome: db.prepare(`
            INSERT OR REPLACE INTO listing_outcome
                (browse_id, ended_at, resolved_at, sold, final_price, shipping, bid_count, sale_type, censored, source)
            VALUES (?,?,?,?,?,?,?,?,?,?)
        `),
        assignInstrument: db.prepare(`
            INSERT OR REPLACE INTO listing_instrument (browse_id, key, confidence, method, verified, assigned_at)
            VALUES (?,?,?,?,?,?)
        `),
        upsertInstrument: db.prepare(`
            INSERT INTO instrument (key, level, display_name, metal, fine_oz, attributes)
            VALUES (?,?,?,?,?,?)
            ON CONFLICT(key) DO NOTHING
        `),
        queueReview: db.prepare(`
            INSERT OR REPLACE INTO review_queue (browse_id, reason, best_guess, confidence, queued_at)
            VALUES (?,?,?,?,?)
        `),
        insertAspect: db.prepare('INSERT OR REPLACE INTO aspect (browse_id, name, value) VALUES (?,?,?)'),
        markAspectsFetched: db.prepare('UPDATE listing SET aspects_fetched = 1 WHERE browse_id = ?')
    }

    return {
        hashSeller,

        saveListing (listing, seenAt) {
            const now = seenAt || new Date().toISOString()
            const expires = new Date(Date.now() + config.rawRetentionDays * DAY_MS).toISOString()

            const CONDITIONS = require('../catalogue/conditions.js')
            const descriptors = CONDITIONS.parseDescriptors(listing.conditionDescriptors)

            /* sellerId is retained as an alias for the username so callers
               written before the immutable-id change keep working. */
            const username = listing.sellerUsername !== undefined ? listing.sellerUsername : listing.sellerId

            bindAll(statements.upsertListing, [
                listing.browseId, listing.legacyId, listing.marketplace || 'EBAY_GB',
                listing.title, listing.categoryId, listing.conditionLabel,
                listing.buyingOptions, listing.currency || 'GBP',
                hashSeller(username), hashSeller(listing.sellerUserId),
                listing.sellerFeedbackPct, listing.sellerFeedbackCount,
                listing.itemWebUrl, listing.imageUrl, listing.startTime || null, listing.endTime,
                now, now, expires,
                descriptors.certNumber, descriptors.gradingCompany,
                descriptors.gradeNumeric, descriptors.gradeLetter, descriptors.conditionBand
            ])
        },

        saveSnapshot (browseId, observation) {
            const observedAt = observation.observedAt || new Date().toISOString()
            let secondsToEnd = null
            if (observation.endTime) {
                secondsToEnd = Math.round(
                    (new Date(observation.endTime).getTime() - new Date(observedAt).getTime()) / 1000
                )
            }
            /* An auction's live price is currentBidPrice; price alone is the
               BIN price and would flat-line the whole bid history. */
            const price = Number.isFinite(observation.currentBidPrice)
                ? observation.currentBidPrice
                : observation.price
            bindAll(statements.insertSnapshot, [
                browseId, observedAt, price, observation.shipping,
                observation.bidCount, secondsToEnd
            ])
        },

        saveOutcome (browseId, outcome) {
            bindAll(statements.insertOutcome, [
                browseId, outcome.endTime, new Date().toISOString(),
                outcome.sold ? 1 : 0, outcome.finalPrice, outcome.shipping || null,
                outcome.bidCount, outcome.saleType, outcome.censored ? 1 : 0, outcome.source
            ])
        },

        saveClassification (browseId, keys, confidence, method, fineOz, attributes) {
            const now = new Date().toISOString()
            const INSTRUMENTS = require('../catalogue/instruments.js')
            for (const entry of keys) {
                bindAll(statements.upsertInstrument, [
                    entry.key, entry.level, INSTRUMENTS.displayName(entry.key),
                    'XAU', fineOz, JSON.stringify(attributes || {})
                ])
                bindAll(statements.assignInstrument, [browseId, entry.key, confidence, method, 0, now])
            }
        },

        queueForReview (browseId, reason, bestGuess, confidence) {
            bindAll(statements.queueReview, [browseId, reason, bestGuess, confidence, new Date().toISOString()])
        },

        saveAspects (browseId, aspects) {
            for (const [name, value] of Object.entries(aspects || {})) {
                bindAll(statements.insertAspect, [browseId, name, String(value)])
            }
            statements.markAspectsFetched.run(browseId)
        },

        /* Lots that have ended but whose outcome we have not resolved.
           Ordered oldest-first because the 90-day GetItem window is a
           deadline: an unresolved lot eventually becomes unresolvable.

           One row per LEGACY id, not per browse id. A multi-variation
           listing appears once per variation, each with its own browse id
           but all sharing the legacy item number - and GetItem answers for
           the listing, not the variation. Resolving each variation would
           spend a Trading call per variation and, worse, write an outcome
           row per variation for a single physical sale, so every one of
           them would be counted again in the clearing statistics. One sale,
           one outcome.

           The NOT EXISTS is what keeps that true over time: once any
           variation of a listing has an outcome, none of its siblings are
           offered again. Without it the group would simply nominate an
           unresolved sibling next cycle and resolve the same lot forever. */
        pendingOutcomes (limit) {
            return db.prepare(`
                SELECT l.browse_id AS browseId, l.legacy_id AS legacyId, MIN(l.end_time) AS endTime
                FROM listing l
                WHERE l.end_time IS NOT NULL
                  AND l.end_time < ?
                  AND l.end_time > ?
                  AND l.legacy_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM listing_outcome o
                      JOIN listing sibling ON sibling.browse_id = o.browse_id
                      WHERE sibling.legacy_id = l.legacy_id
                  )
                GROUP BY l.legacy_id
                ORDER BY endTime ASC
                LIMIT ?
            `).all(
                new Date().toISOString(),
                new Date(Date.now() - 88 * DAY_MS).toISOString(),   /* inside the 90-day window, with margin */
                limit || 100
            )
        },

        /* Sold auctions with their premium inputs, for fair value. */
        clearingObservations (key, sinceIso) {
            return db.prepare(`
                SELECT o.browse_id AS browseId, o.ended_at AS endedAt, o.final_price AS finalPrice,
                       o.shipping, o.bid_count AS bidCount, o.sale_type AS saleType,
                       o.sold, o.censored, l.title, l.seller_hash AS sellerHash,
                       l.seller_id_hash AS sellerIdHash, l.cert_number AS certNumber,
                       l.start_time AS listedAt, i.fine_oz AS fineOz
                FROM listing_outcome o
                JOIN listing_instrument li ON li.browse_id = o.browse_id
                JOIN listing l ON l.browse_id = o.browse_id
                JOIN instrument i ON i.key = li.key
                WHERE li.key = ? AND o.ended_at >= ?
                ORDER BY o.ended_at DESC
            `).all(key, sinceIso)
        },

        /*
            Live listings for one instrument, which is the whole ask side of
            the spread.

            end_time IS NULL counts as active. A Good-'Til-Cancelled
            fixed-price listing has no end time at all, and testing
            `end_time > now` is false for NULL - so the old form silently
            excluded 93% of the store (4,841 of 5,204 rows) and with it
            almost every ask. The tool exists to compare where auctions clear
            against what sellers ask, and the asks were invisible.

            last_seen is what keeps that honest. Without an end time there is
            no other signal that a listing has gone, so one that has not
            appeared in a sweep for a day is treated as finished rather than
            lingering in the ask sample forever.
        */
        activeListings (key) {
            return db.prepare(`
                SELECT l.browse_id AS browseId, l.title, l.buying_options AS buyingOptions,
                       l.end_time AS endTime, l.item_web_url AS itemWebUrl, i.fine_oz AS fineOz,
                       s.price, s.shipping, s.bid_count AS bidCount
                FROM listing l
                JOIN listing_instrument li ON li.browse_id = l.browse_id
                JOIN instrument i ON i.key = li.key
                LEFT JOIN listing_outcome o ON o.browse_id = l.browse_id
                LEFT JOIN (
                    SELECT browse_id, price, shipping, bid_count,
                           ROW_NUMBER() OVER (PARTITION BY browse_id ORDER BY observed_at DESC) AS rn
                    FROM listing_snapshot
                ) s ON s.browse_id = l.browse_id AND s.rn = 1
                WHERE li.key = ?
                  AND o.browse_id IS NULL
                  AND (l.end_time IS NULL OR l.end_time > ?)
                  AND l.last_seen > ?
                ORDER BY l.end_time IS NULL, l.end_time ASC
            `).all(
                key,
                new Date().toISOString(),
                new Date(Date.now() - (config.activeWithinHours || 24) * 60 * 60 * 1000).toISOString()
            )
        },

        /* Snapshot/final-price pairs that teach the uplift curve. */
        upliftSamples (sinceIso) {
            return db.prepare(`
                SELECT s.seconds_to_end AS secondsToEnd, s.price, o.final_price AS finalPrice
                FROM listing_snapshot s
                JOIN listing_outcome o ON o.browse_id = s.browse_id
                WHERE o.sold = 1 AND o.sale_type = 'AUCTION' AND o.censored = 0
                  AND o.ended_at >= ? AND s.seconds_to_end >= 0 AND s.price > 0
            `).all(sinceIso)
        },

        /* The last thing we observed before a lot closed - the fallback
           when eBay will no longer tell us how it ended. */
        lastSnapshot (browseId) {
            return db.prepare(`
                SELECT s.price, s.bid_count AS bidCount, s.observed_at AS observedAt,
                       s.shipping, l.end_time AS endTime, l.buying_options AS buyingOptions
                FROM listing_snapshot s JOIN listing l ON l.browse_id = s.browse_id
                WHERE s.browse_id = ? ORDER BY s.observed_at DESC LIMIT 1
            `).get(browseId) || null
        },

        instruments (minLevel, maxLevel) {
            return db.prepare(`
                SELECT i.key, i.level, i.display_name AS displayName, i.fine_oz AS fineOz,
                       COUNT(DISTINCT li.browse_id) AS listingCount
                FROM instrument i
                LEFT JOIN listing_instrument li ON li.key = i.key
                WHERE i.level BETWEEN ? AND ?
                GROUP BY i.key
                ORDER BY listingCount DESC
            `).all(minLevel === undefined ? 0 : minLevel, maxLevel === undefined ? 4 : maxLevel)
        },

        reviewQueue (limit) {
            return db.prepare(`
                SELECT r.browse_id AS browseId, r.reason, r.best_guess AS bestGuess,
                       r.confidence, l.title, l.item_web_url AS itemWebUrl
                FROM review_queue r JOIN listing l ON l.browse_id = r.browse_id
                WHERE r.resolved_at IS NULL
                ORDER BY r.queued_at DESC LIMIT ?
            `).all(limit || 50)
        },

        /* Retention: raw eBay rows roll off, derived statistics stay. */
        purgeExpired (nowIso) {
            const now = nowIso || new Date().toISOString()
            const doomed = db.prepare('SELECT browse_id FROM listing WHERE expires_at < ?').all(now)
            if (doomed.length === 0) { return 0 }

            db.exec('BEGIN')
            try {
                const ids = doomed.map(r => r.browse_id)
                const chunk = 400
                for (let i = 0; i < ids.length; i += chunk) {
                    const slice = ids.slice(i, i + chunk)
                    const marks = slice.map(() => '?').join(',')
                    for (const table of ['listing_snapshot', 'aspect', 'listing_instrument', 'review_queue', 'listing_outcome', 'listing']) {
                        db.prepare('DELETE FROM ' + table + ' WHERE browse_id IN (' + marks + ')').run(...slice)
                    }
                }
                db.exec('COMMIT')
            } catch (err) {
                db.exec('ROLLBACK')
                throw err
            }
            return doomed.length
        },

        config
    }
}
