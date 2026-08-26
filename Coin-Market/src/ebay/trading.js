'use strict'

const XML = require('./xml.js')

/*
    Trading API client (legacy XML).

    This is the load-bearing piece. Since the Finding API was decommissioned
    in February 2025 and Marketplace Insights is closed to new developers,
    Trading GetItem is the only sanctioned route to a final sale price -
    and it works for just 90 days after a listing ends. Everything about the
    collector's cadence follows from that window.

    Site 3 is eBay UK.
*/

const SITE_ID_UK = 3
const COMPATIBILITY_LEVEL = 1193

exports.newTradingClient = function (auth, credentials, options) {

    const config = Object.assign({ siteId: SITE_ID_UK, budget: null }, options || {})

    async function call (callName, bodyXml, tokenKind) {
        const token = tokenKind === 'application'
            ? await auth.applicationToken()
            : await auth.userToken()

        const envelope =
            '<?xml version="1.0" encoding="utf-8"?>' +
            '<' + callName + 'Request xmlns="urn:ebay:apis:eBLBaseComponents">' +
            '<ErrorLanguage>en_GB</ErrorLanguage><WarningLevel>High</WarningLevel>' +
            bodyXml +
            '</' + callName + 'Request>'

        const response = await fetch(auth.endpoints.trading, {
            method: 'POST',
            headers: {
                'X-EBAY-API-CALL-NAME': callName,
                'X-EBAY-API-SITEID': String(config.siteId),
                'X-EBAY-API-COMPATIBILITY-LEVEL': String(COMPATIBILITY_LEVEL),
                'X-EBAY-API-IAF-TOKEN': token,
                'Content-Type': 'text/xml'
            },
            body: envelope
        })

        if (config.budget !== null) { config.budget.record('trading') }

        const text = await response.text()
        const parsed = XML.parse(text)
        const root = parsed[callName + 'Response'] || {}

        const ack = root.Ack
        if (ack === 'Failure') {
            const errors = Array.isArray(root.Errors) ? root.Errors : [root.Errors].filter(Boolean)
            const first = errors[0] || {}
            const error = new Error('Trading ' + callName + ' failed: ' +
                (first.LongMessage || first.ShortMessage || 'unknown'))
            error.code = String(first.ErrorCode || '')
            /* 17 = "Item not found". For an ended listing this most often
               means it fell out of the 90-day retention window. */
            if (error.code === '17' || error.code === '17470') { error.code = 'ITEM_GONE' }
            throw error
        }

        return root
    }

    return {
        /*
            Resolves what a listing actually sold for.

            Works on ended listings for 90 days after close. Note the
            asymmetry that shapes the scheduler: we can discover a lot only
            while it is live, but we can resolve it any time in the
            following three months - so resolution can be batched and
            retried, while discovery cannot be missed.
        */
        async getItem (legacyItemId) {
            const root = await call('GetItem',
                '<ItemID>' + XML.escape(legacyItemId) + '</ItemID>' +
                '<DetailLevel>ReturnAll</DetailLevel>' +
                '<IncludeItemSpecifics>true</IncludeItemSpecifics>',
                'user')
            return exports.parseItem(root)
        },

        /*
            Mirrors your eBay watch list, plus the bid/won/lost lists.

            WonList is the only source of ground truth in the whole system:
            a price you actually paid, not one inferred from a public field.
            DurationInDays is capped at 60 by eBay - shorter than GetItem's
            90-day window, which is why the watch list is a seed for
            tracking rather than a substitute for it.
        */
        async getMyeBayBuying (durationDays) {
            const days = Math.min(Math.max(1, durationDays || 60), 60)
            const listSpec = '<Include>true</Include><DurationInDays>' + days + '</DurationInDays>' +
                '<Pagination><EntriesPerPage>200</EntriesPerPage><PageNumber>1</PageNumber></Pagination>'

            const root = await call('GetMyeBayBuying',
                '<WatchList>' + listSpec + '</WatchList>' +
                '<BidList>' + listSpec + '</BidList>' +
                '<WonList>' + listSpec + '</WonList>' +
                '<LostList>' + listSpec + '</LostList>',
                'user')

            return {
                watching: exports.parseItemList(root.WatchList),
                bidding: exports.parseItemList(root.BidList),
                won: exports.parseItemList(root.WonList),
                lost: exports.parseItemList(root.LostList)
            }
        }
    }
}

function asArray (value) {
    if (value === undefined || value === null) { return [] }
    return Array.isArray(value) ? value : [value]
}

function num (value) {
    if (value === undefined || value === null) { return null }
    const parsed = Number(typeof value === 'object' ? value.__text : value)
    return Number.isFinite(parsed) ? parsed : null
}

exports.parseItemList = function (container) {
    if (container === undefined || container === null) { return [] }
    const holder = container.ItemArray || container.OrderTransactionArray || container
    return asArray(holder.Item || holder.Transaction).map(entry => {
        const item = entry.Item !== undefined ? entry.Item : entry
        return {
            legacyId: item.ItemID || null,
            title: item.Title || null,
            endTime: XML.get(item, 'ListingDetails.EndTime') || null,
            currentPrice: num(XML.get(item, 'SellingStatus.ConvertedCurrentPrice')) ||
                          num(XML.get(item, 'SellingStatus.CurrentPrice')),
            /* Present only on won items: what was actually paid. */
            transactionPrice: num(entry.ConvertedTransactionPrice) || num(entry.TransactionPrice),
            bidCount: num(XML.get(item, 'SellingStatus.BidCount')),
            listingStatus: XML.get(item, 'SellingStatus.ListingStatus') || null,
            listingType: item.ListingType || null
        }
    })
}

/*
    Turns a GetItem response into an outcome.

    `censored` is the important flag. eBay never publishes what an accepted
    Best Offer sold for: the listing simply ends showing its list price.
    Recording that as a sale at list price would bias every clearing
    estimate upward, and it is the single easiest way to build a tool that
    lies to you confidently. So it is marked, excluded from clearing
    statistics, and counted separately in the dashboard.
*/
exports.parseItem = function (root) {
    const item = root.Item || {}
    const selling = item.SellingStatus || {}
    const listingType = item.ListingType || null
    const listingStatus = selling.ListingStatus || null

    const quantitySold = num(selling.QuantitySold) || 0
    const bidCount = num(selling.BidCount)
    const price = num(selling.ConvertedCurrentPrice) || num(selling.CurrentPrice)

    const isAuction = listingType === 'Chinese' || listingType === 'Auction'
    const bestOfferEnabled = String(item.BestOfferDetails ? item.BestOfferDetails.BestOfferEnabled : '') === 'true'

    const sold = quantitySold > 0
    const censored = sold && !isAuction && bestOfferEnabled

    return {
        legacyId: item.ItemID || null,
        title: item.Title || null,
        endTime: XML.get(item, 'ListingDetails.EndTime') || null,
        startTime: XML.get(item, 'ListingDetails.StartTime') || null,
        listingType,
        listingStatus,
        sold,
        finalPrice: price,
        bidCount,
        quantitySold,
        censored,
        saleType: isAuction ? 'AUCTION' : (bestOfferEnabled ? 'BEST_OFFER' : 'FIXED_PRICE'),
        aspects: exports.parseAspects(item)
    }
}

exports.parseAspects = function (item) {
    const specifics = XML.get(item, 'ItemSpecifics.NameValueList')
    const aspects = {}
    for (const entry of asArray(specifics)) {
        if (entry === null || typeof entry !== 'object') { continue }
        const name = entry.Name
        const value = Array.isArray(entry.Value) ? entry.Value.join(', ') : entry.Value
        if (name !== undefined && value !== undefined) { aspects[name] = value }
    }
    return aspects
}

exports.SITE_ID_UK = SITE_ID_UK
