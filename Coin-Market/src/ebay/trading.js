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

        /*  Before the call, not after it.

            The check used to sit below the fetch, so an exhausted budget
            refused to PARSE a response it had already paid for - the request
            was on the wire before anything looked at the ledger, and a
            looping caller could still spend the whole day's Trading
            allowance one refused call at a time. It only stands between a
            caller and the allowance if it stands in front of the request.

            Counted here too, rather than on success: an attempt eBay never
            answers has still been charged by them, and this module's whole
            posture is to fail towards under-spending. */
        if (config.budget !== null) {
            if (typeof config.budget.allowsTrading === 'function' && !config.budget.allowsTrading(1)) {
                const err = new Error('Trading daily call budget exhausted')
                err.code = 'BUDGET_EXHAUSTED'
                throw err
            }
            config.budget.record('trading')
        }

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

    /*
        ListingType says how a lot COULD be bought, not how it was.

        'Chinese' is eBay's name for an auction, including one carrying a
        Buy-It-Now button, and this corpus holds 284 such dual-format lots
        plus 1,402 auctions with Best Offer enabled. On any of them a sale can
        happen without a single bid - somebody clicks Buy-It-Now, or the
        seller accepts an offer - and the listing still reports as an auction.

        Taken at face value that becomes a hammer price: filed in the AUCTION
        channel, marked exact because the censoring rule below requires
        !isAuction, and fed straight into fair value, the bid ceiling and the
        uplift curve. It would be the one contamination that reaches the
        number the whole tool is built on.

        A sale needs a bidder. So a lot that sold with a bid count of exactly
        zero did not clear at auction, whatever its listing type says, and
        does not belong in the auction channel. Which of the two ways it went
        is not always knowable, so it is treated like any other fixed-price
        sale: exact when no offers were allowed, a ceiling when they were.

        Checked against the live store before writing this: all 379 resolved
        auction sales carry at least one bid, so nothing is currently
        misfiled. This is a guard against a shape the corpus contains rather
        than a repair of damage already done - which is also why it is safe
        to apply to stored rows on the next resolve.

        Only a FINITE zero counts. A null bid count means eBay did not say,
        and inferring a Buy-It-Now purchase from silence would invent the
        very error this prevents.
    */
    const listedAsAuction = listingType === 'Chinese' || listingType === 'Auction'
    const bestOfferEnabled = String(item.BestOfferDetails ? item.BestOfferDetails.BestOfferEnabled : '') === 'true'

    const sold = quantitySold > 0
    const soldWithoutABid = sold && listedAsAuction && bidCount === 0
    const isAuction = listedAsAuction && !soldWithoutABid

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
        aspects: exports.parseAspects(item),
        conditionDescriptors: exports.parseConditionDescriptors(item)
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

/*
    Trading returns condition descriptors as ConditionDescriptor elements
    carrying a Name and one or more Value entries. Normalised into the
    same {name, values:[...]} shape the Browse reader produces, so the
    classifier has a single format to consume.
*/
exports.parseConditionDescriptors = function (item) {
    const raw = XML.get(item, 'ConditionDescriptors.ConditionDescriptor')
    const list = asArray(raw)
    const out = []
    for (const entry of list) {
        if (entry === null || typeof entry !== 'object') { continue }
        const name = entry.Name !== undefined ? entry.Name : entry.name
        const values = asArray(entry.Value !== undefined ? entry.Value : entry.value)
        if (name === undefined || values.length === 0) { continue }
        out.push({ name: String(name), values: values.map(v => (typeof v === 'object' ? v.__text : v)) })
    }
    return out.length > 0 ? out : null
}

exports.SITE_ID_UK = SITE_ID_UK
