'use strict'

const CRYPTO = require('node:crypto')
const SERIES = require('../catalogue/series/index.js')
const STORE = require('./db.js')

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
    Auction or Buy-It-Now, for live and completed alike.

    A completed lot is judged on how it ACTUALLY SOLD, a live one on how it
    is OFFERED - not the same question, and they must not use the same
    column. Hence the sale_type / buying_options pair rather than either
    alone.

    Held here as two strings because the drill-down filters on them and the
    tab counts must agree with what that filter admits. Written out twice,
    those two would drift the first time either was touched, and the symptom
    would be a tab labelled "Buy-It-Now (304)" that opens on 297 rows -
    which reads as a bug in the page rather than in a predicate.

    Deliberately NOT expressed as `NOT (auction)`. The two are equivalent in
    two-valued logic, but a NULL buying_options makes both NULL, and keeping
    the positive form in each direction means a row with no buying options
    lands in neither tab rather than in whichever one negation happened to
    admit.
*/
const SALE_IS_AUCTION =
    "((o.sale_type IS NOT NULL AND o.sale_type = 'AUCTION') OR " +
    "(o.sale_type IS NULL AND l.buying_options LIKE '%AUCTION%'))"

const SALE_IS_BIN =
    "((o.sale_type IS NOT NULL AND o.sale_type <> 'AUCTION') OR " +
    "(o.sale_type IS NULL AND l.buying_options NOT LIKE '%AUCTION%'))"

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
                /*  Same treatment. Without it the 5,516 rows stored before
                    browse.js kept itemCreationDate would never acquire one,
                    because a listing we already know only ever takes the
                    conflict path - so the fix would have applied to new
                    listings alone and medianDaysToSale would have stayed
                    broken for months. */
                start_time = COALESCE(excluded.start_time, listing.start_time),
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
        /*
            A RE-SEEN LISTING WITH THE SAME ANSWER IS NOT A CHANGE.

            This was INSERT OR REPLACE, which rewrites the row whatever it
            held - so the collector, re-classifying every listing it re-sees
            on its poll, moved assigned_at on 15,295 rows that had not
            changed at all.

            That is not a wasted write, it is the invalidation signal for
            every memo in the application. marketWatermark reads
            MAX(assigned_at) over this table precisely so a re-filed coin
            invalidates the figures computed from it; measured on the live
            store, that value moved 16 times in 60 seconds while the row
            count sat at 15,295 exactly. Every market memo, every composition,
            the menu-bar counts and the tracked-type set were being thrown
            away every two seconds and rebuilt from cold - which is most of
            the reason the pages are slow.

            So the row is written only when one of its answers differs.
            `verified` is included for completeness; nothing reads it yet, and
            REPLACE was resetting it to 0 on every sweep, which would have
            been a real bug the moment something did.
        */
        assignInstrument: db.prepare(`
            INSERT INTO listing_instrument
                (browse_id, key, confidence, method, verified, assigned_at, quantity)
            VALUES (?,?,?,?,?,?,?)
            ON CONFLICT(browse_id, key) DO UPDATE SET
                confidence  = excluded.confidence,
                method      = excluded.method,
                verified    = excluded.verified,
                assigned_at = excluded.assigned_at,
                quantity    = excluded.quantity
            WHERE listing_instrument.confidence IS NOT excluded.confidence
               OR listing_instrument.method     IS NOT excluded.method
               OR listing_instrument.verified   IS NOT excluded.verified
               OR listing_instrument.quantity   IS NOT excluded.quantity
        `),
        upsertInstrument: db.prepare(`
            INSERT INTO instrument (key, level, display_name, metal, fine_oz, attributes)
            VALUES (?,?,?,?,?,?)
            /*  METAL IS REFRESHED, everything else is left as first written.

                DO NOTHING froze the metal at row creation, which is fine
                until a coin's series decides it - and then a row created
                before that decision keeps the old answer forever. Checked on
                the live store and it happens to be clean (1,842 sovereign
                rows XAU, 474 Morgan rows XAG), but only by luck of ordering:
                every page that prices a coin now reads this column, so a
                stale one would be a wrong premium that looks entirely
                plausible.

                display_name is deliberately NOT refreshed. scripts/golden.js
                compares stored names against freshly computed ones to detect
                exactly that drift, and updating it here would silently
                answer the question that check exists to ask. */
            ON CONFLICT(key) DO UPDATE SET metal = excluded.metal
        `),
        queueReview: db.prepare(`
            INSERT OR REPLACE INTO review_queue (browse_id, reason, best_guess, confidence, queued_at)
            VALUES (?,?,?,?,?)
        `),
        insertAspect: db.prepare('INSERT OR REPLACE INTO aspect (browse_id, name, value) VALUES (?,?,?)'),
        markAspectsFetched: db.prepare('UPDATE listing SET aspects_fetched = 1 WHERE browse_id = ?'),
        lastSweep: db.prepare('SELECT MAX(last_seen) AS at FROM listing WHERE end_time IS NULL')
    }

    /*
        Buy-It-Now lots that have gone quiet.

        A Good-'Til-Cancelled listing never announces that it is over. It has
        no end time, so pendingOutcomes' deadline query cannot see it, and
        the consequence was total: of 25,241 Buy-It-Now lots, not one had
        ever been resolved, and the fixed-price branch of trading.parseItem
        had never executed. Every clearing price the tool knows came from an
        auction, on roughly half the market.

        The only signal such a lot gives is that the sweep stops seeing it,
        so the trigger is an absence - and an absence has to be measured
        against the sweep clock, never the wall clock. On 2026-09-04 the
        collector spent eight hours unable to make a Browse call, having
        convinced itself its quota was gone; judged against the wall clock
        every lot in the corpus would have crossed this threshold at once and
        this query would have offered up thousands of listings that were
        alive and well. Anchored to the last sweep, an outage freezes the
        measurement and nothing goes quiet that had not already. That is the
        same reasoning lastSweepAt() records from the outage of 2026-08-30,
        which is twice now.

        QUIET_SWEEP_HOURS has been wrong twice, in opposite directions, and
        both times because of what was being optimised rather than how it was
        measured.

        First it came from snapshot history - every gap in a lot's timeline,
        and whether the lot was seen again - which said 99.4% at 72 hours. But
        a lot absent for days and never seen again counted as GONE, so lots
        that were absent, alive and never re-crawled scored as successes. That
        proxy was measuring the crawler, not the market.

        Then it came from asking eBay: 176 lots, 85% ended at 72 hours and 97%
        at 96. Honest numbers, but taken during and just after the collector
        outage of 2026-09-04, when the sweep made no Browse call for eight
        hours and hundreds of live lots therefore looked absent. Tuning to
        that put the threshold at 96 hours - four days before a sale could
        appear.

        What both attempts missed is that PRECISION PER CALL IS NOT THE
        CONSTRAINT. Measured on a healthy sweep:

            lots last seen 1h ago   1804
            lots last seen 2h ago      4
            lots last seen 3h ago      6
            lots last seen 4h ago     10

        A live lot is seen every hour. Absence is a clean signal within hours,
        and the standing population it selects is small - 461 priced lots
        absent 8h or more, only 285 of them never asked - against a Trading
        allowance of 5,000 a day of which about 600 is spent. There is no
        scarcity here to ration.

        So the threshold is now 8 hours: comfortably clear of the 2-hour
        99th-percentile gap between sightings, tolerant of a degraded or
        truncated sweep, and still same-day rather than same-week. A lot that
        sells tonight is asked about tonight.

        Asking early helps a second time, which the four-day version quietly
        cost us. eBay drops a listing's Best Offer records after roughly five
        days - 20 of 25 lots in the first backfill came back "counted N
        offers, returned none" - and those records are the only thing that
        separates a Buy-It-Now sold at its asking price from one sold via an
        accepted offer. Ask within hours and that price is exact; ask on the
        fourth day and it is a ceiling forever.

        The threshold still only governs SPEND and LATENCY, never honesty.
        What keeps the data right is the resolver's refusal to record an
        outcome for a listing eBay still calls Active, which is why being
        wrong here costs one Trading call and a note not to ask again, rather
        than a fabricated sale.

        Priced lots only. An unattributed listing's outcome feeds no clearing
        statistic, and there are 2,914 priced against 25,241 in total, so the
        restriction is most of the difference between a bounded backlog and
        a pointless one.
    */
    const QUIET_SWEEP_HOURS = 8

    /*
        And how long a lot found ALIVE is left alone.

        Not the same number, and it was: the back-off reused the absence
        threshold, so a lot eBay had just called Active waited a full four
        days to be asked again. A Buy-It-Now alive this morning can be sold
        by tonight, and waiting four days to notice is the same latency
        problem one step further along.

        Twelve hours instead. Long enough that a lot flickering in and out of
        search is not asked about on every cycle, short enough that a genuine
        sale is caught the same day.
    */
    const ALIVE_RECHECK_HOURS = 12

    function quietBuyItNow (wanted, retentionFloor) {
        if (wanted <= 0) { return [] }

        /*  The sweep clock: discover.js stamps one seenAt across everything a
            sweep saw, so the newest last_seen among Good-'Til-Cancelled lots
            is when the last sweep completed. Falling back to the wall clock
            would reintroduce exactly the outage behaviour described above,
            so an empty store yields no candidates instead. */
        const sweep = statements.lastSweep.get()
        if (sweep === undefined || !sweep.at) { return [] }

        const quietBefore =
            new Date(Date.parse(sweep.at) - QUIET_SWEEP_HOURS * 60 * 60 * 1000).toISOString()
        const recheckBefore =
            new Date(Date.parse(sweep.at) - ALIVE_RECHECK_HOURS * 60 * 60 * 1000).toISOString()

        return db.prepare(`
            SELECT l.browse_id AS browseId, l.legacy_id AS legacyId, MIN(l.last_seen) AS endTime,
                   1 AS quiet
            FROM listing l
            WHERE l.end_time IS NULL
              AND l.buying_options NOT LIKE '%AUCTION%'
              AND l.legacy_id IS NOT NULL
              AND l.last_seen < ?
              AND l.last_seen > ?
              /*  And not one eBay has recently told us is still on sale.
                  Without this a lot found Active is offered again every
                  cycle, forever, because being alive leaves no trace: the
                  first live run spent 28 of 38 calls re-asking lots it had
                  already been told about. Its own interval, not the absence
                  threshold - see ALIVE_RECHECK_HOURS. */
              AND (l.alive_checked_at IS NULL OR l.alive_checked_at < ?)
              AND EXISTS (SELECT 1 FROM listing_instrument li WHERE li.browse_id = l.browse_id)
              AND NOT EXISTS (
                  SELECT 1
                  FROM listing_outcome o
                  JOIN listing sibling ON sibling.browse_id = o.browse_id
                  WHERE sibling.legacy_id = l.legacy_id
              )
            GROUP BY l.legacy_id
            ORDER BY endTime ASC
            LIMIT ?
        `).all(quietBefore, retentionFloor, recheckBefore, wanted)
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
                changed the spot value for every single coin filed under the same
                key. */
            const quantity = Number.isFinite(attributes && attributes.quantity) && attributes.quantity > 1
                ? Math.floor(attributes.quantity)
                : 1
            for (const entry of keys) {
                bindAll(statements.upsertInstrument, [
                    entry.key, entry.level, INSTRUMENTS.displayName(entry.key),
                    /*  From the series, never a literal. This column existed,
                        was written 'XAU' and was never read; a silver coin
                        filed as gold prices about a hundred times too cheap
                        and arrives disguised as the find of the year. */
                    SERIES.metalForKey(entry.key), fineOz, JSON.stringify(attributes || {})
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
            const cap = limit || 100
            const now = new Date().toISOString()
            /* inside the 90-day window, with margin */
            const retentionFloor = new Date(Date.now() - 88 * DAY_MS).toISOString()

            const ended = db.prepare(`
                SELECT l.browse_id AS browseId, l.legacy_id AS legacyId, MIN(l.end_time) AS endTime,
                       0 AS quiet
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
            `).all(now, retentionFloor, cap)

            /*  Auctions first, always. They carry a hard deadline and the
                lots below do not, so quiet Buy-It-Now work may only ever use
                capacity an auction did not want. */
            if (ended.length >= cap) { return ended }

            return ended.concat(quietBuyItNow(cap - ended.length, retentionFloor))
        },

        /* Sold auctions with their premium inputs, for fair value. */
        clearingObservations (key, sinceIso) {
            return db.prepare(`
                SELECT o.browse_id AS browseId, o.ended_at AS endedAt, o.final_price AS finalPrice,
                       o.shipping, o.bid_count AS bidCount, o.sale_type AS saleType,
                       o.sold, o.censored, l.title, l.seller_hash AS sellerHash,
                       l.seller_id_hash AS sellerIdHash, l.cert_number AS certNumber,
                       l.start_time AS listedAt, i.fine_oz * li.quantity AS fineOz,
                       i.metal
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
                    /*  NARROWED BY THE FILTER THE TAIL APPLIES, so the latest
                        snapshot is not found for listings that cannot survive
                        it - the same change that took liveAuctions from
                        1,249ms to 255ms. It is worth far less here, because
                        the scope is already one coin type: measured over the
                        busiest 80 keys, 1,485ms to 1,174ms, identical rows.
                        Taken anyway, being the same shape for the same reason.

                        BATCHING THESE 80 CALLS INTO ONE WAS TRIED AND IS NOT
                        HERE. It measured 1,448ms against 1,485ms - no gain -
                        because widening the scope to 80 keys costs about what
                        the 79 saved statements save. Eighty tight seeks beat
                        one broad scan, which is the lesson liveAuctions taught
                        from the other direction. */
                    SELECT li2.browse_id FROM listing_instrument li2
                    JOIN listing lf ON lf.browse_id = li2.browse_id
                    WHERE li2.key = ?1
                      AND (lf.end_time IS NULL OR lf.end_time > ?2)
                      AND lf.last_seen > ?3
                      AND NOT EXISTS (SELECT 1 FROM listing_outcome o2
                                      WHERE o2.browse_id = li2.browse_id)
                ),
                /*  Latest snapshot per listing, grouped ONCE.

                    This was a correlated subquery matching observed_at
                    against a MAX taken per s.browse_id: a seek per listing, as
                    the note it replaced said, but a seek PER CANDIDATE ROW
                    rather than per listing. The scope
                    here averages 121 snapshots a lot, so it ran that seek
                    around a hundred times per listing to answer a question
                    with one answer per listing.

                    Grouping first asks it once. Measured on the live store
                    (447MB, 3.59M snapshots): the scoped form 168ms -> 56ms,
                    the unscoped one in liveAuctions 6.09s -> 1.57s, and both
                    return byte-identical rows - 679/679 and 29,668/29,668
                    compared field by field.

                    No index was added and none is needed: listing_snapshot is
                    WITHOUT ROWID on PRIMARY KEY (browse_id, observed_at), so
                    that key already IS the index this wants. Adding an
                    explicit one was measured at 168ms -> 182ms, i.e. nothing,
                    because it duplicated the primary key.

                    That same key is what makes the join safe. Two snapshots of
                    one listing cannot share an observed_at, so the equality
                    cannot match twice and duplicate a row - excluded by the
                    schema rather than by luck. */
                latest AS (
                    SELECT s.browse_id, s.price, s.shipping, s.bid_count
                    FROM listing_snapshot s
                    JOIN (
                        SELECT s2.browse_id, MAX(s2.observed_at) AS observed_at
                        FROM listing_snapshot s2
                        JOIN scope ON scope.browse_id = s2.browse_id
                        GROUP BY s2.browse_id
                    ) m ON m.browse_id = s.browse_id AND m.observed_at = s.observed_at
                )
                SELECT l.browse_id AS browseId, l.title, l.buying_options AS buyingOptions,
                       l.end_time AS endTime, l.item_web_url AS itemWebUrl,
                       l.image_url AS imageUrl, l.legacy_id AS legacyId,
                       /*  When a sweep last saw this lot. The window below
                           decides what counts as active AT ALL; callers that
                           tell you to go and spend money need a tighter test
                           than callers computing a median, so they need the
                           figure itself rather than just its verdict. */
                       l.last_seen AS lastSeen,
                       i.fine_oz * li.quantity AS fineOz, i.metal,
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
                /*  browse_id is not decoration: the curve has to know which
                    auction a snapshot came from, or 110 observations of one
                    long-running lot outvote 22 other auctions put together. */
                SELECT s.browse_id AS browseId,
                       s.seconds_to_end AS secondsToEnd, s.price, o.final_price AS finalPrice
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

        /*  How many are waiting, per coin. Shown on the tabs so choosing
            one series to work through never hides the size of another. */
        /*
            How much is waiting under each coin - and how much of it the
            current sale filter will actually show.

            `n` is the number the tab must display, because it is the number
            of rows clicking that tab produces. The unfiltered total came
            apart the moment the queue defaulted to auctions: on the live
            store the unattributed tab read 20,562 and opened on 1,691, and
            sovereigns read 675 and opened on 76. A tab that overstates its
            own contents ninefold reads as a broken page.

            `total` is kept beside it so the tab can still say what it is a
            slice OF. Losing that would break the older promise this function
            exists for: every series' count is on screen at once, so choosing
            one can never hide how much is waiting under another.

            Offer-based, deliberately, and NOT the SALE_IS_AUCTION predicate
            used by the drill-down. reviewQueue selects no listing_outcome
            columns at all, so the page's own matchesSale() has no sale_type
            to read and judges every row on buying_options. Counting by a
            different rule than the page filters by is how the two would
            disagree again, one layer down.
        */
        reviewCountsBySeries (saleFilter) {
            const filter = saleFilter === 'auction' || saleFilter === 'bin' ? saleFilter : 'all'
            return db.prepare(`
                SELECT COALESCE(l.series, '?') AS series,
                       COUNT(*) AS total,
                       SUM(CASE WHEN ?1 = 'all' THEN 1
                                WHEN ?1 = 'auction' AND l.buying_options LIKE '%AUCTION%' THEN 1
                                WHEN ?1 = 'bin' AND l.buying_options NOT LIKE '%AUCTION%' THEN 1
                                ELSE 0 END) AS n
                FROM review_queue r
                JOIN listing l ON l.browse_id = r.browse_id
                WHERE r.resolved_at IS NULL
                GROUP BY COALESCE(l.series, '?')
                ORDER BY n DESC, total DESC
            `).all(filter).map(row => ({
                series: row.series,
                n: row.n || 0,
                total: row.total || 0
            }))
        },

        /*  seriesId narrows the queue to one coin. '?' means the listings no
            series recognised, which are their own kind of work: not a coin
            filed wrongly, but a coin the tool cannot place at all. */
        reviewQueue (limit, seriesId) {
            return db.prepare(`
                SELECT r.browse_id AS browseId, r.reason, r.best_guess AS bestGuess,
                       r.confidence, l.title, l.item_web_url AS itemWebUrl, l.series,
                       /*  The stable identity of the coin, which is what a
                           human decision is recorded against - browse_id
                           changes when a seller relists and a verdict
                           should not have to be given twice. */
                       l.legacy_id AS legacyId,
                       lb.verdict AS verdict, lb.denomination AS labelledDenomination, lb.pool AS labelledPool,
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
                       /*
                           WHICH group it is counted in, not merely that it is.

                           The flag above has always answered "is this
                           distorting a number on the front page"; it never
                           answered "which number". So a row could say
                           "counted in the statistics" while the group doing
                           the counting - bullion, proof, graded - stayed
                           invisible, and the reviewer confirmed the coin was
                           genuine without ever being shown the classification
                           that decides what it is worth.

                           The best_guess column is not a substitute: it is what the
                           classifier PROPOSED for a lot it could not place,
                           and is null for exactly the rows that were placed.
                           The two are complements, and the row wants
                           whichever exists.

                           Level 0 to match every other read path - a listing
                           carries a row per level of the taxonomy, and the
                           leaf is the one the statistics are keyed on.
                       */
                       (SELECT li.key FROM listing_instrument li
                        JOIN instrument i2 ON i2.key = li.key AND i2.level = 0
                        WHERE li.browse_id = r.browse_id LIMIT 1) AS instrumentKey,
                       (SELECT li.confidence FROM listing_instrument li
                        JOIN instrument i2 ON i2.key = li.key AND i2.level = 0
                        WHERE li.browse_id = r.browse_id LIMIT 1) AS filedConfidence,
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
                /*
                    The latest snapshot, as a seek rather than a ranking.

                    This used to be ROW_NUMBER() OVER (PARTITION BY browse_id
                    ORDER BY observed_at DESC), which windowed and sorted the
                    snapshots of every unresolved queue row - 330,266 of them
                    on the live store - to answer a question about the 682
                    rows one coin tab shows. Measured at 2,584ms; this form
                    is 107ms, and returns identical values in every field of
                    every row (checked against the old query for both a
                    scoped and an unscoped call).

                    It is fast for a reason worth writing down: listing_snapshot
                    is WITHOUT ROWID with PRIMARY KEY (browse_id, observed_at),
                    so that key IS the table's index and MAX(observed_at) for
                    one browse_id is a seek to the end of a contiguous run.
                    An extra index on (browse_id, observed_at DESC) was tried
                    and measured: 22MB for 6ms, so it was not added.

                    The same primary key is what makes the join safe. Two
                    snapshots of one listing cannot share an observed_at, so
                    the equality can never match twice and duplicate a row -
                    which is the usual objection to this shape, and here it is
                    excluded by the schema rather than by luck.
                */
                LEFT JOIN listing_snapshot s ON s.browse_id = r.browse_id
                    AND s.observed_at = (SELECT MAX(s2.observed_at)
                                         FROM listing_snapshot s2
                                         WHERE s2.browse_id = r.browse_id)
                WHERE r.resolved_at IS NULL
                  AND (?2 IS NULL
                       OR (?2 = '?' AND l.series IS NULL)
                       OR l.series = ?2)
                /*  Impact before recency. A listing still counted in the
                    market statistics is the only kind that can be making a
                    number wrong, and newest-first buried those among 1,536
                    already-dropped rows shown for auditability. */
                ORDER BY priced DESC, r.queued_at DESC LIMIT ?1
            `).all(limit || 50, seriesId === undefined ? null : seriesId)
        },

        /* ------------------------------------------------- human labels */

        /*
            One decision per coin, keyed on legacy_id so it survives a
            relist. Re-labelling overwrites: a person changing their mind is
            a correction, not a second opinion to be averaged with the first.
        */
        /*
            Which coin a listing is, according to the listings themselves.

            `listing.series` is set from SERIES.recognise BEFORE classification
            runs (discover.js, reclassify.js) and is never written by the label
            path, so it is an independent witness to what a decision was about.
            NULL means no pack claimed the title.

            MIN over the group for the same reason titleCorpus uses it: one
            legacy_id can hold rows that disagree, and a deterministic answer
            beats an arbitrary one.
        */
        seriesFor (legacyId) {
            const row = db.prepare(
                'SELECT MIN(series) AS series FROM listing WHERE legacy_id = ? AND series IS NOT NULL'
            ).get(legacyId)
            return row === undefined || !row.series ? null : row.series
        },

        label (entry) {
            const now = entry.labelledAt || new Date().toISOString()
            const quantity = Number.isFinite(entry.quantity) && entry.quantity >= 1
                ? Math.floor(entry.quantity)
                : 1
            return bindAll(db.prepare(`
                INSERT INTO listing_label
                    (legacy_id, title, verdict, denomination, note, labelled_at, source, quantity, series, pool)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(legacy_id) DO UPDATE SET
                    title = excluded.title, verdict = excluded.verdict,
                    denomination = excluded.denomination, note = excluded.note,
                    labelled_at = excluded.labelled_at, source = excluded.source,
                    quantity = excluded.quantity, series = excluded.series,
                    pool = excluded.pool
            `), [entry.legacyId, entry.title, entry.verdict, entry.denomination,
                entry.note, now, entry.source || 'human', quantity,
                /*
                    Which coin the decision was about - DERIVED, not defaulted.

                    This used to fall back to SERIES.DEFAULT_ID, and neither
                    caller passed a series, so every human decision was
                    recorded as a sovereign one whatever coin it was actually
                    about. Nothing had been mis-stamped yet when this was
                    found (247 labels, all genuinely sovereigns, checked
                    against listing.series) - the queue defaults to sovereigns
                    and no Morgan had been judged. It would have landed on the
                    first one, and the damage is not the label itself but what
                    grows from it: a rule induced from a Morgan would be
                    scoped GB.SOV and could then never fire on a Morgan.

                    Derived HERE rather than passed in, because a caller that
                    has to remember is a caller that will forget - and the two
                    that existed both had the series to hand and neither used
                    it. A third added next year cannot get it wrong.

                    NULL when no pack claimed the listing, which is the honest
                    answer and the one listing.series already gives. A caller
                    may still override explicitly; nothing does today.
                */
                entry.series !== undefined ? entry.series : this.seriesFor(entry.legacyId),
                /*
                    Which POOL you say it is: bullion, proof, graded, and so
                    on. The verdict answers whether the coin is real; this
                    answers which kind, and that is the answer deciding which
                    clearing prices it is measured against.

                    NULL means you have not said, and the classifier keeps
                    its own answer. An empty string from an untouched
                    dropdown is the same thing and must land as NULL too -
                    storing it would read as a human having chosen "none".
                */
                entry.pool ? entry.pool : null])
        },

        /*  The title a decision should be recorded against. Looked up rather
            than posted back, because a batch of thirty would otherwise carry
            thirty hidden title fields for no reason. */
        /*
            The fine ounces in ONE coin of this type.

            Read from the instrument row rather than from a listing, because
            a listing's fineOz is deliberately multiplied by its lot size
            (CLS-07). Taking it from whichever lot happened to sort first
            made a nine-coin set redefine the gold content of every coin
            filed under the same key.
        */
        /*
            When the last full sweep ran.

            discover.js stamps ONE seenAt at the start of a sweep onto every
            listing it saw, so the newest last_seen among Good-'Til-Cancelled
            lots is exactly the clock of the last completed sweep. Restricted
            to end_time IS NULL because the five-minute ending-soon poller
            only ever refreshes auctions - including them would make this the
            poller's clock instead, which is not the same thing.

            Freshness is judged against this rather than against the wall
            clock. Of 5,431 gaps over two hours between sightings of a lot,
            4,813 - 88.6% - start at one single moment: the collector outage
            of 2026-08-30 13:56 to 15:58. Judged against the clock, that
            outage would have emptied the actionable panels for two hours
            over an event in the collector rather than in the market. Judged
            against the last sweep, an outage freezes the anchor and nothing
            becomes stale that was not already.
        */
        /*  Which series claimed this listing. NULL means nothing did, which
            is a fact worth storing rather than a gap to fill in - it is how
            the review queue finds the coins the tool cannot place. */
        setListingSeries (browseId, seriesId) {
            return db.prepare('UPDATE listing SET series = ? WHERE browse_id = ?')
                .run(seriesId === undefined ? null : seriesId, browseId)
        },

        /*
            Sold lots whose price we wrote off as unknowable because the
            seller had left the offer button on.

            Every one of these was resolved before there was any way to ask
            which offers a listing received, and a lot that already has an
            outcome is never offered to the resolver again - so they cannot
            benefit from the question being asked at resolve time. This is
            how they get asked once, after the fact.
        */
        censoredOffersToRecheck (limit) {
            return db.prepare(`
                SELECT o.browse_id AS browseId, l.legacy_id AS legacyId, l.title,
                       o.final_price AS finalPrice, o.ended_at AS endedAt
                FROM listing_outcome o
                JOIN listing l ON l.browse_id = o.browse_id
                WHERE o.sold = 1
                  AND o.censored = 1
                  AND o.sale_type = 'BEST_OFFER'
                  AND l.legacy_id IS NOT NULL
                ORDER BY o.ended_at DESC
                LIMIT ?
            `).all(limit || 200)
        },

        /*  A price we can now stand behind. Narrow on purpose: this only
            ever clears the mark, never sets it, so a backfill cannot make
            the store less honest than it found it. */
        uncensorOutcome (browseId) {
            return db.prepare(
                'UPDATE listing_outcome SET censored = 0 WHERE browse_id = ? AND censored = 1'
            ).run(browseId)
        },

        /*  eBay said this lot is still on sale. Recorded so the resolver
            does not ask again tomorrow, and the day after. */
        markAliveNow (browseId, whenIso) {
            return db.prepare('UPDATE listing SET alive_checked_at = ? WHERE browse_id = ?')
                .run(whenIso || new Date().toISOString(), browseId)
        },

        /*
            How many queued coins are actually making a number wrong.

            NOT the size of the review queue, which on the live store is
            25,560 rows and almost all of it deliberate exclusions - 20,872
            listings outside the chosen countries alone. A figure that large
            beside the word "review" reads as a backlog nobody could ever
            clear, when the work is three orders of magnitude smaller.

            The ones that matter are the coins the tool is still pricing while
            unsure about them: queued, not excluded, and counted in a
            statistic. Those are the only rows whose being wrong changes a
            number on the front page.
        */
        reviewAffectingCount () {
            const row = db.prepare(`
                SELECT COUNT(*) AS n
                FROM review_queue r
                WHERE COALESCE(r.reason, '') NOT LIKE 'EXCLUDED%'
                  AND EXISTS (SELECT 1 FROM listing_instrument li WHERE li.browse_id = r.browse_id)
            `).get()
            return row === undefined ? 0 : row.n
        },

        lastSweepAt () {
            const row = db.prepare(
                'SELECT MAX(last_seen) AS at FROM listing WHERE end_time IS NULL'
            ).get()
            return row === undefined || !row.at ? null : row.at
        },

        instrumentFineOz (key) {
            const row = db.prepare('SELECT fine_oz FROM instrument WHERE key = ?').get(key)
            return row === undefined || row.fine_oz === null ? null : row.fine_oz
        },

        titleFor (legacyId) {
            const row = db.prepare(
                'SELECT title FROM listing WHERE legacy_id = ? ORDER BY last_seen DESC LIMIT 1'
            ).get(legacyId)
            return row === undefined ? null : row.title
        },

        unlabel (legacyId) {
            return db.prepare('DELETE FROM listing_label WHERE legacy_id = ?').run(legacyId)
        },

        labels () {
            return db.prepare(`
                SELECT legacy_id AS legacyId, title, verdict, denomination, note,
                       labelled_at AS labelledAt, source, quantity,
                       /*  Which coin the decision was about. Without it the
                           rule induced from a label cannot be scoped, and the
                           rejection cannot be read back in that coin's own
                           words. */
                       series,
                       /*  And which pool you put it in. This query feeds the
                           classifier's hot path, so a column missing here is
                           a correction that stores and then does nothing -
                           which is exactly how the pool override first
                           failed its own test. */
                       pool
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
                       /*  Which pack claimed the title, so a rule preview can
                           be scoped the way the rule itself will be. NULL is
                           not "unknown": it means no pack recognised it, and
                           such a listing is queued before classification runs
                           - so no learned rule can ever reach it.

                           MIN over the group because a legacy_id can hold
                           rows that disagree (16 of 23,740 do, from a relist
                           re-recognised after a rule changed). Deterministic
                           beats arbitrary; the alternative is a preview whose
                           count moves between two page loads. */
                       MIN(l.series) AS series,
                       /*  Priced means IN AN INSTRUMENT, and nothing more.
                           It used to also require the listing be absent from
                           the open review queue, which made this the only
                           place in the tool where a queued listing counted
                           as unpriced - reviewQueue's own priced column is
                           a bare EXISTS against listing_instrument, and so
                           is the count behind "N listings stopped counting"
                           on the rules page. Being queued does not remove a
                           listing from the market statistics; it only means
                           somebody should look at it.

                           The disagreement was 253 coins, 8.5% of the priced
                           population, and it ran the dangerous way: breaks
                           is computed from this flag, so a phrase whose only
                           priced matches were queued reported breaks=0 and
                           was offered with a one-click Accept - while
                           actually dropping coins from the statistics. That
                           is the exact outcome the confirmation page exists
                           to prevent. Found by accepting a Hattons rule and
                           watching the preview say 11 and the result say 12. */
                       MAX(CASE WHEN li.browse_id IS NOT NULL THEN 1 ELSE 0 END) AS priced
                FROM listing l
                LEFT JOIN listing_instrument li ON li.browse_id = l.browse_id
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
        listingsForInstrument (key, limit, saleFilter) {
            return db.prepare(`
                /*  The scope CTE is what makes this affordable on a Pi:
                    windowing all 90,000 snapshot rows instead of just this
                    instrument's cost 459ms against 192ms. */
                WITH scope AS (
                    SELECT browse_id FROM listing_instrument WHERE key = ?1
                ),
                /*  Latest snapshot per listing, grouped ONCE.

                    This was a correlated subquery matching observed_at
                    against a MAX taken per s.browse_id: a seek per listing, as
                    the note it replaced said, but a seek PER CANDIDATE ROW
                    rather than per listing. The scope
                    here averages 121 snapshots a lot, so it ran that seek
                    around a hundred times per listing to answer a question
                    with one answer per listing.

                    Grouping first asks it once. Measured on the live store
                    (447MB, 3.59M snapshots): the scoped form 168ms -> 56ms,
                    the unscoped one in liveAuctions 6.09s -> 1.57s, and both
                    return byte-identical rows - 679/679 and 29,668/29,668
                    compared field by field.

                    No index was added and none is needed: listing_snapshot is
                    WITHOUT ROWID on PRIMARY KEY (browse_id, observed_at), so
                    that key already IS the index this wants. Adding an
                    explicit one was measured at 168ms -> 182ms, i.e. nothing,
                    because it duplicated the primary key.

                    That same key is what makes the join safe. Two snapshots of
                    one listing cannot share an observed_at, so the equality
                    cannot match twice and duplicate a row - excluded by the
                    schema rather than by luck. */
                latest AS (
                    SELECT s.browse_id, s.price, s.shipping, s.bid_count, s.observed_at
                    FROM listing_snapshot s
                    JOIN (
                        SELECT s2.browse_id, MAX(s2.observed_at) AS observed_at
                        FROM listing_snapshot s2
                        JOIN scope ON scope.browse_id = s2.browse_id
                        GROUP BY s2.browse_id
                    ) m ON m.browse_id = s.browse_id AND m.observed_at = s.observed_at
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
                       /*  What it actually fetched. This is the only honest
                           number in the table - everything else is somebody's
                           opinion of what a coin is worth, and this is what
                           one was worth to a buyer. */
                       o.sold, o.final_price AS finalPrice, o.shipping AS finalShipping,
                       o.ended_at AS endedAt, o.bid_count AS finalBidCount,
                       o.censored, o.sale_type AS saleType,
                       q.reason,
                       lb.verdict, lb.denomination AS labelledDenomination, lb.pool AS labelledPool,
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
                  AND (?5 = 'all'
                       OR (?5 = 'auction' AND ${SALE_IS_AUCTION})
                       OR (?5 = 'bin' AND ${SALE_IS_BIN}))
                /*  Completed sales first, always.

                    They are few - tens against thousands - and they are the
                    only prices here that somebody actually paid. Sorting them
                    behind the live listings meant the row limit cut them off
                    entirely: an instrument with 500 live lots reported "0
                    sold" while holding more completed sales than any other.

                    Then live before ended, then dearest. Within one key
                    fine_oz is constant, so the dearest lot is also the
                    highest premium - which keeps the order meaningful on a
                    day the gold feed has a gap. */
                ORDER BY COALESCE(o.sold, 0) DESC, live DESC, totalCost DESC
                LIMIT ?4
            `).all(
                key,
                new Date().toISOString(),
                new Date(Date.now() - (config.activeWithinHours || 24) * 60 * 60 * 1000).toISOString(),
                limit || 200,
                saleFilter === 'auction' || saleFilter === 'bin' ? saleFilter : 'all'
            )
        },

        /*
            How many lots each sale tab would show, for the tab labels.

            The drill-down now opens on auctions, so the Buy-It-Now pile is
            skipped by default - on the busiest coin type that is 372 lots of
            the 474 live. A default that quietly hides four fifths of the
            market is only honest if the tab says how much it is hiding, so
            the count goes on the label.

            Its own query rather than counting the fetched rows, because
            those come back already filtered AND capped at 500: counting them
            would report the size of the fetch, not the size of the pile. One
            indexed pass over listing_instrument with no snapshot window -
            2ms against the 190ms the page already spends.
        */
        saleCountsForInstrument (key) {
            const row = db.prepare(`
                SELECT COUNT(*) AS total,
                       SUM(CASE WHEN ${SALE_IS_AUCTION} THEN 1 ELSE 0 END) AS auction,
                       SUM(CASE WHEN ${SALE_IS_BIN} THEN 1 ELSE 0 END) AS bin
                FROM listing_instrument li
                JOIN listing l ON l.browse_id = li.browse_id
                LEFT JOIN listing_outcome o ON o.browse_id = li.browse_id
                WHERE li.key = ?1
            `).get(key)
            /*  SUM over no rows is NULL, and a tab reading "(null)" is worse
                than one reading "(0)". */
            return {
                all: row.total || 0,
                auction: row.auction || 0,
                bin: row.bin || 0
            }
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
                       from_label AS fromLabel, support, agreement, enabled,
                       /*  Which coin the rule is about. NULL means every one,
                           which is the value worth being able to see. */
                       series
                FROM learned_rule ORDER BY created_at DESC
            `).all()
        },

        saveLearnedRule (rule) {
            return bindAll(db.prepare(`
                INSERT INTO learned_rule
                    (phrase, kind, value, created_at, from_label, support, agreement, enabled, series)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)
                /*  Matches the expression index: a phrase is unique WITHIN a
                    scope, so two series can rule on the same words without
                    one silently re-scoping the other's decision. */
                ON CONFLICT(phrase, kind, COALESCE(series, '*')) DO UPDATE SET
                    value = excluded.value, support = excluded.support,
                    agreement = excluded.agreement, enabled = 1
            `), [String(rule.phrase).trim().toLowerCase(), rule.kind, rule.value,
                rule.createdAt || new Date().toISOString(), rule.fromLabel,
                rule.support, rule.agreement,
                /*  null means "every series", which the confirmation page
                    makes an explicit choice rather than a default. */
                rule.series === null ? null : (rule.series || SERIES.DEFAULT_ID)])
        },

        deleteLearnedRule (id) {
            return db.prepare('DELETE FROM learned_rule WHERE id = ?').run(id)
        },

        /*
            Completed sales, newest first, across every coin type.

            The scarcest and most valuable thing in the store: an asking price
            is an opinion, and this is what somebody paid. It sat two clicks
            down and mixed in with lots that ended unsold, which is the wrong
            way round for the only measurement here that is not a guess.
        */
        /*  How many completed sales exist, as opposed to how many the page
            asked for. The heading prints this: a count that is really a
            fetch limit is a number that quietly stops being true, and this is
            the one table where the total is the whole point - it is the size
            of the evidence every clearing figure rests on. */
        /*  When the newest resolved sale landed, and how many there are.

            The uplift curve is built from every sold auction of the last year
            and costs two seconds; it is also identical between two page loads
            a second apart, because it can only move when the collector
            resolves an outcome. This is the cheapest honest statement of
            whether that has happened - MAX over an indexed column plus a
            count, so a deletion cannot look like no change.

            A count alone would miss a correction that replaced one outcome
            with another; a MAX alone would miss a deletion. Together they
            change whenever the population does, which is the whole job.
        */
        /*  Everything a coin type's market is computed from, in one row.

            The market for one coin type costs about 28ms and the front page
            needs eighty of them, which was 2.2s of a 3.3s render - and the
            answer is identical between two page loads unless something it
            reads has changed underneath. This says whether anything has.

            A COUNT AND A MAX PER TABLE, and the tables are chosen to cover
            every input rather than every trigger. listing_instrument.assigned_at
            is the important one: reclassification stamps it, so a coin moving
            from one type to another is visible here directly, without anyone
            having to reason about which of verdicts, learned rules or a
            changed country filter caused it. The count catches a deletion the
            MAX would miss, and the MAX catches a correction the count would.

            37ms on the live store, against the 2.2s it decides whether to
            spend.

            THE LISTING TABLE IS DELIBERATELY NOT HERE. MAX(last_seen) moves
            every time the collector touches a lot, so including it made the
            memo miss on every request for the whole length of a sweep - which
            is how it was first written, and it profiled as though the cache
            did not exist. A new or re-seen listing is instead picked up by the
            minute in the memo's own key, so the page can be at most sixty
            seconds behind the collector on which lots are live. That is the
            same bound already accepted for an auction reaching its end time,
            and it sits against a sweep that runs hourly.

            Everything that is still here invalidates INSTANTLY, which is what
            the verdict loop needs and what the minute must not be trusted
            with.

            NOT A TTL, and not memoised on one either. A verdict POSTs and
            redirects to a GET within about fifty milliseconds, and the whole
            point of that loop is that the front page changes when you make a
            call. Any cache with a clock in it would show the reader their own
            decision not having happened.
        */
        marketWatermark () {
            const r = db.prepare(`
                SELECT
                  (SELECT COUNT(*) || ':' || COALESCE(MAX(resolved_at), '-')
                     FROM listing_outcome) AS outcomes,
                  (SELECT COUNT(*) || ':' || COALESCE(MAX(labelled_at), '-')
                     FROM listing_label) AS labels,
                  (SELECT COUNT(*) || ':' || COALESCE(MAX(created_at), '-')
                     FROM learned_rule) AS rules,
                  (SELECT COUNT(*) || ':' || COALESCE(MAX(assigned_at), '-')
                     FROM listing_instrument) AS classified,
                  (SELECT COUNT(*) || ':' || COALESCE(MAX(observed_at), '-')
                     FROM spot) AS spot,
                  (SELECT COUNT(*) || ':' || COALESCE(MAX(updated_at), '-')
                     FROM setting) AS settings
            `).get()
            return [r.outcomes, r.labels, r.rules, r.classified,
                r.spot, r.settings].join('|')
        },

        outcomeWatermark () {
            return db.prepare(`
                SELECT COUNT(*) AS n, MAX(ended_at) AS newest
                FROM listing_outcome
                WHERE sold = 1 AND sale_type = 'AUCTION' AND censored = 0
            `).get()
        },

        soldCount () {
            /*  THE SAME POPULATION recentSales draws from, joins and all.

                Counting `listing_outcome WHERE sold = 1` on its own looked
                obviously right and was not: recentSales INNER JOINs
                listing_instrument, so a sale whose listing is not filed under
                a coin type - excluded, or never classified - can never appear
                in the table however high the limit goes. On the live store
                that is 295 against 69, so the heading would have promised
                four times what the page could show. A count that names a
                bigger number than the thing it counts is worse than the fetch
                limit it replaced. */
            return db.prepare(`
                SELECT COUNT(DISTINCT o.browse_id) AS n
                FROM listing_outcome o
                JOIN listing l ON l.browse_id = o.browse_id
                JOIN listing_instrument li ON li.browse_id = o.browse_id
                JOIN instrument i ON i.key = li.key AND i.level = 0
                WHERE o.sold = 1
            `).get().n
        },

        recentSales (limit) {
            return db.prepare(`
                SELECT l.browse_id AS browseId, l.legacy_id AS legacyId, l.title,
                       l.item_web_url AS itemWebUrl, l.image_url AS imageUrl,
                       l.item_country AS itemCountry,
                       o.final_price AS finalPrice, o.shipping AS finalShipping,
                       o.bid_count AS finalBidCount, o.ended_at AS endedAt,
                       o.sale_type AS saleType, o.censored, o.sold,
                       li.key AS instrumentKey, li.quantity AS lotQuantity,
                       i.fine_oz * li.quantity AS fineOz,
                       /*  Same omission as liveAuctions, and the same cause.
                        Every sold Morgan was priced against gold and reported
                        about -97%: a number so wrong it read as a data fault
                        rather than a unit one. */
                       i.metal, l.series,
                       /*  What you have already said about this coin, so the
                           table can show a settled row as settled rather than
                           offering to judge it again. Every other queue on
                           the site joins this; the sold table did not,
                           because until now it had no controls to grey out. */
                       lb.verdict, lb.denomination AS labelledDenomination, lb.pool AS labelledPool,
                       lb.quantity AS labelledQuantity
                FROM listing_outcome o
                JOIN listing l ON l.browse_id = o.browse_id
                LEFT JOIN listing_label lb ON lb.legacy_id = l.legacy_id
                /*  Level 0 only: one row per sale, at the coarsest coin type
                    it was filed under. Joining every level would repeat each
                    sale five times. */
                JOIN listing_instrument li ON li.browse_id = o.browse_id
                JOIN instrument i ON i.key = li.key AND i.level = 0
                WHERE o.sold = 1
                ORDER BY o.ended_at DESC
                LIMIT ?
            `).all(limit || 20)
        },

        /*
            Live auctions on coins we can identify, cheapest against their own
            gold first.

            This is what an opportunity actually is. The old definition
            required a projected final price, a sufficient fair value and a
            bid ceiling, and only looked at lots inside their last two hours -
            between them those conditions meant no auction alert had EVER
            fired, while the panel filled with Buy-It-Now lots whose only
            claim was sitting under a contaminated median.

            An auction opening at or under the spot value of its gold is worth
            seeing whether or not you bid: it can be bought at fair value, and
            watching where it finishes is how fair value gets measured in the
            first place. No uplift curve required, no clearing history
            required - just the coin, the gold in it, and the price today.

            Level 0 only, so each lot appears once rather than at every level
            of its key.
        */
        /*  Live lots the scanner can price, by how they are being sold.

            AUCTION only was the whole of this query, and it is why 2,673 live
            Buy-It-Now lots were tracked and invisible - the owner asked to see
            them, especially the ones barely over spot. saleType is one of
            auction, bin or all.

            A BUY-IT-NOW HAS NO END TIME. It is Good-'Til-Cancelled, so
            end_time > now - which admits a live auction - would reject every
            one of them. Both predicates below become "null or ahead", and the
            ordering has to put the untimed ones somewhere deliberate rather
            than wherever NULL happens to sort.
        */
        liveListings (limit, saleType) {
            const format = saleType === 'bin'
                ? "AND l.buying_options NOT LIKE '%AUCTION%'"
                : (saleType === 'all' ? '' : "AND l.buying_options LIKE '%AUCTION%'")
            const formatScope = format.replace(/\bl\./g, 'lf.')
            return db.prepare(`
                WITH scope AS (
                    /*  THE METAL TRAVELS WITH THE COIN. Without it the caller
                        asks spot for no metal, gets gold, and measures a
                        silver dollar against it: a GBP 74 Morgan reads 3% of
                        its "spot value", passes an "at or near spot" filter
                        meant for a 5% band, and outranks every sovereign in
                        the panel. Measured on the live store: 217 of the 281
                        admitted lots were Morgans that do not belong there.

                        clearingObservations and activeListings have selected
                        this all along; these two queries were simply missed. */
                    SELECT li.browse_id, li.key, li.quantity, i.fine_oz, i.metal
                    FROM listing_instrument li
                    JOIN instrument i ON i.key = li.key AND i.level = 0
                    /*  THE SAME FILTER THE TAIL APPLIES, APPLIED FIRST.

                        The latest CTE below finds the newest snapshot for every
                        listing in this CTE, and the tail then throws almost
                        all of them away: of 15,079 tracked listings only
                        2,213 are unresolved auctions still running and still
                        being seen, and only 417 come back. Building the
                        newest-snapshot set for the other 12,866 was the
                        single most expensive thing the front page did.

                        Measured on a copy of the live store: 1,249ms -> 255ms
                        for the same 417 rows, compared field by field. The
                        tail keeps its own copy of these conditions - they are
                        what makes the row correct, this is only what makes it
                        cheap, and a filter that exists for speed should not be
                        the one deciding what the answer is. */
                    JOIN listing lf ON lf.browse_id = li.browse_id
                    WHERE (lf.end_time IS NULL OR lf.end_time > ?1)
                      ${formatScope}
                      AND lf.last_seen > ?2
                      AND NOT EXISTS (SELECT 1 FROM listing_outcome o
                                      WHERE o.browse_id = li.browse_id)
                ),
                /*  Latest snapshot per listing, grouped ONCE.

                    This was a correlated subquery matching observed_at
                    against a MAX taken per s.browse_id: a seek per listing, as
                    the note it replaced said, but a seek PER CANDIDATE ROW
                    rather than per listing. The scope
                    here averages 121 snapshots a lot, so it ran that seek
                    around a hundred times per listing to answer a question
                    with one answer per listing.

                    Grouping first asks it once. Measured on the live store
                    (447MB, 3.59M snapshots): the scoped form 168ms -> 56ms,
                    the unscoped one in liveAuctions 6.09s -> 1.57s, and both
                    return byte-identical rows - 679/679 and 29,668/29,668
                    compared field by field.

                    No index was added and none is needed: listing_snapshot is
                    WITHOUT ROWID on PRIMARY KEY (browse_id, observed_at), so
                    that key already IS the index this wants. Adding an
                    explicit one was measured at 168ms -> 182ms, i.e. nothing,
                    because it duplicated the primary key.

                    That same key is what makes the join safe. Two snapshots of
                    one listing cannot share an observed_at, so the equality
                    cannot match twice and duplicate a row - excluded by the
                    schema rather than by luck. */
                /*  MEASURED BACK. The grouped form three functions up is
                    3x faster where the scope is one instrument; here, where
                    the scope is every tracked listing, it was 3x SLOWER -
                    1.6s to 5.2s a call, and the front page went from 10.3s to
                    16.3s. Grouping 3.59M snapshots against a CTE of 15,069
                    beats the planner's ability to drive the seek from scope,
                    and the correlated form keeps that plan. The lesson is that
                    the shape is not the win; the SIZE OF THE SCOPE decides
                    which shape wins, so both live here on purpose. */
                latest AS (
                    SELECT s.browse_id, s.price, s.shipping, s.bid_count
                    FROM listing_snapshot s
                    JOIN scope ON scope.browse_id = s.browse_id
                    WHERE s.observed_at = (SELECT MAX(s2.observed_at)
                                           FROM listing_snapshot s2
                                           WHERE s2.browse_id = s.browse_id)
                )
                SELECT l.browse_id AS browseId, l.legacy_id AS legacyId, l.title,
                       l.item_web_url AS itemWebUrl, l.image_url AS imageUrl,
                       l.category_path AS categoryPath, l.condition_label AS conditionLabel,
                       l.buying_options AS buyingOptions, l.item_country AS itemCountry,
                       l.seller_feedback_pct AS sellerFeedbackPct,
                       l.seller_feedback_cnt AS sellerFeedbackCnt,
                       l.end_time AS endTime, l.first_seen AS firstSeen,
                       /*  When the SELLER put it up, not when we found it. The two
                           differ by a median 87.8 hours on this store's older rows
                           (MKT-14), so first_seen would report our own discovery lag
                           as the lot's age. Null on 52 of 27,936 live rows. */
                       l.start_time AS listedAt,
                       l.last_seen AS lastSeen,
                       scope.key AS instrumentKey, scope.quantity AS lotQuantity,
                       scope.fine_oz * scope.quantity AS fineOz,
                       /*  The metal this coin is made of, and the series it
                           belongs to - so a caller can price it and name it
                           without guessing at either. */
                       scope.metal, l.series,
                       s.price, s.shipping, s.bid_count AS bidCount,
                       lb.verdict, lb.denomination AS labelledDenomination, lb.pool AS labelledPool,
                       lb.quantity AS labelledQuantity,
                       q.reason, 1 AS priced, 1 AS live
                FROM scope
                JOIN listing l ON l.browse_id = scope.browse_id
                LEFT JOIN latest s ON s.browse_id = l.browse_id
                LEFT JOIN listing_label lb ON lb.legacy_id = l.legacy_id
                LEFT JOIN review_queue q ON q.browse_id = l.browse_id AND q.resolved_at IS NULL
                LEFT JOIN listing_outcome o ON o.browse_id = l.browse_id
                WHERE 1 = 1
                  ${format}
                  AND o.browse_id IS NULL
                  AND (l.end_time IS NULL OR l.end_time > ?1)
                  AND l.last_seen > ?2
                  AND s.price IS NOT NULL
                /*  Timed lots first, soonest first. A Buy-It-Now has no
                    deadline, so putting it in the timed sequence would invent
                    one and putting it first would lead with the least urgent
                    lot on the page.

                    UNTIMED LOTS SORT CHEAPEST AGAINST THEIR METAL, and that
                    ordering is load-bearing rather than cosmetic: 2,673 Buy-
                    It-Now lots are tracked and this returns 500, so whatever
                    the ordering is decides which 81% are never seen. Dearest
                    first would hide precisely the lots the owner asked for.

                    The ratio here is price over metal, WITHOUT the buyer fee
                    the page adds - the fee rises with the price, so it barely
                    moves the order, and reproducing its bands in SQL would put
                    a second definition of the premium in the codebase. This
                    chooses which rows to fetch; the premium shown on the row
                    is still the one PREMIUM.totalCost computes. */
                ORDER BY l.end_time IS NULL, l.end_time ASC,
                    (s.price + COALESCE(s.shipping, 0)) / NULLIF(
                        scope.fine_oz * scope.quantity * (
                            SELECT sp.gbp_per_oz FROM spot sp
                            WHERE sp.metal = scope.metal
                            ORDER BY sp.observed_at DESC LIMIT 1
                        ), 0) ASC NULLS LAST
                LIMIT ?3
            `).all(
                new Date().toISOString(),
                new Date(Date.now() - (config.activeWithinHours || 24) * 60 * 60 * 1000).toISOString(),
                limit || 400
            )
        },

        /*
            HOW MANY THERE ACTUALLY ARE, which is not how many came back.

            liveListings caps at 500 and the summary strip printed the length
            of what it got under the label "Lots checked". Measured on the
            live store the two numbers are a different kind of thing: 448 live
            auctions, which is every one of them and never touches the cap, and
            2,497 Buy-It-Now lots, of which the page reads 500 and called it
            the market. Presenting a total and a fetch size in the same cell
            in the same typeface is how a reader comes to trust the wrong one.

            Every predicate the list applies, and no more: the scope's own
            filters plus the tail's `s.price IS NOT NULL`, because a lot whose
            latest snapshot has no price can never appear in the list at any
            limit. What it does NOT carry is the ORDER BY, which is where the
            list spends most of its time - a correlated spot lookup per row -
            and the LIMIT, whose early-out it loses. Measured on the Pi: 57ms
            against 1,080ms to materialise the same Buy-It-Now population.

            DISTINCT because a listing filed under more than one level-0 key
            would otherwise be counted once per key, which is the shape of
            fault soldCount was written to avoid.
        */
        liveListingCount (saleType) {
            const format = saleType === 'bin'
                ? "AND l.buying_options NOT LIKE '%AUCTION%'"
                : (saleType === 'all' ? '' : "AND l.buying_options LIKE '%AUCTION%'")
            const row = db.prepare(`
                /*  ONE SEEK PER LOT, NOT A PASS OVER THE SNAPSHOTS.

                    Three shapes measured on the Pi for the identical answer,
                    which is what makes the choice a measurement rather than a
                    preference:

                      grouped latest-per-lot      180ms auction / 3,443ms bin
                      correlated MAX per row      251ms / 738ms
                      this                         57ms / 100ms

                    listing_snapshot is WITHOUT ROWID on (browse_id,
                    observed_at), so "the newest row for this lot" is a single
                    index seek and the scope has a few thousand lots in it.
                    The other two shapes walk every snapshot those lots have -
                    about 121 each - and decide afterwards.

                    The first version of this query did worse still: it grouped
                    listing_snapshot over EVERY listing in the store and then
                    discarded the nine tenths that fail the cheap predicates
                    above. 1,837ms a call, on a page that renders in 700ms.
                    That is the same mistake liveListings records fixing forty
                    lines down, made again in the query written to match it,
                    and it got there because the 57ms I measured was of this
                    count BEFORE the price check was added and I did not
                    measure it again after.

                    The price check itself currently excludes nothing - all
                    three shapes return 445 and 2,491 - but it is the list's
                    predicate and the two have to describe one shelf. */
                WITH scope AS (
                    SELECT DISTINCT li.browse_id
                    FROM listing_instrument li
                    JOIN instrument i ON i.key = li.key AND i.level = 0
                    JOIN listing l ON l.browse_id = li.browse_id
                    WHERE (l.end_time IS NULL OR l.end_time > ?1)
                      ${format}
                      AND l.last_seen > ?2
                      AND NOT EXISTS (SELECT 1 FROM listing_outcome o
                                      WHERE o.browse_id = li.browse_id)
                )
                SELECT COUNT(*) AS n
                FROM scope
                WHERE (SELECT s.price FROM listing_snapshot s
                       WHERE s.browse_id = scope.browse_id
                       ORDER BY s.observed_at DESC LIMIT 1) IS NOT NULL
            `).get(
                new Date().toISOString(),
                new Date(Date.now() - (config.activeWithinHours || 24) * 60 * 60 * 1000).toISOString()
            )
            return row === undefined ? 0 : row.n
        },

        /*  What every existing caller meant. Kept so a reader looking for
            "the live auctions" still finds a function with that name. */
        liveAuctions (limit) {
            return this.liveListings(limit, 'auction')
        },

        /*
            How the tracked market breaks down: live against ended, auction
            against Buy-It-Now, sold against unsold.

            The uncomfortable number this exposes is `binEnded`. A Buy-It-Now
            listing is Good-'Til-Cancelled and carries no end time, and
            pendingOutcomes only offers up listings whose end time has passed
            - so a BIN lot can never enter outcome resolution and we do not
            know whether any of them has ever sold. Reporting that as a zero
            sell-through would be a lie; it is unobserved, and the chart says
            so.
        */
        /*
            What the tracked market is made of, for one series or for all.

            Store-wide stops meaning anything once there are two: sovereigns
            are 94% Buy-It-Now, and a market with a different format mix
            averaged into that describes neither of them.

            Scoped by key prefix rather than a column, because instrument
            rows carry no series and two of them do not justify a migration.
            The trailing dot is what makes it safe - 'US.MORGAN.%' cannot
            match a future 'US.MORGAN_PROOF.x'. The prefix is bound as a
            parameter, never spliced, so a series id can never be SQL.
        */
        marketComposition (seriesId) {
            const scoped = seriesId !== undefined && seriesId !== null && seriesId !== ''
            const prefix = scoped ? String(seriesId) + '.%' : null

            /*  The scope is expressed against whichever table the query is
                counting, so both spellings are needed. */
            const inSeries = (alias) => scoped
                ? ' AND EXISTS (SELECT 1 FROM listing_instrument li WHERE li.browse_id = ' +
                  alias + '.browse_id AND li.key LIKE ?)'
                : ''
            /*  Scope parameters go LAST, because the ? for the prefix is
                appended after whatever the query already binds. */
            const one = (sql, ...args) =>
                db.prepare(sql).get(...(scoped ? args.concat([prefix]) : args)).n

            const liveClause = `
                NOT EXISTS (SELECT 1 FROM listing_outcome o WHERE o.browse_id = l.browse_id)
                AND (l.end_time IS NULL OR l.end_time > ?)`

            const now = new Date().toISOString()
            const dayAgo = new Date(Date.now() - DAY_MS).toISOString()
            return {
                liveAuction: one(
                    'SELECT COUNT(*) n FROM listing l WHERE ' + liveClause +
                    " AND l.buying_options LIKE '%AUCTION%'" + inSeries('l'), now),
                liveBin: one(
                    'SELECT COUNT(*) n FROM listing l WHERE ' + liveClause +
                    " AND l.buying_options NOT LIKE '%AUCTION%'" + inSeries('l'), now),
                auctionSold: one(
                    "SELECT COUNT(*) n FROM listing_outcome o WHERE o.sale_type = 'AUCTION'" +
                    ' AND o.sold = 1' + inSeries('o')),
                auctionUnsold: one(
                    "SELECT COUNT(*) n FROM listing_outcome o WHERE o.sale_type = 'AUCTION'" +
                    ' AND o.sold = 0' + inSeries('o')),
                binEnded: one(
                    "SELECT COUNT(*) n FROM listing_outcome o WHERE o.sale_type <> 'AUCTION'" +
                    inSeries('o')),
                /*  BIN lots that have gone quiet: last seen more than a day
                    ago and never resolved. Each one has either sold or been
                    withdrawn and we cannot currently tell which. */
                binVanished: one(
                    'SELECT COUNT(*) n FROM listing l WHERE l.end_time IS NULL' +
                    " AND l.buying_options NOT LIKE '%AUCTION%' AND l.last_seen < ?" +
                    ' AND NOT EXISTS (SELECT 1 FROM listing_outcome o WHERE o.browse_id = l.browse_id)' +
                    inSeries('l'), dayAgo),
                newToday: one(
                    'SELECT COUNT(*) n FROM listing l WHERE l.first_seen > ?' + inSeries('l'), dayAgo)
            }
        },

        /* Retention: raw eBay rows roll off, derived statistics stay.

           listing_label and learned_rule are absent from the table list
           below on purpose. Raw eBay item data is theirs and expires; a
           judgement someone made about it is ours and is kept, so a label
           remains a training example after the listing it came from has
           gone. */
        /*  A transaction, without every caller needing the handle.

            discover.js takes a repository and not a db, and adding one to its
            dependencies to let it batch its writes would have been the wrong
            way round - the store is what knows how it is written to. */
        inTransaction (work) { return STORE.inTransaction(db, work) },

        purgeExpired (nowIso) {
            const now = nowIso || new Date().toISOString()
            const doomed = db.prepare('SELECT browse_id FROM listing WHERE expires_at < ?').all(now)
            if (doomed.length === 0) { return 0 }

            /*
                A COMMIT PER CHUNK, NOT ONE AT THE END.

                The deletes were already chunked by 400 and then all committed
                together, so the whole purge - six tables across every expired
                row, with 180-day retention and one snapshot per listing per
                sweep - was a single write lock held for as long as it took.
                Unattended, once a day, on an SD card. Anything the dashboard
                tried to write while it ran waited for the whole thing.

                Chunked commits make the maximum lock hold one chunk instead,
                which the busy timeout can absorb. What that costs is
                atomicity across the purge: an interrupted run leaves some
                expired rows deleted and some not. That is the right trade
                here and it would not be everywhere - these rows are already
                past their retention date, deleting them is idempotent, and
                the next daily run finishes the job. A half-finished purge is
                a purge that will complete tomorrow; a half-finished label is
                a wrong answer.
            */
            const ids = doomed.map(r => r.browse_id)
            const chunk = 400
            const tables = ['listing_snapshot', 'aspect', 'listing_instrument',
                'review_queue', 'listing_outcome', 'listing']
            for (let i = 0; i < ids.length; i += chunk) {
                const slice = ids.slice(i, i + chunk)
                STORE.inTransaction(db, () => {
                    const marks = slice.map(() => '?').join(',')
                    for (const table of tables) {
                        db.prepare('DELETE FROM ' + table + ' WHERE browse_id IN (' + marks + ')')
                            .run(...slice)
                    }
                })
            }
            return doomed.length
        },

        config
    }
}
