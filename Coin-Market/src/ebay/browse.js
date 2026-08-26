'use strict'

/*
    Browse API client.

    Three verified constraints are enforced here rather than left to the
    caller, because each one silently produces a plausible-but-wrong
    dataset if forgotten:

      1. Browse search returns ONLY fixed-price listings unless
         buyingOptions is set explicitly. Forget it and you build a
         BIN-only picture - precisely the seller-optimism bias this whole
         tool exists to measure. searchAll() therefore refuses to run
         without an explicit buyingOptions filter.

      2. A result set is capped at 10,000 items (offset 0-10,000,
         limit <= 200). Broad queries must be partitioned; paging past the
         cap silently truncates.

      3. getItems (bulk, <=20 ids) is Limited Release and unavailable to a
         standard keyset. Snapshotting therefore re-runs searches - one
         call refreshes up to 200 listings - instead of hydrating lots
         one by one.
*/

const MAX_LIMIT = 200
const MAX_OFFSET = 10000

exports.MAX_LIMIT = MAX_LIMIT
exports.MAX_OFFSET = MAX_OFFSET

exports.newBrowseClient = function (auth, options) {

    const config = Object.assign({ marketplaceId: 'EBAY_GB', budget: null }, options || {})

    async function call (path, params, job) {
        if (config.budget !== null && !config.budget.allows(job || 'snapshot', 1)) {
            const error = new Error('Call budget exhausted for job "' + job + '"')
            error.code = 'BUDGET_EXHAUSTED'
            throw error
        }

        const token = await auth.applicationToken()
        const url = new URL(auth.endpoints.browse + path)
        for (const [key, value] of Object.entries(params || {})) {
            if (value !== undefined && value !== null) { url.searchParams.set(key, String(value)) }
        }

        const response = await fetch(url, {
            headers: {
                Authorization: 'Bearer ' + token,
                'X-EBAY-C-MARKETPLACE-ID': config.marketplaceId,
                Accept: 'application/json'
            }
        })

        if (config.budget !== null) { config.budget.record('browse') }

        if (response.status === 429) {
            const error = new Error('eBay rate limit hit on ' + path)
            error.code = 'RATE_LIMITED'
            throw error
        }
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
            const detail = (payload.errors && payload.errors[0]) || {}
            const error = new Error('Browse ' + path + ' failed (' + response.status + '): ' +
                (detail.message || 'unknown'))
            error.code = detail.errorId === 11001 ? 'ITEM_NOT_FOUND' : 'BROWSE_ERROR'
            error.status = response.status
            throw error
        }
        return payload
    }

    return {
        /* One page. `filter` must already be a Browse filter string. */
        async search (params, job) {
            return call('/item_summary/search', params, job || 'discover')
        },

        /*
            Pages through a query up to the 10,000-item wall, yielding
            normalised summaries. Stops early when the caller's budget
            runs out rather than throwing away the work already done.
        */
        async searchAll (query, options) {
            const settings = Object.assign({ maxPages: 10, job: 'discover' }, options || {})

            if (!query.filter || !/buyingOptions:/.test(query.filter)) {
                throw new Error(
                    'Browse search requires an explicit buyingOptions filter. ' +
                    'Without it eBay returns FIXED_PRICE listings only, and auctions - ' +
                    'the entire clearing-price signal - are silently missing.'
                )
            }

            const items = []
            let offset = 0
            let total = null
            let truncated = false

            for (let page = 0; page < settings.maxPages; page++) {
                if (offset > MAX_OFFSET) { truncated = true; break }

                let payload
                try {
                    payload = await call('/item_summary/search',
                        Object.assign({}, query, { limit: MAX_LIMIT, offset }), settings.job)
                } catch (err) {
                    if (err.code === 'BUDGET_EXHAUSTED' || err.code === 'RATE_LIMITED') {
                        truncated = true
                        break
                    }
                    throw err
                }

                total = payload.total !== undefined ? payload.total : total
                const summaries = payload.itemSummaries || []
                for (const summary of summaries) { items.push(exports.normaliseSummary(summary)) }

                if (summaries.length < MAX_LIMIT) { break }
                offset += MAX_LIMIT
            }

            /* A query whose result set exceeds the wall is not fully
               observable - say so loudly so the caller partitions it. */
            if (total !== null && total > MAX_OFFSET) { truncated = true }

            return { items, total, truncated }
        },

        /* Full item detail, including localizedAspects. Costs one call per
           listing, so it is used once per listing ever - to hydrate item
           specifics - never for repeat snapshotting. */
        async getItem (itemId) {
            return call('/item/' + encodeURIComponent(itemId), { fieldgroups: 'PRODUCT' }, 'hydrate')
        }
    }
}

function money (value) {
    if (value === undefined || value === null) { return null }
    const amount = Number(value.value)
    return Number.isFinite(amount) ? amount : null
}

/*
    Flattens a Browse ItemSummary into the shape the store expects.

    legacyItemId is captured deliberately: the Trading API - our only route
    to a final sale price - speaks the bare numeric id, and a listing whose
    legacy id we never recorded can never have its outcome resolved.
*/
exports.normaliseSummary = function (summary) {
    const shipping = (summary.shippingOptions || [])[0]

    return {
        browseId: summary.itemId,
        legacyId: summary.legacyItemId || null,
        title: summary.title || '',
        categoryId: summary.categories ? (summary.categories[0] || {}).categoryId : null,
        conditionLabel: summary.condition || null,
        buyingOptions: (summary.buyingOptions || []).join(','),
        price: money(summary.price),
        currency: summary.price ? summary.price.currency : 'GBP',
        shipping: shipping ? money(shipping.shippingCost) : null,
        bidCount: Number.isFinite(summary.bidCount) ? summary.bidCount : null,
        currentBidPrice: money(summary.currentBidPrice),
        endTime: summary.itemEndDate || null,
        itemWebUrl: summary.itemWebUrl || null,
        imageUrl: summary.image ? summary.image.imageUrl : null,
        /*
            eBay replaced usernames with immutable user IDs in May 2026.
            Both are captured because the account-deletion notification may
            name the departing user by either, and a purge keyed on only
            one of them would silently match nothing.
        */
        sellerUserId: summary.seller
            ? (summary.seller.userId || summary.seller.userID || null) : null,
        sellerUsername: summary.seller ? (summary.seller.username || null) : null,
        sellerFeedbackPct: summary.seller ? Number(summary.seller.feedbackPercentage) : null,
        sellerFeedbackCount: summary.seller ? Number(summary.seller.feedbackScore) : null,

        /* Standardised coin condition detail - grade, and for slabbed
           coins the certification number identifying that exact coin. */
        conditionDescriptors: summary.conditionDescriptors || null
    }
}

/* Builds a Browse `filter` string from a plain object. */
exports.buildFilter = function (parts) {
    const segments = []
    for (const [key, value] of Object.entries(parts)) {
        if (value === undefined || value === null) { continue }
        segments.push(Array.isArray(value) ? key + ':{' + value.join('|') + '}' : key + ':' + value)
    }
    return segments.join(',')
}
