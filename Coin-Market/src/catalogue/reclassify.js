'use strict'

const CLASSIFY = require('./classify.js').classify
const EXCLUSIONS = require('./exclusions.js')
const INSTRUMENTS = require('./instruments.js')
const LEARNED = require('./learned.js')

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

    const result = CLASSIFY({ title: listing.title }, { label, learned })
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
*/
function inTransaction (db, work) {
    db.exec('BEGIN')
    try {
        const result = work()
        db.exec('COMMIT')
        return result
    } catch (err) {
        db.exec('ROLLBACK')
        throw err
    }
}

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

    const label = repository.labelIndex().get(legacyId) || null
    const learned = LEARNED.compile(repository.learnedRules())

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
