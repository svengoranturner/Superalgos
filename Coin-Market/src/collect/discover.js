'use strict'

const BROWSE = require('../ebay/browse.js')
const { classify } = require('../catalogue/classify.js')
const INSTRUMENTS = require('../catalogue/instruments.js')
const EXCLUSIONS = require('../catalogue/exclusions.js')
const LEARNED = require('../catalogue/learned.js')

/*
    Discovery and snapshotting - which, on eBay's current API surface, are
    the same operation.

    The bulk item lookup (getItems, <=20 ids) is Limited Release and closed
    to a standard keyset, so refreshing tracked lots one at a time would
    cost one call each. Re-running a search costs one call for up to 200
    listings instead. So the sweep does double duty: it finds new lots and
    refreshes the ones it already knows, roughly 200x cheaper than the
    obvious design.
*/

exports.newDiscoverer = function (browseClient, repository, options) {

    const config = Object.assign({ marketplace: 'EBAY_GB', currency: 'GBP' }, options || {})


    /*
        Builds the partitioned query set. Partitioning exists because a
        Browse result set is capped at 10,000 items - a query broader than
        that is silently truncated, and you never learn which listings you
        did not see.
    */
    function buildQueries (coins) {
        const queries = []
        for (const partition of coins.partitions) {
            const bands = coins.priceBands && coins.priceBands.length > 0
                ? coins.priceBands
                : [null]
            for (const band of bands) {
                const filter = { buyingOptions: partition.buyingOptions }
                if (band !== null) {
                    filter.price = '[' + band[0] + '..' + band[1] + ']'
                    filter.priceCurrency = config.currency
                }
                queries.push({
                    name: partition.name + (band ? '-' + band[0] + '-' + band[1] : ''),
                    query: {
                        q: partition.q,
                        category_ids: (coins.categoryIds || []).join(',') || undefined,
                        filter: BROWSE.buildFilter(filter),
                        sort: partition.sort || undefined
                    }
                })
            }
        }
        return queries
    }

    async function ingest (items, seenAt) {
        let created = 0
        let reviewed = 0

        /*  What the owner has already decided, read once per batch.

            Without this a rule accepted today would not apply to anything
            discovered tomorrow - the collector would keep re-admitting the
            exact class of listing it had just been taught to reject, until
            somebody remembered to reclassify. A teaching loop the collector
            ignores is not a loop.
        */
        const labels = repository.labelIndex()
        const learned = LEARNED.compile(repository.learnedRules())

        for (const item of items) {
            repository.saveListing(item, seenAt)
            repository.saveSnapshot(item.browseId, Object.assign({ observedAt: seenAt }, item))

            const label = labels.get(item.legacyId) || null

            /*  The seller has already told eBay what kind of thing this is.
                Checked before the title parser gets a say, because the
                category is the stronger evidence by a distance - but not
                before a human, who has seen the listing and is better
                evidence than a category the seller picked. */
            if (label === null || label.verdict === LEARNED.VERDICT.UNSURE) {
                const wrongCategory = EXCLUSIONS.screenCategory(item.categoryPath) ||
                    EXCLUSIONS.screenLocation(item.itemCountry)
                if (wrongCategory !== null) {
                    repository.queueForReview(item.browseId, 'EXCLUDED: ' + wrongCategory.reason, null, 0)
                    continue
                }
            }

            const result = classify({ title: item.title }, { label, learned })

            if (result.excluded !== null) {
                /* Excluded lots are still stored - the dashboard shows what
                   was filtered and why, so a bad rule is visible rather
                   than silently eating half the market. */
                repository.queueForReview(item.browseId, 'EXCLUDED: ' + result.excluded.reason, null, 0)
                continue
            }

            const keys = INSTRUMENTS.keysFor(result.attributes)
            if (keys.length === 0 || result.needsReview) {
                repository.queueForReview(
                    item.browseId,
                    result.reasons.join('; ') || 'Low confidence',
                    keys.length > 0 ? keys[keys.length - 1].key : null,
                    result.confidence
                )
                reviewed++
            }
            if (keys.length > 0) {
                repository.saveClassification(
                    item.browseId, keys, result.confidence,
                    result.labelled ? 'human' : 'title',
                    INSTRUMENTS.fineOzFor(result.attributes), result.attributes
                )
                created++
            }
        }
        return { created, reviewed }
    }

    return {
        buildQueries,
        ingest,

        /* A full sweep across every partition. */
        async sweep (coins) {
            const seenAt = new Date().toISOString()
            const queries = buildQueries(coins)
            const report = { queries: queries.length, items: 0, classified: 0, review: 0, truncated: [], errors: [] }

            for (const entry of queries) {
                try {
                    const result = await browseClient.searchAll(entry.query, { job: 'discover' })
                    report.items += result.items.length
                    if (result.truncated) { report.truncated.push(entry.name) }

                    const ingested = await ingest(result.items, seenAt)
                    report.classified += ingested.created
                    report.review += ingested.reviewed
                } catch (err) {
                    if (err.code === 'BUDGET_EXHAUSTED') { report.errors.push(entry.name + ': budget exhausted'); break }
                    report.errors.push(entry.name + ': ' + err.message)
                }
            }
            return report
        },

        /*
            High-frequency refresh of lots about to close. This is what
            feeds the uplift curve: the final hour is where an auction's
            price is actually decided, and coarse hourly snapshots would
            miss the entire move.
        */
        async endingSoon (coins) {
            const seenAt = new Date().toISOString()
            const report = { items: 0, errors: [] }

            for (const partition of coins.partitions) {
                if (!partition.buyingOptions.includes('AUCTION')) { continue }
                try {
                    const payload = await browseClient.search({
                        q: partition.q,
                        category_ids: (coins.categoryIds || []).join(',') || undefined,
                        filter: BROWSE.buildFilter({ buyingOptions: ['AUCTION'] }),
                        sort: 'endingSoonest',
                        limit: BROWSE.MAX_LIMIT
                    }, 'endingSoon')

                    const items = (payload.itemSummaries || []).map(BROWSE.normaliseSummary)
                    report.items += items.length
                    await ingest(items, seenAt)
                } catch (err) {
                    if (err.code === 'BUDGET_EXHAUSTED') { break }
                    report.errors.push(partition.name + ': ' + err.message)
                }
            }
            return report
        }
    }
}
