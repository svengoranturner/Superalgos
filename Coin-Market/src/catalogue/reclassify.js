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

    /*  Empty unless somebody has explicitly chosen to filter by country.
        See EXCLUSIONS.screenLocation - filtering to GB alone costs 1,268
        genuine sovereigns, most of them Australian branch-mint coins. */
    const allowedCountries = (options && options.allowedCountries) || []

    const before = db.prepare('SELECT COUNT(*) AS n FROM listing_instrument').get().n
    const counts = emptyCounts()

    inTransaction(db, () => {
        db.exec('DELETE FROM listing_instrument')
        db.exec('DELETE FROM instrument')
        db.exec('DELETE FROM review_queue')
        try { db.exec('DELETE FROM instrument_stat') } catch (err) { /* older stores may not have it */ }

        /*  Both read once and held in memory. This walks thousands of rows,
            and a query per row on a Pi turns seconds into minutes. */
        const labels = repository.labelIndex()
        const learned = LEARNED.compile(repository.learnedRules())

        const listings = db.prepare(
            'SELECT browse_id AS browseId, legacy_id AS legacyId, title, category_path AS categoryPath, item_country AS itemCountry FROM listing'
        ).all()
        counts.total = listings.length

        for (const listing of listings) {
            classifyOne(listing, labels.get(listing.legacyId) || null, learned, repository,
                counts, allowedCountries)
        }
    })

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
