'use strict'

const test = require('node:test')
const assert = require('node:assert')

const { newDatabase } = require('../src/store/db.js')
const { newRepository } = require('../src/store/repo.js')
const RESOLVE = require('../src/collect/resolve.js')
const TRADING = require('../src/ebay/trading.js')

/*
    Outcome resolution.

    Two things had never been exercised here. The fixed-price branch of
    parseItem had never executed at all, because pendingOutcomes could not
    offer a listing without an end time; and nothing checked what happens
    when eBay answers that a lot we assumed was over is in fact still on
    sale. The second is the whole safety of the first.
*/

const HOUR_MS = 60 * 60 * 1000

function store () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'salt' })
    const now = Date.now()

    /*  Something the most recent sweep saw, which is what sets the sweep
        clock that absence is measured against. */
    repository.saveListing({
        browseId: 'v1|fresh|0', legacyId: 'fresh', marketplace: 'EBAY_GB',
        title: 'Gold Sovereign 1912', buyingOptions: 'FIXED_PRICE', currency: 'GBP', endTime: null
    }, new Date(now).toISOString())

    /*  And a lot last seen five days before it: quiet enough to be offered
        up as probably ended. */
    const lastSeen = new Date(now - 120 * HOUR_MS).toISOString()
    repository.saveListing({
        browseId: 'v1|quiet|0', legacyId: 'quiet', marketplace: 'EBAY_GB',
        title: 'Gold Sovereign 1911', buyingOptions: 'FIXED_PRICE', currency: 'GBP', endTime: null
    }, lastSeen)
    repository.saveSnapshot('v1|quiet|0', { observedAt: lastSeen, price: 640, shipping: 0 })
    repository.saveClassification('v1|quiet|0', [{ key: 'GB.SOV.FULL', level: 1 }], 0.9, 'test', 0.2354, {})
    return { db, repository }
}

function clientReturning (item) {
    const asked = []
    return {
        asked,
        async getItem (legacyId) { asked.push(legacyId); return item }
    }
}

const outcomeOf = (db, browseId) =>
    db.prepare('SELECT * FROM listing_outcome WHERE browse_id = ?').get(browseId)

test('a lot eBay still calls Active is never recorded as an outcome', async () => {
    /*
        The quiet Buy-It-Now trigger is a guess: a lot can drop out of search
        results for three days and come back. Recording an outcome for one
        would be a fabrication in two directions at once - it would enter the
        clearing statistics as an unsold lot and disappear from the live
        market on the same write. Because of this check, being wrong costs
        one Trading call and nothing else, which is what makes the threshold
        safe to tune.
    */
    const { db, repository } = store()
    const client = clientReturning({
        listingStatus: 'Active', sold: false, finalPrice: 640,
        saleType: 'FIXED_PRICE', censored: false, endTime: null, aspects: {}
    })
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.deepStrictEqual(client.asked, ['quiet'], 'the quiet lot was never asked about')
    assert.strictEqual(report.stillLive, 1)
    assert.strictEqual(report.resolved, 0)
    assert.strictEqual(outcomeOf(db, 'v1|quiet|0'), undefined, 'a live listing was recorded as ended')
    db.close()
})

test('a lot found alive is not asked again the moment after being told', async () => {
    /*
        Being alive leaves no trace: no outcome is written, so the lot stays
        quiet and qualifies again immediately. The first live run showed what
        that costs - 28 of 38 calls spent re-asking lots eBay had already
        said were on sale, once every thirty minutes, indefinitely.

        The answer is recorded instead, and the lot goes back to the queue
        only after it has been quiet for another full stretch.
    */
    const { db, repository } = store()
    const client = clientReturning({
        listingStatus: 'Active', sold: false, saleType: 'FIXED_PRICE', aspects: {}
    })
    await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.deepStrictEqual(repository.pendingOutcomes(10).map(r => r.legacyId), [],
        'a lot eBay just said was on sale is queued to be asked about again')

    /*  But not lost. Once the liveness check is itself as stale as the
        absence threshold, the lot is a candidate once more - a Buy-It-Now
        alive today can be sold next week. */
    repository.markAliveNow('v1|quiet|0', new Date(Date.now() - 200 * HOUR_MS).toISOString())
    assert.deepStrictEqual(repository.pendingOutcomes(10).map(r => r.legacyId), ['quiet'],
        'a lot checked long ago never comes back to the queue')
    db.close()
})

test('an ended Buy-It-Now sale is finally recorded', async () => {
    /*  This branch of parseItem was complete, correct, and had never once
        run in production: every clearing price the tool knew came from an
        auction, on roughly half the market. */
    const { db, repository } = store()
    const endedAt = new Date(Date.now() - 12 * HOUR_MS).toISOString()
    const client = clientReturning({
        listingStatus: 'Completed', sold: true, finalPrice: 655.5, bidCount: null,
        saleType: 'FIXED_PRICE', censored: false, endTime: endedAt, aspects: {}
    })
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(report.resolved, 1)
    assert.strictEqual(report.stillLive, 0)
    const row = outcomeOf(db, 'v1|quiet|0')
    assert.strictEqual(row.sold, 1)
    assert.strictEqual(row.final_price, 655.5)
    assert.strictEqual(row.sale_type, 'FIXED_PRICE')
    assert.strictEqual(row.ended_at, endedAt,
        'eBay knows when it ended; we only know when we last looked')
    db.close()
})

test('a Best Offer sale is recorded but marked as not the price paid', async () => {
    /*  eBay does not publish what a Best Offer accepted for; the listing
        simply ends showing its list price. Taking that as the sale price is
        the easiest way to build a tool that lies to you confidently. */
    const { db, repository } = store()
    const client = clientReturning({
        listingStatus: 'Completed', sold: true, finalPrice: 700, saleType: 'BEST_OFFER',
        censored: true, endTime: new Date().toISOString(), aspects: {}
    })
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(report.censored, 1)
    assert.strictEqual(outcomeOf(db, 'v1|quiet|0').censored, 1)
    db.close()
})

test('an exhausted Trading budget stops the queue rather than burning it', async () => {
    /*  The queue is ordered by deadline, so what is left is exactly what
        should be tried first next cycle. Walking the rest of it to collect
        the same refusal sixty times only buries the reason in the journal. */
    const { db, repository } = store()
    let asked = 0
    const client = {
        async getItem () {
            asked++
            const err = new Error('Trading daily call budget exhausted')
            err.code = 'BUDGET_EXHAUSTED'
            throw err
        }
    }
    for (const id of ['a', 'b', 'c']) {
        repository.saveListing({
            browseId: 'v1|' + id + '|0', legacyId: id, marketplace: 'EBAY_GB',
            title: 'Gold Sovereign', buyingOptions: 'AUCTION', currency: 'GBP',
            endTime: new Date(Date.now() - 3 * HOUR_MS).toISOString()
        })
    }
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(asked, 1, 'it kept asking after being told the budget was gone')
    assert.strictEqual(report.budgetStopped, true)
    assert.strictEqual(report.failed, 0, 'a budget stop was reported as a failure')
    db.close()
})

/*
    The gate has to stand in front of the request.

    It used to sit below the fetch, so an exhausted budget refused to parse a
    response that had already been paid for - the request was on the wire
    before anything consulted the ledger, and a looping caller could still
    spend the whole day's allowance one refused call at a time.
*/
test('an exhausted budget is refused before the request is made', async () => {
    const calls = []
    const realFetch = globalThis.fetch
    globalThis.fetch = async (...args) => {
        calls.push(args)
        throw new Error('should never be reached')
    }
    try {
        const client = TRADING.newTradingClient(
            { endpoints: { trading: 'https://api.ebay.test/ws' }, userToken: async () => 't' },
            {},
            {
                budget: {
                    allowsTrading: () => false,
                    record () { assert.fail('recorded a call it had refused') }
                }
            })

        await assert.rejects(client.getItem('123'), err => err.code === 'BUDGET_EXHAUSTED')
        assert.strictEqual(calls.length, 0, 'the refused call still went out over the network')
    } finally {
        globalThis.fetch = realFetch
    }
})


/*
    A sale with no bidder is not a hammer price.

    eBay's ListingType says how a lot COULD be bought. 'Chinese' means auction
    - including one carrying a Buy-It-Now button - and this corpus holds 284
    dual-format lots and 1,402 auctions with Best Offer enabled. On any of
    them somebody can click Buy-It-Now, or the seller can accept an offer, and
    the listing still reports itself as an auction with zero bids.

    Taken at face value that becomes a hammer price: filed under AUCTION,
    marked exact, and fed into fair value, the bid ceiling and the uplift
    curve - the numbers the whole tool rests on. Measured before the fix: all
    379 resolved auction sales carried at least one bid, so nothing was
    misfiled yet. This guards a shape the corpus contains.
*/
const auctionItem = (over) => Object.assign({
    listingStatus: 'Completed', sold: true, finalPrice: 900,
    endTime: new Date().toISOString(), aspects: {}
}, over)

test('a lot that sold with zero bids never enters the auction channel', () => {
    /*  Straight at the parser, because this is where the sale type is
        decided and every consumer downstream trusts it. */
    const parsed = TRADING.parseItem({
        Item: {
            ItemID: '1', ListingType: 'Chinese',
            SellingStatus: { QuantitySold: '1', BidCount: '0', CurrentPrice: '900',
                ListingStatus: 'Completed' },
            BestOfferDetails: { BestOfferEnabled: 'false' }
        }
    })
    assert.strictEqual(parsed.sold, true)
    assert.notStrictEqual(parsed.saleType, 'AUCTION',
        'a sale with no bidder was recorded as a hammer price')
    assert.strictEqual(parsed.saleType, 'FIXED_PRICE')
    assert.strictEqual(parsed.censored, false,
        'a plain Buy-It-Now purchase has an exact price')
})

test('a zero-bid sale on an offers-enabled auction is a ceiling, not a hammer price', () => {
    const parsed = TRADING.parseItem({
        Item: {
            ItemID: '2', ListingType: 'Chinese',
            SellingStatus: { QuantitySold: '1', BidCount: '0', CurrentPrice: '900',
                ListingStatus: 'Completed' },
            BestOfferDetails: { BestOfferEnabled: 'true' }
        }
    })
    assert.notStrictEqual(parsed.saleType, 'AUCTION')
    assert.strictEqual(parsed.censored, true,
        'an accepted offer on an auction listing was priced at the ask')
})

test('a genuine auction with bids is untouched', () => {
    const parsed = TRADING.parseItem({
        Item: {
            ItemID: '3', ListingType: 'Chinese',
            SellingStatus: { QuantitySold: '1', BidCount: '7', CurrentPrice: '900',
                ListingStatus: 'Completed' },
            BestOfferDetails: { BestOfferEnabled: 'false' }
        }
    })
    assert.strictEqual(parsed.saleType, 'AUCTION')
    assert.strictEqual(parsed.censored, false)
    assert.strictEqual(parsed.bidCount, 7)
})

test('an auction that did not sell keeps its type, bids or none', () => {
    /*  Zero bids and no sale is just an auction nobody wanted. Rerouting it
        would corrupt the unsold side of every sell-through figure. */
    const parsed = TRADING.parseItem({
        Item: {
            ItemID: '4', ListingType: 'Chinese',
            SellingStatus: { QuantitySold: '0', BidCount: '0', CurrentPrice: '900',
                ListingStatus: 'Completed' },
            BestOfferDetails: { BestOfferEnabled: 'false' }
        }
    })
    assert.strictEqual(parsed.sold, false)
    assert.strictEqual(parsed.saleType, 'AUCTION',
        'an unsold auction was reclassified as a fixed-price lot')
})

test('a missing bid count is not read as zero', () => {
    /*  eBay declining to say is not eBay saying none. Inferring a Buy-It-Now
        purchase from silence would invent the error this guard prevents. */
    const parsed = TRADING.parseItem({
        Item: {
            ItemID: '5', ListingType: 'Chinese',
            SellingStatus: { QuantitySold: '1', CurrentPrice: '900', ListingStatus: 'Completed' },
            BestOfferDetails: { BestOfferEnabled: 'false' }
        }
    })
    assert.strictEqual(parsed.saleType, 'AUCTION',
        'a null bid count was treated as proof of no bidding')
})


/*
    Telling a Buy-It-Now sale at the asking price apart from an accepted offer.

    eBay marks the difference on its own sold page with a strikethrough and
    puts it nowhere in GetItem - a full 114-field diff across three lots of
    known outcome found only per-listing noise, and BestOfferCount was 4 on
    one that sold AT the ask against 1 on one that did not.

    GetBestOffers carries it. The three lots, measured live:
      227494211240  4 offers, all Declined   -> sold at the ask
      800603093457  1 offer,  Accepted       -> accepted offer
      188865614674  2 offers, both Declined  -> sold at the ask

    Every test below is about the guard rather than the happy path, because
    the cost of the two errors is wildly asymmetric. Failing to un-censor a
    lot loses one data point. Un-censoring one wrongly prints a confident
    price for a coin that never sold for it - the exact failure the whole
    censoring apparatus exists to prevent.
*/
const soldBin = (over) => Object.assign({
    sold: true, listingType: 'FixedPriceItem', quantitySold: 1,
    bestOfferEnabled: true, bestOfferCount: 0, censored: true
}, over)

const offers = (...statuses) => ({ available: true, offers: statuses.map(status => ({ status })) })

test('a lot whose every offer was declined sold at the asking price', () => {
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ bestOfferCount: 4 }),
            offers('Declined', 'Declined', 'Declined', 'Declined')),
        true)
})

test('one accepted offer among many settles it, whatever the others say', () => {
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ bestOfferCount: 3 }),
            offers('Declined', 'Accepted', 'Expired')),
        false)
    /*  Seller-initiated offers arrive under a different code type and the
        same status, so the status is what is read. */
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ bestOfferCount: 1 }), offers('SellerAccept')),
        false)
})

test('a listing eBay agrees received no offers sold at the asking price', () => {
    assert.strictEqual(TRADING.soldAtAsk(soldBin({ bestOfferCount: 0 }), offers()), true)
})

test('no records but a count above zero is a missing answer, not a clean one', () => {
    /*  THE failure mode. If offer records aged out, an accepted-offer lot
        would come back empty and this would print the asking price as a real
        sale. The count is the oracle that catches it. */
    assert.strictEqual(TRADING.soldAtAsk(soldBin({ bestOfferCount: 2 }), offers()), null)
})

test('fewer records than eBay counted means some are missing', () => {
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ bestOfferCount: 5 }), offers('Declined', 'Declined')),
        null,
        'a partial record set was read as proof that nothing was accepted')
})

test('more records than eBay counted is fine, and happens', () => {
    /*  Counter-offers and expired ones the count omits. Measured: 43 of 45
        lots reconciled and both disagreements were in this direction. */
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ bestOfferCount: 3 }),
            offers('Declined', 'Declined', 'Countered', 'Expired')),
        true)
})

test('a failed call never becomes an answer', () => {
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ bestOfferCount: 2 }),
            { available: false, reason: 'timeout', offers: [] }),
        null)

    /*  The dangerous shape, and the one the count check cannot cover: the
        call failed on a lot eBay counted zero offers for. An empty record
        set from a call that never happened looks exactly like an empty
        record set from a lot nobody bid on, and only the availability flag
        separates them. Reading the first as the second would print the
        asking price as a real sale on every lot that timed out. */
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ bestOfferCount: 0 }),
            { available: false, reason: 'timeout', offers: [] }),
        null,
        'a call that never completed was read as proof of no offers')
})

test('auctions are out of scope, because their offer records under-report', () => {
    /*  Three auctions checked live: counts of 3, 6 and 2 against 0, 0 and 1
        records returned. Every fixed-price lot reconciled. */
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ listingType: 'Chinese', bestOfferCount: 3 }),
            offers('Declined', 'Declined', 'Declined')),
        null)
})

test('a multi-unit listing gets no single verdict', () => {
    /*  An accepted offer and sales at the ask coexist on one listing; ten of
        forty-five lots in the store carry quantity above one. */
    assert.strictEqual(
        TRADING.soldAtAsk(soldBin({ quantitySold: 3, bestOfferCount: 1 }), offers('Declined')),
        null)
})

test('an unsold lot is not asked about at all', () => {
    assert.strictEqual(TRADING.soldAtAsk(soldBin({ sold: false }), offers()), null)
})

/* ------------------------------------------- and through the resolver */

test('a Buy-It-Now that sold at the ask is stored with an exact price', async () => {
    const { db, repository } = store()
    const item = {
        listingStatus: 'Completed', sold: true, finalPrice: 655.5, bidCount: null,
        saleType: 'BEST_OFFER', censored: true, listingType: 'FixedPriceItem',
        quantitySold: 1, bestOfferEnabled: true, bestOfferCount: 2,
        endTime: new Date().toISOString(), aspects: {}
    }
    const client = {
        asked: [],
        async getItem () { return item },
        async getBestOffers (id) {
            this.asked.push(id)
            return { available: true, offers: [{ status: 'Declined' }, { status: 'Declined' }] }
        }
    }
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.deepStrictEqual(client.asked, ['quiet'], 'the offer question was never asked')
    assert.strictEqual(report.pricedByOffers, 1)
    assert.strictEqual(outcomeOf(db, 'v1|quiet|0').censored, 0,
        'a lot that sold at its asking price is still marked price-unknown')
    db.close()
})

test('an accepted offer keeps its ceiling', async () => {
    const { db, repository } = store()
    const client = {
        async getItem () {
            return {
                listingStatus: 'Completed', sold: true, finalPrice: 925, bidCount: null,
                saleType: 'BEST_OFFER', censored: true, listingType: 'FixedPriceItem',
                quantitySold: 1, bestOfferEnabled: true, bestOfferCount: 1,
                endTime: new Date().toISOString(), aspects: {}
            }
        },
        async getBestOffers () { return { available: true, offers: [{ status: 'Accepted' }] } }
    }
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(report.acceptedOffer, 1)
    assert.strictEqual(report.pricedByOffers, 0)
    assert.strictEqual(outcomeOf(db, 'v1|quiet|0').censored, 1,
        'the asking price was recorded as what somebody paid')
    db.close()
})

test('a failing offer call leaves the outcome exactly as it was', async () => {
    /*  The call is a chance to remove a censor mark, never a dependency. */
    const { db, repository } = store()
    const client = {
        async getItem () {
            return {
                listingStatus: 'Completed', sold: true, finalPrice: 700, bidCount: null,
                saleType: 'BEST_OFFER', censored: true, listingType: 'FixedPriceItem',
                quantitySold: 1, bestOfferEnabled: true, bestOfferCount: 1,
                endTime: new Date().toISOString(), aspects: {}
            }
        },
        async getBestOffers () { throw new Error('Trading daily call budget exhausted') }
    }
    const report = await RESOLVE.newResolver(client, repository).resolvePending(10)

    assert.strictEqual(report.resolved, 1, 'a failed offer call lost the whole outcome')
    assert.strictEqual(report.offerUnknown, 1)
    assert.strictEqual(outcomeOf(db, 'v1|quiet|0').censored, 1)
    db.close()
})

test('a plain Buy-It-Now is never asked about - it was already exact', async () => {
    const { db, repository } = store()
    let asked = 0
    const client = {
        async getItem () {
            return {
                listingStatus: 'Completed', sold: true, finalPrice: 655, bidCount: null,
                saleType: 'FIXED_PRICE', censored: false, listingType: 'FixedPriceItem',
                quantitySold: 1, bestOfferEnabled: false, bestOfferCount: 0,
                endTime: new Date().toISOString(), aspects: {}
            }
        },
        async getBestOffers () { asked++; return { available: true, offers: [] } }
    }
    await RESOLVE.newResolver(client, repository).resolvePending(10)
    assert.strictEqual(asked, 0, 'a Trading call was spent on a lot that needed no answer')
    db.close()
})

test('only the offer status is kept, never who made it', () => {
    /*  Responses carry an anonymised buyer id, feedback score and
        registration date. Storing any of it would widen this account's
        obligations under eBay's account-deletion notice for no analytical
        gain. */
    const parsed = TRADING.parseBestOffers({
        BestOffer: [{
            BestOfferID: '123', Status: 'Declined', BestOfferCodeType: 'BuyerBestOffer',
            Price: '850.00',
            Buyer: { UserID: 'a***b', FeedbackScore: '401', RegistrationDate: '2011-04-02T00:00:00Z' }
        }]
    })
    assert.deepStrictEqual(parsed, [{ status: 'Declined', codeType: 'BuyerBestOffer' }])
    const flat = JSON.stringify(parsed)
    for (const leaked of ['a***b', '401', '2011', '850']) {
        assert.ok(!flat.includes(leaked), 'buyer or price detail was carried through: ' + leaked)
    }
})

test('a single offer object, not an array, still parses', () => {
    /*  eBay's XML collapses a one-element list to a bare object. */
    assert.deepStrictEqual(
        TRADING.parseBestOffers({ BestOffer: { Status: 'Accepted' } }),
        [{ status: 'Accepted', codeType: null }])
    assert.deepStrictEqual(TRADING.parseBestOffers({}), [])
    assert.deepStrictEqual(TRADING.parseBestOffers(null), [])
})


/* ------------------------------------------------ the one-off backfill */

/*
    The lots the offer question arrived too late for.

    Every Buy-It-Now sale resolved before GetBestOffers existed was stamped
    price-unknown on the strength of the offer button being left on. A lot
    that already has an outcome is never offered to the resolver again, so
    they cannot pick the answer up in passing - they have to be asked once,
    after the fact.
*/
function resolvedStore () {
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'salt' })
    const now = new Date().toISOString()
    const add = (id, saleType, censored, sold) => {
        repository.saveListing({
            browseId: 'v1|' + id + '|0', legacyId: id, marketplace: 'EBAY_GB',
            title: 'Gold Sovereign ' + id, buyingOptions: 'FIXED_PRICE|BEST_OFFER',
            currency: 'GBP', endTime: null
        }, now)
        repository.saveOutcome('v1|' + id + '|0', {
            endTime: now, sold, finalPrice: 700, saleType, censored, source: 'trading_getitem'
        })
    }
    add('offers-sold', 'BEST_OFFER', true, true)
    add('offers-unsold', 'BEST_OFFER', true, false)
    add('plain-sold', 'FIXED_PRICE', false, true)
    add('auction-sold', 'AUCTION', false, true)
    /*  A censored AUCTION, which is a real shape: fromLastSnapshot writes
        one whenever the 90-day window closed before we could ask. It must
        stay out of the backfill - offer records under-report on auctions,
        which is the one place this mechanism is known to be unreliable. */
    add('auction-censored', 'AUCTION', true, true)
    return { db, repository }
}

test('the backfill offers up exactly the sales whose price was written off', () => {
    const { db, repository } = resolvedStore()
    assert.deepStrictEqual(
        repository.censoredOffersToRecheck(50).map(r => r.legacyId),
        ['offers-sold'],
        'the backfill would spend calls on lots it cannot help')
    db.close()
})

test('un-censoring only ever clears the mark, never sets it', () => {
    /*  A backfill that could censor would be able to make the store less
        honest than it found it. This one is deliberately one-way. */
    const { db, repository } = resolvedStore()
    repository.uncensorOutcome('v1|offers-sold|0')
    assert.strictEqual(outcomeOf(db, 'v1|offers-sold|0').censored, 0)

    /*  And it is a no-op on a row that was already exact. */
    const before = outcomeOf(db, 'v1|plain-sold|0').censored
    repository.uncensorOutcome('v1|plain-sold|0')
    assert.strictEqual(outcomeOf(db, 'v1|plain-sold|0').censored, before)
    db.close()
})

test('a lot the backfill has priced is not offered up a second time', () => {
    const { db, repository } = resolvedStore()
    repository.uncensorOutcome('v1|offers-sold|0')
    assert.deepStrictEqual(repository.censoredOffersToRecheck(50).map(r => r.legacyId), [])
    db.close()
})
