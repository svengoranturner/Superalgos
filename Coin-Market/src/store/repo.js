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
            INSERT INTO listing (browse_id, legacy_id, marketplace, title, category_id, category_path, item_country, condition_label,
                                 buying_options, currency, seller_hash, seller_id_hash,
                                 seller_feedback_pct, seller_feedback_cnt,
                                 item_web_url, image_url, start_time, end_time, first_seen, last_seen, expires_at,
                                 cert_number, grading_company, grade_numeric, grade_letter, condition_band)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT(browse_id) DO UPDATE SET
                last_seen = excluded.last_seen,
                end_time = COALESCE(excluded.end_time, listing.end_time),
                legacy_id = COALESCE(excluded.legacy_id, listing.legacy_id),
                buying_options = excluded.buying_options,
                category_path = COALESCE(excluded.category_path, listing.category_path),
                /* Backfilled on the next sweep; never cleared back to NULL. */
                item_country = COALESCE(excluded.item_country, listing.item_country),
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
            INSERT OR REPLACE INTO listing_instrument
                (browse_id, key, confidence, method, verified, assigned_at, quantity)
            VALUES (?,?,?,?,?,?,?)
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
                listing.title, listing.categoryId, listing.categoryPath || null,
                listing.itemCountry || null, listing.conditionLabel,
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
            /*  The instrument records what ONE of these coins is; the
                assignment records how many of them this lot holds. Writing a
                three-coin lot straight into instrument.fine_oz would have
                changed the melt for every single coin filed under the same
                key. */
            const quantity = Number.isFinite(attributes && attributes.quantity) && attributes.quantity > 1
                ? Math.floor(attributes.quantity)
                : 1
            for (const entry of keys) {
                bindAll(statements.upsertInstrument, [
                    entry.key, entry.level, INSTRUMENTS.displayName(entry.key),
                    'XAU', fineOz, JSON.stringify(attributes || {})
                ])
                bindAll(statements.assignInstrument,
                    [browseId, entry.key, confidence, method, 0, now, quantity])
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
                       l.start_time AS listedAt, i.fine_oz * li.quantity AS fineOz
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
                /*  The scope CTE is load-bearing, not tidiness.

                    Ranking every snapshot and then throwing away all but one
                    instrument's cost 435ms per call, and the market page
                    calls this once per coin type - 19 seconds to render a
                    page of forty rows, growing with every sweep. Restricting
                    the window to this instrument's own listings first takes
                    it to a few milliseconds. */
                WITH scope AS (
                    SELECT browse_id FROM listing_instrument WHERE key = ?1
                ),
                latest AS (
                    SELECT browse_id, price, shipping, bid_count FROM (
                        SELECT s.browse_id, s.price, s.shipping, s.bid_count,
                               ROW_NUMBER() OVER (PARTITION BY s.browse_id
                                                  ORDER BY s.observed_at DESC) AS rn
                        FROM listing_snapshot s
                        JOIN scope ON scope.browse_id = s.browse_id
                    ) WHERE rn = 1
                )
                SELECT l.browse_id AS browseId, l.title, l.buying_options AS buyingOptions,
                       l.end_time AS endTime, l.item_web_url AS itemWebUrl,
                       i.fine_oz * li.quantity AS fineOz,
                       s.price, s.shipping, s.bid_count AS bidCount
                FROM listing l
                JOIN listing_instrument li ON li.browse_id = l.browse_id
                JOIN instrument i ON i.key = li.key
                LEFT JOIN listing_outcome o ON o.browse_id = l.browse_id
                LEFT JOIN latest s ON s.browse_id = l.browse_id
                WHERE li.key = ?1
                  AND o.browse_id IS NULL
                  AND (l.end_time IS NULL OR l.end_time > ?2)
                  AND l.last_seen > ?3
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
                       r.confidence, l.title, l.item_web_url AS itemWebUrl,
                       /*  The stable identity of the coin, which is what a
                           human decision is recorded against - browse_id
                           changes when a seller relists and a verdict
                           should not have to be given twice. */
                       l.legacy_id AS legacyId,
                       lb.verdict AS verdict, lb.denomination AS labelledDenomination,
                       lb.quantity AS labelledQuantity,
                       /*  Everything a glance needs, so the queue can be
                           worked without opening a tab per listing. All of
                           it is already stored - none of this costs an API
                           call. */
                       l.image_url AS imageUrl, l.category_path AS categoryPath,
                       l.condition_label AS conditionLabel, l.buying_options AS buyingOptions,
                       l.seller_feedback_pct AS sellerFeedbackPct,
                       l.seller_feedback_cnt AS sellerFeedbackCnt,
                       l.end_time AS endTime, l.first_seen AS firstSeen,
                       l.item_country AS itemCountry,
                       /*  Whether this listing is still counted in the
                           market statistics. 686 of the uncertain ones are,
                           and those are the only ones distorting a number
                           on the front page - so they are the ones worth a
                           human's attention first. */
                       CASE WHEN EXISTS (
                           SELECT 1 FROM listing_instrument li WHERE li.browse_id = r.browse_id
                       ) THEN 1 ELSE 0 END AS priced,
                       /*  The asking price, so the review page can say what
                           it implies. A "gold sovereign" priced below its own
                           gold content is not a coin needing a decision - it
                           is something else wearing the word, and that is
                           worth showing rather than making a human squint at
                           every title. */
                       s.price, s.shipping, s.bid_count AS bidCount
                FROM review_queue r
                JOIN listing l ON l.browse_id = r.browse_id
                LEFT JOIN listing_label lb ON lb.legacy_id = l.legacy_id
                /*  Same restriction as activeListings: rank only the
                    snapshots of listings actually in the queue. */
                LEFT JOIN (
                    SELECT s.browse_id, s.price, s.shipping, s.bid_count,
                           ROW_NUMBER() OVER (PARTITION BY s.browse_id
                                              ORDER BY s.observed_at DESC) AS rn
                    FROM listing_snapshot s
                    JOIN review_queue rq ON rq.browse_id = s.browse_id AND rq.resolved_at IS NULL
                ) s ON s.browse_id = r.browse_id AND s.rn = 1
                WHERE r.resolved_at IS NULL
                /*  Impact before recency. A listing still counted in the
                    market statistics is the only kind that can be making a
                    number wrong, and newest-first buried those among 1,536
                    already-dropped rows shown for auditability. */
                ORDER BY priced DESC, r.queued_at DESC LIMIT ?
            `).all(limit || 50)
        },

        /* ------------------------------------------------- human labels */

        /*
            One decision per coin, keyed on legacy_id so it survives a
            relist. Re-labelling overwrites: a person changing their mind is
            a correction, not a second opinion to be averaged with the first.
        */
        label (entry) {
            const now = entry.labelledAt || new Date().toISOString()
            const quantity = Number.isFinite(entry.quantity) && entry.quantity >= 1
                ? Math.floor(entry.quantity)
                : 1
            return bindAll(db.prepare(`
                INSERT INTO listing_label
                    (legacy_id, title, verdict, denomination, note, labelled_at, source, quantity)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(legacy_id) DO UPDATE SET
                    title = excluded.title, verdict = excluded.verdict,
                    denomination = excluded.denomination, note = excluded.note,
                    labelled_at = excluded.labelled_at, source = excluded.source,
                    quantity = excluded.quantity
            `), [entry.legacyId, entry.title, entry.verdict, entry.denomination,
                entry.note, now, entry.source || 'human', quantity])
        },

        unlabel (legacyId) {
            return db.prepare('DELETE FROM listing_label WHERE legacy_id = ?').run(legacyId)
        },

        labels () {
            return db.prepare(`
                SELECT legacy_id AS legacyId, title, verdict, denomination, note,
                       labelled_at AS labelledAt, source, quantity
                FROM listing_label ORDER BY labelled_at DESC
            `).all()
        },

        /*
            Labels indexed for the classifier's hot path. Returned as a Map
            rather than queried per listing: reclassify walks thousands of
            rows and a statement per row on a Pi is the difference between
            seconds and minutes.
        */
        labelIndex () {
            const map = new Map()
            for (const row of this.labels()) { map.set(row.legacyId, row) }
            return map
        },

        /*
            Every distinct title currently tracked, and whether it is being
            priced right now.

            The second column is what makes a proposed rule safe to judge.
            Reach alone does not distinguish "hardy" - 35 listings, none of
            them priced, all fly reels - from "london", which reaches 233
            and would destroy 97 sovereigns currently in the market
            statistics. Both look like good rules on support alone.
        */
        titleCorpus () {
            return db.prepare(`
                SELECT l.legacy_id AS legacyId, MIN(l.title) AS title,
                       MAX(CASE WHEN li.browse_id IS NOT NULL AND q.browse_id IS NULL
                                THEN 1 ELSE 0 END) AS priced
                FROM listing l
                LEFT JOIN listing_instrument li ON li.browse_id = l.browse_id
                LEFT JOIN review_queue q ON q.browse_id = l.browse_id AND q.resolved_at IS NULL
                WHERE l.legacy_id IS NOT NULL
                GROUP BY l.legacy_id
            `).all()
        },

        /*
            The individual listings behind one number on the market page.

            Without this there is no way to reach a junk listing that is
            polluting an asking premium: the front page shows aggregates and
            the review queue is keyed on doubt, not on which coin type a
            listing landed in. Something you can see is wrong but cannot
            dismiss from where you noticed it may as well not be reviewable.

            Ordered by asking price, because a lot priced far from its
            neighbours is both the most likely to be wrong and the most
            visible when it is.
        */
        listingsForInstrument (key, limit) {
            return db.prepare(`
                /*  The scope CTE is what makes this affordable on a Pi:
                    windowing all 90,000 snapshot rows instead of just this
                    instrument's cost 459ms against 192ms. */
                WITH scope AS (
                    SELECT browse_id FROM listing_instrument WHERE key = ?1
                ),
                latest AS (
                    SELECT browse_id, price, shipping, bid_count, observed_at FROM (
                        SELECT s.browse_id, s.price, s.shipping, s.bid_count, s.observed_at,
                               ROW_NUMBER() OVER (PARTITION BY s.browse_id
                                                  ORDER BY s.observed_at DESC) AS rn
                        FROM listing_snapshot s
                        JOIN scope ON scope.browse_id = s.browse_id
                    ) WHERE rn = 1
                )
                SELECT l.browse_id AS browseId, l.legacy_id AS legacyId, l.title,
                       l.item_web_url AS itemWebUrl, l.image_url AS imageUrl,
                       l.category_path AS categoryPath, l.condition_label AS conditionLabel,
                       l.buying_options AS buyingOptions,
                       l.seller_feedback_pct AS sellerFeedbackPct,
                       l.seller_feedback_cnt AS sellerFeedbackCnt,
                       l.end_time AS endTime, l.last_seen AS lastSeen, l.first_seen AS firstSeen,
                       l.item_country AS itemCountry,
                       li.confidence, li.quantity AS lotQuantity,
                       i.fine_oz * li.quantity AS fineOz,
                       s.price, s.shipping, s.bid_count AS bidCount,
                       COALESCE(s.price, 0) + COALESCE(s.shipping, 0) AS totalCost,
                       1 AS priced,
                       q.reason,
                       lb.verdict, lb.denomination AS labelledDenomination,
                       lb.quantity AS labelledQuantity,
                       /*  The same three conditions as activeListings: no
                           resolved outcome, not past its end time (a NULL
                           end time is Good-Til-Cancelled and counts as
                           live), and seen in a sweep within the day. It has
                           to agree exactly, or this page contradicts the
                           Live column that led you to it. */
                       CASE WHEN o.browse_id IS NULL
                                 AND (l.end_time IS NULL OR l.end_time > ?2)
                                 AND l.last_seen > ?3
                            THEN 1 ELSE 0 END AS live
                FROM listing_instrument li
                JOIN listing l ON l.browse_id = li.browse_id
                JOIN instrument i ON i.key = li.key
                LEFT JOIN latest s ON s.browse_id = l.browse_id
                LEFT JOIN review_queue q ON q.browse_id = l.browse_id AND q.resolved_at IS NULL
                LEFT JOIN listing_label lb ON lb.legacy_id = l.legacy_id
                LEFT JOIN listing_outcome o ON o.browse_id = l.browse_id
                WHERE li.key = ?1
                /*  Live first, then dearest. Within one key fine_oz is
                    constant, so the dearest lot is also the highest premium
                    - which keeps the order meaningful on a day the gold
                    feed has a gap. */
                ORDER BY live DESC, totalCost DESC
                LIMIT ?4
            `).all(
                key,
                new Date().toISOString(),
                new Date(Date.now() - (config.activeWithinHours || 24) * 60 * 60 * 1000).toISOString(),
                limit || 200
            )
        },

        /* -------------------------------------------------- settings */

        setting (key, fallback) {
            const row = db.prepare('SELECT value FROM setting WHERE key = ?').get(key)
            if (row === undefined) { return fallback }
            try { return JSON.parse(row.value) } catch (err) { return fallback }
        },

        setSetting (key, value) {
            return bindAll(db.prepare(`
                INSERT INTO setting (key, value, updated_at) VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET value = excluded.value,
                                              updated_at = excluded.updated_at
            `), [key, JSON.stringify(value), new Date().toISOString()])
        },

        /*  Which countries the corpus actually contains, with counts, so the
            cost of narrowing the filter is visible before it is paid rather
            than discovered afterwards. */
        countryCounts () {
            return db.prepare(`
                /*  COUNT(DISTINCT), not COUNT(*): a listing has one row per
                    instrument level it was filed under, so the join multiplies
                    it about three times over and the United Kingdom came out
                    holding 9,523 of a 5,490-listing corpus. */
                SELECT COALESCE(l.item_country, '??') AS country,
                       COUNT(DISTINCT l.browse_id) AS listings,
                       COUNT(DISTINCT li.browse_id) AS priced
                FROM listing l
                LEFT JOIN listing_instrument li ON li.browse_id = l.browse_id
                GROUP BY 1
                ORDER BY listings DESC
            `).all()
        },

        learnedRules () {
            return db.prepare(`
                SELECT id, phrase, kind, value, created_at AS createdAt,
                       from_label AS fromLabel, support, agreement, enabled
                FROM learned_rule ORDER BY created_at DESC
            `).all()
        },

        saveLearnedRule (rule) {
            return bindAll(db.prepare(`
                INSERT INTO learned_rule
                    (phrase, kind, value, created_at, from_label, support, agreement, enabled)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1)
                ON CONFLICT(phrase, kind) DO UPDATE SET
                    value = excluded.value, support = excluded.support,
                    agreement = excluded.agreement, enabled = 1
            `), [String(rule.phrase).trim().toLowerCase(), rule.kind, rule.value,
                rule.createdAt || new Date().toISOString(), rule.fromLabel,
                rule.support, rule.agreement])
        },

        deleteLearnedRule (id) {
            return db.prepare('DELETE FROM learned_rule WHERE id = ?').run(id)
        },

        /* Retention: raw eBay rows roll off, derived statistics stay.

           listing_label and learned_rule are absent from the table list
           below on purpose. Raw eBay item data is theirs and expires; a
           judgement someone made about it is ours and is kept, so a label
           remains a training example after the listing it came from has
           gone. */
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
