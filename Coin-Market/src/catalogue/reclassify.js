'use strict'

const CLASSIFY = require('./classify.js').classify
const EXCLUSIONS = require('./exclusions.js')
const INSTRUMENTS = require('./instruments.js')
const LEARNED = require('./learned.js')

/*
    Re-runs classification over every stored listing.

    Extracted from the CLI so the dashboard can call it too. That is what
    makes the labelling loop feel like a loop: a decision recorded in the
    review queue changes the numbers on the front page immediately, rather
    than the next time somebody remembers to run a command. Classification
    is derived data and can always be rebuilt from the stored titles, so
    doing it often costs nothing but time.

    Only derived tables are cleared. Listings, snapshots and outcomes -
    everything that cost an API call or can never be re-observed - are
    untouched, and so are the labels and rules, which are the whole point.
*/
exports.run = function (db, repository) {

    const before = db.prepare('SELECT COUNT(*) AS n FROM listing_instrument').get().n
    db.exec('DELETE FROM listing_instrument')
    db.exec('DELETE FROM instrument')
    db.exec('DELETE FROM review_queue')
    try { db.exec('DELETE FROM instrument_stat') } catch (err) { /* older stores may not have it */ }

    /*  Both read once and held in memory. reclassify walks thousands of
        rows, and a query per row on a Pi turns seconds into minutes. */
    const labels = repository.labelIndex()
    const learned = LEARNED.compile(repository.learnedRules())

    const listings = db.prepare(
        'SELECT browse_id AS browseId, legacy_id AS legacyId, title, category_path AS categoryPath FROM listing').all()

    const counts = { total: listings.length, classified: 0, reviewed: 0, excluded: 0, wrongCategory: 0, labelled: 0 }

    for (const listing of listings) {
        const label = labels.get(listing.legacyId) || null

        /*  Same order as discovery: eBay's own category before the title
            parser, because it is the stronger evidence.

            A human verdict outranks even that. Somebody who has looked at
            the listing and said it is a sovereign is better evidence than
            a category the seller picked, and a review queue that quietly
            re-raises a settled question is a review queue nobody uses. */
        if (label === null || label.verdict === LEARNED.VERDICT.UNSURE) {
            const offCategory = EXCLUSIONS.screenCategory(listing.categoryPath)
            if (offCategory !== null) {
                repository.queueForReview(listing.browseId, 'EXCLUDED: ' + offCategory.reason, null, 0)
                counts.wrongCategory++
                continue
            }
        }

        const result = CLASSIFY({ title: listing.title }, { label, learned })
        if (result.labelled) { counts.labelled++ }

        if (result.excluded !== null) {
            repository.queueForReview(listing.browseId, 'EXCLUDED: ' + result.excluded.reason, null, 0)
            counts.excluded++
            continue
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

    counts.assignmentsBefore = before
    counts.assignmentsAfter = db.prepare('SELECT COUNT(*) AS n FROM listing_instrument').get().n
    counts.instruments = db.prepare('SELECT COUNT(*) AS n FROM instrument').get().n
    return counts
}
