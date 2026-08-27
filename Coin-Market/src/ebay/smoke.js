'use strict'

const AUTH = require('./auth.js')
const BROWSE = require('./browse.js')
const TRADING = require('./trading.js')
const TAXONOMY = require('./taxonomy.js')
const CONDITIONS = require('../catalogue/conditions.js')

/*
    End-to-end probe against a real eBay environment.

    Reports one of four verdicts per capability, and the distinction
    between the last two is the point of the whole exercise:

      PASS     the capability works
      FAIL     it is broken, and something downstream depends on it
      UNKNOWN  the environment cannot answer - sandbox has no real coin
               listings, so a silent "no data" here says nothing about
               production
      SKIP     not attempted (needs a credential that is not configured)

    A green sandbox run proves the CLIENT is correctly built. It proves
    nothing about the coin market. Conflating those would be the easiest
    way to talk ourselves into trusting assumptions that were never tested.

    Also captures response SHAPES - field names actually present on
    ItemSummary and inside conditionDescriptors - because those were
    documented ambiguously and the readers were written tolerantly as a
    result. Nothing captured includes credentials.
*/

const PASS = 'PASS'
const FAIL = 'FAIL'
const UNKNOWN = 'UNKNOWN'
const SKIP = 'SKIP'

exports.run = async function (settings, options) {

    const config = Object.assign({ probeItemId: null }, options || {})
    const environment = settings.ebay.environment || 'production'
    const marketplaceId = settings.ebay.marketplaceId || 'EBAY_GB'

    const auth = AUTH.newAuth(settings.ebay, { environment })
    const results = []
    const shapes = {}

    const record = (name, status, detail, note) =>
        results.push({ name, status, detail, note: note || null })

    async function probe (name, needs, fn) {
        if (needs === 'user' && !settings.ebay.refreshToken) {
            record(name, SKIP, 'no user token configured (run "coin-market auth-url")')
            return null
        }
        try {
            const outcome = await fn()
            record(name, outcome.status, outcome.detail, outcome.note)
            return outcome.value === undefined ? null : outcome.value
        } catch (err) {
            record(name, FAIL, err.message)
            return null
        }
    }

    /* ---------------------------------------------------------- auth */

    await probe('Application token (client credentials)', 'app', async () => {
        const token = await auth.applicationToken()
        return { status: PASS, detail: 'obtained (' + token.length + ' chars)' }
    })

    const browse = BROWSE.newBrowseClient(auth, { marketplaceId })

    /* -------------------------------------------------------- browse */

    const auctionItems = await probe('Browse search returns AUCTION listings', 'app', async () => {
        const payload = await browse.search({
            q: 'gold sovereign',
            filter: BROWSE.buildFilter({ buyingOptions: ['AUCTION'] }),
            limit: 50
        })
        const items = payload.itemSummaries || []
        if (items.length === 0) {
            return {
                status: environment === 'sandbox' ? UNKNOWN : FAIL,
                detail: '0 auctions returned',
                note: environment === 'sandbox'
                    ? 'sandbox has no real coin listings - says nothing about production'
                    : 'production returning no sovereign auctions would be a real problem'
            }
        }
        return { status: PASS, detail: items.length + ' auctions returned', value: items }
    })

    /*
        The cheap-snapshot design depends on search results carrying live
        auction state. If they do not, snapshotting costs one call per
        listing instead of one per 200, and the budget must be replanned.
    */
    await probe('ItemSummary carries bidCount / currentBidPrice', 'app', async () => {
        if (auctionItems === null || auctionItems.length === 0) {
            return { status: UNKNOWN, detail: 'no auctions to inspect' }
        }
        const withBid = auctionItems.filter(i => i.bidCount !== undefined).length
        const withPrice = auctionItems.filter(i => i.currentBidPrice !== undefined).length
        shapes.itemSummaryFields = Array.from(
            new Set(auctionItems.flatMap(i => Object.keys(i)))).sort()

        if (withBid === 0) {
            return {
                status: FAIL,
                detail: '0/' + auctionItems.length + ' carry bidCount',
                note: 'snapshotting would cost ~200x more - the call budget needs replanning'
            }
        }
        return {
            status: PASS,
            detail: withBid + '/' + auctionItems.length + ' carry bidCount, ' +
                withPrice + ' carry currentBidPrice'
        }
    })

    await probe('Browse rejects a search missing buyingOptions', 'app', async () => {
        /* Our own guard, not eBay's - verifying it still fires, because
           without it we would silently collect a BIN-only dataset. */
        try {
            await browse.searchAll({ q: 'gold sovereign', filter: 'price:[100..900]' })
            return { status: FAIL, detail: 'guard did NOT fire - BIN-only bias is possible' }
        } catch (err) {
            return /buyingOptions/.test(err.message)
                ? { status: PASS, detail: 'guard fired as designed' }
                : { status: FAIL, detail: 'unexpected error: ' + err.message }
        }
    })

    /* --------------------------------------------- condition descriptors */

    await probe('Coin condition descriptors present', 'app', async () => {
        const payload = await browse.search({
            q: 'gold sovereign',
            filter: BROWSE.buildFilter({ buyingOptions: ['AUCTION', 'FIXED_PRICE'] }),
            limit: 50
        })
        const items = payload.itemSummaries || []
        const withDescriptors = items.filter(
            i => Array.isArray(i.conditionDescriptors) && i.conditionDescriptors.length > 0)

        if (items.length === 0) {
            return { status: UNKNOWN, detail: 'no listings returned to inspect' }
        }
        if (withDescriptors.length === 0) {
            return {
                status: UNKNOWN,
                detail: '0/' + items.length + ' listings carry conditionDescriptors',
                note: 'either not yet live on ' + marketplaceId +
                      ', or absent from search results and only on getItem'
            }
        }

        /* Capture the real shape - the reader was written tolerantly
           precisely because this was undocumented. */
        shapes.conditionDescriptors = withDescriptors[0].conditionDescriptors
        const parsed = CONDITIONS.parseDescriptors(shapes.conditionDescriptors)
        shapes.conditionDescriptorsParsed = parsed

        const names = new Set()
        for (const item of withDescriptors) {
            for (const d of item.conditionDescriptors) { if (d && d.name) { names.add(d.name) } }
        }
        return {
            status: Object.keys(parsed).length > 0 ? PASS : FAIL,
            detail: withDescriptors.length + '/' + items.length + ' carry descriptors; fields: ' +
                Array.from(names).join(', '),
            note: Object.keys(parsed).length === 0
                ? 'descriptors present but our reader extracted nothing - shape differs from expectation'
                : 'reader extracted: ' + Object.keys(parsed).join(', ')
        }
    })

    /* ------------------------------------------------------ taxonomy */

    const taxonomy = TAXONOMY.newTaxonomyClient(auth)

    const treeId = await probe('Category tree id for ' + marketplaceId, 'app', async () => {
        const id = await taxonomy.defaultCategoryTreeId(marketplaceId)
        return { status: PASS, detail: 'categoryTreeId = ' + id, value: id }
    })

    await probe('Coin category leaves for ' + marketplaceId, 'app', async () => {
        if (treeId === null) { return { status: SKIP, detail: 'no tree id' } }
        const subtree = await taxonomy.categorySubtree(treeId, TAXONOMY.COINS_ROOT)
        const flat = TAXONOMY.flattenSubtree(subtree)
        const leaves = TAXONOMY.matchingLeaves(flat, TAXONOMY.SOVEREIGN_PATTERNS)

        shapes.categoryTreeId = treeId
        shapes.sovereignLeaves = leaves.map(l => ({ id: l.categoryId, path: l.path }))

        if (leaves.length === 0) {
            return { status: FAIL, detail: flat.length + ' categories, none matching sovereign patterns' }
        }
        return {
            status: PASS,
            detail: leaves.length + ' matching leaves of ' + flat.length + ' categories',
            note: leaves.slice(0, 6).map(l => l.categoryId + ' ' + l.path).join(' | ')
        }
    })

    /* ------------------------------------------------------ trading */

    /*
        The load-bearing one. Everything about outcome resolution - and
        therefore every clearing premium the tool reports - rests on
        GetItem working for listings the caller does not own.
    */
    await probe('Trading GetItem on a listing you do not own', 'user', async () => {
        if (config.probeItemId === null) {
            return {
                status: SKIP,
                detail: 'pass an ended eBay item number: coin-market smoke <itemId>'
            }
        }
        const trading = TRADING.newTradingClient(auth, settings.ebay, { siteId: settings.ebay.siteId })
        const item = await trading.getItem(config.probeItemId)
        shapes.tradingItem = {
            listingType: item.listingType, listingStatus: item.listingStatus,
            sold: item.sold, finalPrice: item.finalPrice, bidCount: item.bidCount,
            saleType: item.saleType, censored: item.censored,
            aspectKeys: Object.keys(item.aspects || {}),
            conditionDescriptors: item.conditionDescriptors
        }
        if (item.finalPrice === null || item.finalPrice === undefined) {
            return {
                status: FAIL,
                detail: 'resolved but no final price',
                note: 'outcome resolution would fall back to last-snapshot-before-close'
            }
        }
        return {
            status: PASS,
            detail: 'sold=' + item.sold + ' final=' + item.finalPrice +
                ' bids=' + item.bidCount + ' type=' + item.saleType
        }
    })

    await probe('Watch list mirror (GetMyeBayBuying)', 'user', async () => {
        const trading = TRADING.newTradingClient(auth, settings.ebay, { siteId: settings.ebay.siteId })
        const lists = await trading.getMyeBayBuying(30)
        return {
            status: PASS,
            detail: 'watching ' + lists.watching.length + ', bidding ' + lists.bidding.length +
                ', won ' + lists.won.length + ', lost ' + lists.lost.length
        }
    })

    /* ------------------------------------------------------ quotas */

    await probe('Real call quotas (Analytics getRateLimits)', 'app', async () => {
        const token = await auth.applicationToken()
        const response = await fetch(auth.endpoints.analytics + '/rate_limit/', {
            headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
        })
        if (!response.ok) {
            return { status: UNKNOWN, detail: 'HTTP ' + response.status + ' - quota unreadable' }
        }
        const payload = await response.json()
        const browseLimit = (payload.rateLimits || [])
            .flatMap(api => (api.resources || []).map(r => ({ api: api.apiName, resource: r.name, rates: r.rates })))
            .find(entry => /browse/i.test(entry.api || ''))

        shapes.rateLimits = browseLimit || (payload.rateLimits || [])[0] || null

        if (browseLimit === undefined) {
            return { status: UNKNOWN, detail: 'no Browse entry in the quota response' }
        }
        const rate = (browseLimit.rates || [])[0] || {}
        return {
            status: PASS,
            detail: 'Browse limit ' + rate.limit + ', remaining ' + rate.remaining +
                ', window ' + rate.timeWindow + 's'
        }
    })

    return { environment, marketplaceId, results, shapes }
}

exports.format = function (report) {
    const lines = []
    const counts = { PASS: 0, FAIL: 0, UNKNOWN: 0, SKIP: 0 }

    lines.push('')
    lines.push('COIN MARKET SMOKE TEST  -  ' + report.environment + ' / ' + report.marketplaceId)
    lines.push('')

    for (const result of report.results) {
        counts[result.status] = (counts[result.status] || 0) + 1
        lines.push('  ' + result.status.padEnd(8) + result.name)
        lines.push('           ' + result.detail)
        if (result.note !== null) { lines.push('           note: ' + result.note) }
    }

    lines.push('')
    lines.push('  ' + Object.entries(counts).map(([k, v]) => v + ' ' + k.toLowerCase()).join(', '))
    lines.push('')

    if (report.environment === 'sandbox') {
        lines.push('  Sandbox proves the client is correctly built. It has no real coin')
        lines.push('  listings, so every UNKNOWN above stays unanswered until production.')
        lines.push('')
    }
    return lines.join('\n')
}
