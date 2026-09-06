'use strict'

const CLASSIFY = require('./classify.js').classify
const EXCLUSIONS = require('./exclusions.js')
const INSTRUMENTS = require('./instruments.js')
const LEARNED = require('./learned.js')
const SERIES = require('./series/index.js')
const STORE = require('../store/db.js')

/*
    Re-runs classification over stored listings.

    Extracted from the CLI so the dashboard can call it too. That is what
    makes the labelling loop feel like a loop: a decision recorded in the
    review queue changes the numbers on the front page immediately, rather
    than the next time somebody remembers to run a command. Classification
    is derived data and can always be rebuilt from the stored titles.

    Only derived tables are cleared. Listings, snapshots and outcomes -
    everything that cost an API call or can never be re-observed - are
    untouched, and so are the labels and rules, which are the whole point.
*/

function emptyCounts () {
    return { total: 0, classified: 0, reviewed: 0, excluded: 0, wrongCategory: 0, labelled: 0 }
}

/*
    One listing, against what we currently know. Shared by the full rebuild
    and the single-coin path so the two can never drift - a decision that
    behaved differently depending on which one ran would be worse than
    either.
*/
function classifyOne (listing, label, learned, repository, counts, allowedCountries) {

    /*  Same order as discovery: eBay's own category before the title
        parser, because it is the stronger evidence.

        A human verdict outranks even that. Somebody who has looked at the
        listing and said it is a sovereign is better evidence than a
        category the seller picked, and a review queue that quietly
        re-raises a settled question is a review queue nobody uses. */
    if (label === null || label.verdict === LEARNED.VERDICT.UNSURE) {
        const offCategory = EXCLUSIONS.screenCategory(listing.categoryPath) ||
            EXCLUSIONS.screenLocation(listing.itemCountry, allowedCountries)
        if (offCategory !== null) {
            repository.queueForReview(listing.browseId, 'EXCLUDED: ' + offCategory.reason, null, 0)
            counts.wrongCategory++
            return
        }
    }

    /*
        Which coin is this?

        Asked of the packs, exactly as discovery asks - and with no hint at
        all, because a stored listing has no memory of which search returned
        it. That asymmetry is why the hint may never DECIDE on the discovery
        side either: if it could, a rebuild would disagree with the ingest
        that created the row, and the disagreement would be silent.
    */
    const claim = SERIES.recognise(listing.title)
    /*
        A HUMAN VERDICT OUTRANKS THE TITLE PARSER HERE TOO.

        The comment fifteen lines up already says so, and it was only being
        applied to the category screen. The series gate below it re-derived
        the series from the title on every pass and discarded whatever a
        person had said - so a coin the packs cannot name could be marked
        genuine, given a denomination, and be back in the queue with the same
        reason on the next sweep. Nothing the owner did to it could stick.

        Their example: "SCARCE GOLD 2POUND 1902 Edward VII Head Dragon London
        Spink 3967 UNC". No pack claims it because no pack looks for anything
        but the word sovereign or sov, so classify() was never called at all -
        no denomination, no key, no guess. Marked genuine, still unpriceable,
        and re-queued hourly.

        A label naming a series is the strongest evidence there is: somebody
        looked at the listing. It is used when the packs cannot decide, never
        to overrule one that can - a pack that recognises the title has read
        the same words the person did.
    */
    const told = claim.pack === null && label !== null && label.series
        ? SERIES.get(label.series)
        : null
    /*  And a learned inclusion rule, which is the same evidence
        generalised: somebody said this pattern is a tracked coin.
        Below a label, which is about THIS listing, and below a pack,
        which read the title itself. */
    const ruled = claim.pack === null && told === null && learned !== null
        ? SERIES.get(learned.seriesFor(listing.title))
        : null
    const pack = claim.pack || told || ruled

    if (pack === null) {
        repository.setListingSeries(listing.browseId, null)
        repository.queueForReview(listing.browseId, claim.reasons.join('; '), null, 0)
        counts.reviewed++
        return
    }
    repository.setListingSeries(listing.browseId, pack.id)

    const result = CLASSIFY({ title: listing.title }, { label, learned, series: pack.id })
    if (result.labelled) { counts.labelled++ }

    if (result.excluded !== null) {
        /*  Excluded lots are still queued with a reason - the dashboard
            shows what was filtered and why, so a bad rule is visible
            rather than silently eating half the market. */
        repository.queueForReview(listing.browseId, 'EXCLUDED: ' + result.excluded.reason, null, 0)
        counts.excluded++
        return
    }

    const keys = INSTRUMENTS.keysFor(result.attributes)
    if (keys.length === 0 || result.needsReview) {
        repository.queueForReview(
            listing.browseId,
            result.reasons.join('; ') || 'Low confidence',
            keys.length > 0 ? keys[keys.length - 1].key : null,
            result.confidence
        )
        counts.reviewed++
    }
    if (keys.length > 0) {
        repository.saveClassification(
            listing.browseId, keys, result.confidence,
            result.labelled ? 'human' : 'title',
            INSTRUMENTS.fineOzFor(result.attributes), result.attributes
        )
        counts.classified++
    }
}

/*
    One transaction around the whole thing.

    Without it every insert is its own transaction, which on the Pi's SD
    card means one fsync per row across roughly 20,000 writes: a rebuild
    that takes seconds inside a transaction took over two minutes outside
    one, and a button that triggers it was unusable.

    The local copy of this helper has gone to src/store/db.js, which is what
    lets a caller wrap a whole batch and have `one` below JOIN that
    transaction instead of throwing "cannot start a transaction within a
    transaction". It also brings BEGIN IMMEDIATE and a retry, which this
    never had - and this is the largest write-lock holder in the system, so
    it is the one that most needed both.
*/
const inTransaction = STORE.inTransaction

/* Everything. Justified when a rule changes, because a rule can reach any
   listing; wasteful for a single verdict, which is what one() is for. */
exports.run = function (db, repository, options) {
    /*  Every listing. The country filter rides through in options - see
        EXCLUSIONS.screenLocation, and note that filtering to GB alone costs
        1,268 genuine sovereigns, most of them Australian branch-mint. */
    return rebuild(db, repository, db.prepare(
        'SELECT browse_id AS browseId, legacy_id AS legacyId, title, category_path AS categoryPath, item_country AS itemCountry FROM listing'
    ).all(), options)
}

/*
    THE SAME REBUILD, OVER ONLY THE LISTINGS A CHANGE CAN REACH.

    A full rebuild is twenty seconds of work to answer a question that is
    usually about a few hundred listings. A learned rule's entire effect is
    gated on a title match - every branch in LEARNED.compile is
    `entry.test.test(title)`, and nothing in the compiled object is an
    aggregate over the rule set - so adding or deleting a rule with phrase P
    cannot change the outcome of any listing whose title does not match P.
    The country filter is narrower still: EXCLUSIONS.screenLocation reads
    nothing but the country and the allowed list.

    Callers pass legacy ids because that is what a decision is recorded
    against and a relisted coin has several browse ids sharing one - the same
    key `one` uses.

    THE CALLER MUST BUILD THE SET WITH LEARNED.phrasePattern, not with
    `title.includes(phrase)`. The pattern lowercases, collapses whitespace
    runs to \s+ and adds word boundaries only where the phrase starts or ends
    with a word character; a naive substring test would miss listings the rule
    actually reaches, and a rule reaching a listing this pass did not visit is
    the silent half-rebuilt store this whole design exists to avoid.
*/
exports.some = function (db, repository, legacyIds, options) {
    const ids = [...new Set((legacyIds || []).filter(Boolean).map(String))]
    if (ids.length === 0) { return emptyCounts() }

    /*  Chunked because SQLite binds a limited number of parameters per
        statement, and a rule like "proof" reaches well over a thousand. */
    const listings = []
    const READ_CHUNK = 400
    for (let start = 0; start < ids.length; start += READ_CHUNK) {
        const slice = ids.slice(start, start + READ_CHUNK)
        const marks = slice.map(() => '?').join(',')
        listings.push(...db.prepare(
            'SELECT browse_id AS browseId, legacy_id AS legacyId, title, ' +
            'category_path AS categoryPath, item_country AS itemCountry ' +
            'FROM listing WHERE legacy_id IN (' + marks + ')').all(...slice))
    }
    return rebuild(db, repository, listings, options)
}

function rebuild (db, repository, listings, options) {

    const allowedCountries = (options && options.allowedCountries) || []
    const before = db.prepare('SELECT COUNT(*) AS n FROM listing_instrument').get().n
    const counts = emptyCounts()

    /*  Both read once and held in memory, and outside every transaction.
        This walks thousands of rows, and a query per row on a Pi turns
        seconds into minutes. */
    const labels = repository.labelIndex()
    const learned = LEARNED.compile(repository.learnedRules())

    counts.total = listings.length

    /*
        A CHUNK AT A TIME, NOT THE WHOLE REBUILD.

        Measured against a copy of the live store: this held the write lock
        for 16.9 SECONDS, on a button click, from the request thread. It is
        the largest write-lock holder in the system by a distance, and the
        collector's writes during it do not queue - they fail, and
        scheduler.js swallows the error and logs it, so the loss is silent.
        No retry helps either, because a retry waits for exactly the thing in
        the way.

        The global DELETEs are what forced one transaction. They emptied
        three tables and then refilled them, so committing partway would have
        left the store visibly empty. Clearing per listing instead - the same
        two statements `one` already uses - means each listing moves from its
        old classification straight to its new one and is never missing, so
        the work can commit as it goes.

        WHAT A READER SEES CHANGES, AND IT IS THE BETTER TRADE. Before, a
        concurrent reader saw the old state for the whole rebuild and then the
        new one; now it can see a store where some listings have been
        reclassified and some have not, for as long as the rebuild takes. That
        is a few seconds of slightly-mixed counts on a page, against seventeen
        seconds in which the collector cannot record anything it observed.

        AND THE CHECKPOINTER IS HELD OFF FOR THE DURATION. Committing 125
        times instead of once lets SQLite's autocheckpoint fire repeatedly
        DURING the rebuild, copying pages back into a 538MB file - random
        writes on an SD card, over and over, for work the next chunk is about
        to supersede. Measured: 157 SECONDS with it on, 20 with it off. The
        threshold is restored afterwards and no checkpoint is forced, so the
        log drains on somebody else's ordinary write rather than inside this
        one's lock - restoring it before the last transaction put a 13.7s
        checkpoint inside that transaction's commit, which was worse than the
        problem.

        250, measured rather than reasoned. The old note here sized this from
        "one fsync per row turned seconds into two minutes", which stopped
        being true when db.js set synchronous = NORMAL - under WAL a commit no
        longer fsyncs at all. What was measured instead, over 30,822 listings
        on the live store:

            one transaction   22.0s total, write lock held for 21.9s straight
            250 per chunk     19.8s total, longest hold 584ms, median 155ms

        Faster overall AND thirty-seven times shorter in the worst case. The
        two rebuilds were compared row by row across listing_instrument,
        instrument, review_queue and listing.series: identical.
    */
    const CHUNK = 250

    /*  EXPERIMENT: hold the checkpointer off for the duration.

        Committing 120 times instead of once means SQLite's autocheckpoint
        (1000 pages) fires repeatedly DURING the rebuild, copying pages back
        into a 538MB database file - random writes on an SD card, over and
        over, for work that is about to be superseded by the next chunk. */
    const auto = db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint
    db.exec('PRAGMA wal_autocheckpoint = 0')
    try {
    for (let start = 0; start < listings.length; start += CHUNK) {
        const slice = listings.slice(start, start + CHUNK)
        inTransaction(db, () => {
            const clearInstrument = db.prepare('DELETE FROM listing_instrument WHERE browse_id = ?')
            const clearReview = db.prepare('DELETE FROM review_queue WHERE browse_id = ?')
            for (const listing of slice) {
                clearInstrument.run(listing.browseId)
                clearReview.run(listing.browseId)
                classifyOne(listing, labels.get(listing.legacyId) || null, learned, repository,
                    counts, allowedCountries)
            }
        })
    }

    /*
        AND THE ROWS NO LISTING CLAIMS ANY MORE.

        This is what the global DELETEs did for free and a per-listing loop
        cannot: a row whose listing has since been deleted is never visited,
        so it would survive a rebuild that is supposed to be a rebuild.

        Measured on the live store there are none of the first two today -
        purgeExpired and purgeSeller both delete the child rows with the
        parent - but "none today" is not a guarantee, foreign keys are off
        (PRAGMA foreign_keys is never set anywhere), and the cost of being
        wrong is a stale classification counted into a clearing price.

        The instrument rows are a real case rather than a theoretical one:
        four of the 2,391 on the live store are claimed by no listing, and
        before this they were swept away and rebuilt on every pass.

        One transaction, at the end, because it is three statements and none
        of them is per-listing. All three use an index for the inner lookup -
        checked with EXPLAIN QUERY PLAN, not assumed.
    */
    inTransaction(db, () => {
        db.exec('DELETE FROM listing_instrument WHERE NOT EXISTS ' +
            '(SELECT 1 FROM listing l WHERE l.browse_id = listing_instrument.browse_id)')
        db.exec('DELETE FROM review_queue WHERE NOT EXISTS ' +
            '(SELECT 1 FROM listing l WHERE l.browse_id = review_queue.browse_id)')
        db.exec('DELETE FROM instrument WHERE NOT EXISTS ' +
            '(SELECT 1 FROM listing_instrument li WHERE li.key = instrument.key)')
        /*  Older stores may not have it. */
        try {
            db.exec('DELETE FROM instrument_stat WHERE NOT EXISTS ' +
                '(SELECT 1 FROM listing_instrument li WHERE li.key = instrument_stat.key)')
        } catch (err) { }
    })
    } finally { db.exec('PRAGMA wal_autocheckpoint = ' + auto) }

    counts.assignmentsBefore = before
    counts.assignmentsAfter = db.prepare('SELECT COUNT(*) AS n FROM listing_instrument').get().n
    counts.instruments = db.prepare('SELECT COUNT(*) AS n FROM instrument').get().n
    return counts
}

/*
    One coin, not all five thousand.

    A verdict changes exactly the listings for that coin, so rebuilding the
    whole store on every click is both wasteful and - on a Pi, where the
    full rebuild is measured in seconds and not milliseconds - slow enough
    that people stop clicking, which costs far more than it saves.

    Keyed on legacy id, because that is what a decision is recorded against
    and a relisted coin has several browse ids sharing one.
*/
exports.one = function (db, repository, legacyId, options) {

    const allowedCountries = (options && options.allowedCountries) || []

    const listings = db.prepare(
        'SELECT browse_id AS browseId, legacy_id AS legacyId, title, category_path AS categoryPath, item_country AS itemCountry ' +
        'FROM listing WHERE legacy_id = ?').all(legacyId)

    const counts = emptyCounts()
    counts.total = listings.length
    if (listings.length === 0) { return counts }

    /*
        READ ONCE BY A CALLER THAT IS ALREADY HOLDING A TRANSACTION.

        These two are a full label-index build and a rule compilation, and
        they run per invocation. That was harmless while this was only ever
        called for one listing at a time; the moment /apply wraps a batch of
        thirty, it is thirty index builds and thirty compilations WHILE
        HOLDING THE WRITE LOCK - the batch would become atomic and much
        slower to release, trading one starvation for another.

        Absent overrides this behaves exactly as before, so the callers that
        use `one` on its own are untouched.
    */
    const label = (options && options.label !== undefined)
        ? options.label
        : (repository.labelIndex().get(legacyId) || null)
    const learned = (options && options.learned !== undefined)
        ? options.learned
        : LEARNED.compile(repository.learnedRules())

    inTransaction(db, () => {
        const clearInstrument = db.prepare('DELETE FROM listing_instrument WHERE browse_id = ?')
        const clearReview = db.prepare('DELETE FROM review_queue WHERE browse_id = ?')
        for (const listing of listings) {
            clearInstrument.run(listing.browseId)
            clearReview.run(listing.browseId)
            classifyOne(listing, label, learned, repository, counts, allowedCountries)
        }
    })

    return counts
}
