'use strict'

const BROWSE = require('../ebay/browse.js')
const { classify } = require('../catalogue/classify.js')
const INSTRUMENTS = require('../catalogue/instruments.js')
const EXCLUSIONS = require('../catalogue/exclusions.js')
const SERIES = require('../catalogue/series/index.js')
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

    /*  allowedCountries is absent by default and must stay that way unless
        the owner chooses otherwise - see EXCLUSIONS.screenLocation. */
    const config = Object.assign(
        { marketplace: 'EBAY_GB', currency: 'GBP', allowedCountries: [] }, options || {})

    /*
        Re-read per call, not captured once.

        The caller's comment has always said "re-read on every sweep, so
        changing it on the page takes effect on the next one without a
        restart" - and the code snapshotted it at construction, so it did
        not. A country chosen on the dashboard sat unapplied until somebody
        restarted the collector, which nobody would connect to the click.
    */
    const allowedCountries = () => typeof config.allowedCountries === 'function'
        ? (config.allowedCountries() || [])
        : (config.allowedCountries || [])


    /*
        Builds the partitioned query set. Partitioning exists because a
        Browse result set is capped at 10,000 items - a query broader than
        that is silently truncated, and you never learn which listings you
        did not see.
    */
    function buildQueries (coins) {
        const queries = []
        for (const partition of coins.partitions) {
            /*  A partition may opt out of price banding. Bands exist to keep
                a broad search under eBay's 10,000-item cap; a partition that
                asks for the NEWEST few and stops has no such problem, and
                banding it would multiply one cheap call into six. */
            const bands = partition.bands === false
                ? [null]
                : (coins.priceBands && coins.priceBands.length > 0 ? coins.priceBands : [null])
            for (const band of bands) {
                const filter = { buyingOptions: partition.buyingOptions }
                if (band !== null) {
                    filter.price = '[' + band[0] + '..' + band[1] + ']'
                    filter.priceCurrency = config.currency
                }
                /*  Ask eBay for the countries we will actually buy from.

                    This is the cheap half of the filter. A Browse search is
                    billed per call and returns 200 listings a call, so a
                    result set a third smaller is a third fewer calls - and
                    the ones we skip were going to be screened out at
                    classification time anyway.

                    It is also the blind half: a listing excluded here is
                    never seen, so it cannot appear in the review queue and
                    cannot be argued with. That is why the same list is
                    applied again at classification, where it is visible and
                    reversible, and why an empty list here means "ask for
                    everything" rather than "ask for nothing". */
                if (allowedCountries().length > 0) {
                    filter.itemLocationCountry = allowedCountries()
                }
                queries.push({
                    name: partition.name + (band ? '-' + band[0] + '-' + band[1] : ''),
                    /*  How deep to page. One page is 200 listings; a
                        newly-listed partition wants the newest page and
                        nothing behind it, because everything behind it is
                        what the other partitions already sweep. */
                    maxPages: Number.isFinite(partition.maxPages) ? partition.maxPages : undefined,
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

    /*
        COMMITTED IN CHUNKS, NOT PER LISTING.

        Nothing changed about WHAT is written - only about when it becomes
        durable. Each listing costs between four and eight statements
        (saveListing, saveSnapshot, setListingSeries or queueForReview, and
        two per instrument key) and every one of them was its own autocommit
        transaction. A Browse page is 200 listings, so a page was of the order
        of a thousand lock-acquire / fsync / lock-release cycles back to back.
        That is what a single-row label write from the dashboard was queueing
        behind, and why it reported "database is locked": not one long
        transaction, a thousand short ones with no gap between them. SQLite's
        busy handler backs off with increasing sleeps, so the waiting writer's
        odds got worse the longer it waited.

        WHAT BATCHING COSTS. Progress was durable per listing, so a crash
        mid-sweep kept everything it had. Now it keeps everything up to the
        last committed chunk and loses the one in flight - at most CHUNK
        listings. The loss is bounded on purpose and it is cheap: saveListing
        is an upsert, the sweep is a re-runnable read of a live search, and
        the next sweep re-observes the same lots within the hour. What is lost
        is part of the value of one eBay call, not a fact nobody else holds.
        The one thing that is NOT recoverable is a snapshot of a price at a
        moment, which is why CHUNK is small rather than "the whole page".

        CHUNK IS SIZED FOR LOCK HOLD TIME, NOT THROUGHPUT. Fifty listings
        already removes 98% of the commits; two hundred removes 99.5% and
        holds the write lock four times as long - and holding the write lock
        is precisely the thing that was starving the dashboard. The marginal
        fsync saving falls off a cliff; the marginal harm does not.

        AND THE TRANSACTION MUST NOT SPAN AN AWAIT. There is none in the loop
        and there must never be: node:sqlite is synchronous, so an await
        inside BEGIN..COMMIT would hand the event loop to another timer in
        this process, which would BEGIN again and be told it cannot start a
        transaction within a transaction. The eBay call stays where it is, in
        the caller.
    */
    const INGEST_CHUNK = 50

    async function ingest (items, seenAt, seriesId) {
        let created = 0
        let reviewed = 0

        /*  What the owner has already decided, read once per batch and
            OUTSIDE every transaction - these are the reads, and they must not
            lengthen a write lock.

            Without this a rule accepted today would not apply to anything
            discovered tomorrow - the collector would keep re-admitting the
            exact class of listing it had just been taught to reject, until
            somebody remembered to reclassify. A teaching loop the collector
            ignores is not a loop.
        */
        const labels = repository.labelIndex()
        const learned = LEARNED.compile(repository.learnedRules())

        for (let start = 0; start < items.length; start += INGEST_CHUNK) {
            /*  Counted from the chunk's own tally and added only after the
                commit returns. Incrementing the outer totals inside the loop
                would report a rolled-back chunk as classified, and the sweep
                log is the only thing anybody reads to know the collector is
                working. */
            const counts = repository.inTransaction(() =>
                ingestChunk(items.slice(start, start + INGEST_CHUNK), seenAt, seriesId,
                    labels, learned))
            created += counts.created
            reviewed += counts.reviewed
        }
        return { created, reviewed }
    }

    /*  The loop body, unchanged down to its three continues - chunking is
        around the loop, not inside it. */
    function ingestChunk (items, seenAt, seriesId, labels, learned) {
        let created = 0
        let reviewed = 0

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
                    EXCLUSIONS.screenLocation(item.itemCountry, allowedCountries())
                if (wrongCategory !== null) {
                    repository.queueForReview(item.browseId, 'EXCLUDED: ' + wrongCategory.reason, null, 0)
                    continue
                }
            }

            /*
                Which coin is this?

                Asked of the PACKS, never of the search that found it. The
                partition is passed only as a hint, and a hint alone never
                decides - otherwise a Peace dollar turned up by the Morgan
                sweep becomes a Morgan and a sovereign turned up by it
                becomes one too, and reclassify could never reproduce either
                because a stored listing has no memory of which query
                returned it.

                Nothing claims it, or two packs both do: that is a question
                for a human, not a coin flip.
            */
            const claim = SERIES.recognise(item.title, { hint: seriesId })
            /*  Same rule as the rebuild path: a person who has named the
                series has read the title, and a sweep must not undo them.
                See the note in reclassify.js. */
            const told = claim.pack === null && label !== null && label.series
                ? SERIES.get(label.series)
                : null
            /*  And a learned inclusion rule, which is the same evidence
                generalised: somebody said this pattern is a tracked coin.
                Below a label, which is about THIS listing, and below a pack,
                which read the title itself. */
            const ruled = claim.pack === null && told === null && learned !== null
                ? SERIES.get(learned.seriesFor(item.title))
                : null
            const pack = claim.pack || told || ruled

            if (pack === null) {
                repository.setListingSeries(item.browseId, null)
                repository.queueForReview(item.browseId, claim.reasons.join('; '), null, 0)
                reviewed++
                continue
            }
            repository.setListingSeries(item.browseId, pack.id)

            const result = classify({ title: item.title }, { label, learned, series: pack.id })

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

        /*  A full sweep across every partition of one series' searches. The
            series id rides through to ingest as a HINT - what a partition
            was looking for, never what it found. */
        async sweep (coins, seriesId) {
            const seenAt = new Date().toISOString()
            const queries = buildQueries(coins)
            const report = { queries: queries.length, items: 0, classified: 0, review: 0, truncated: [], errors: [] }

            for (const entry of queries) {
                try {
                    const result = await browseClient.searchAll(entry.query, entry.maxPages === undefined
                        ? { job: 'discover' }
                        : { job: 'discover', maxPages: entry.maxPages })
                    report.items += result.items.length
                    if (result.truncated) { report.truncated.push(entry.name) }

                    const ingested = await ingest(result.items, seenAt, seriesId)
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
        async endingSoon (coins, seriesId) {
            const seenAt = new Date().toISOString()
            const report = { items: 0, errors: [] }

            for (const partition of coins.partitions) {
                if (!partition.buyingOptions.includes('AUCTION')) { continue }
                try {
                    const payload = await browseClient.search({
                        q: partition.q,
                        category_ids: (coins.categoryIds || []).join(',') || undefined,
                        /*  The same country restriction the sweep applies.
                            Omitting it here meant the five-minute poller
                            fetched lots the owner cannot buy, every five
                            minutes, for every series - and it is the reason
                            a Morgan sweep pulled 3,664 US listings into a
                            UK-only store within the hour. A filter that
                            holds on one path and not the other is not a
                            filter, it is a leak with a schedule. */
                        filter: BROWSE.buildFilter(Object.assign(
                            { buyingOptions: ['AUCTION'] },
                            allowedCountries().length > 0
                                ? { itemLocationCountry: allowedCountries() }
                                : {})),
                        sort: 'endingSoonest',
                        limit: BROWSE.MAX_LIMIT
                    }, 'endingSoon')

                    const items = (payload.itemSummaries || []).map(BROWSE.normaliseSummary)
                    report.items += items.length
                    await ingest(items, seenAt, seriesId)
                } catch (err) {
                    if (err.code === 'BUDGET_EXHAUSTED') { break }
                    report.errors.push(partition.name + ': ' + err.message)
                }
            }
            return report
        }
    }
}
