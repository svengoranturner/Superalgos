'use strict'

const test = require('node:test')
const assert = require('node:assert')

const CLASSIFY = require('../src/catalogue/classify.js')
const INSTRUMENTS = require('../src/catalogue/instruments.js')
const SERIES = require('../src/catalogue/series/index.js')
const MORGAN = require('../src/catalogue/coins.morgan.js')

/*
    Morgan and Peace dollars: the second series.

    Every title in this file is a REAL eBay listing, pulled from a live
    search rather than invented, because an invented corpus tests the
    imagination of whoever wrote it. Three of the defects fixed while
    building this pack were found by real titles and would not have occurred
    to anyone: a 2021 centenary strike filing itself alongside genuine
    Carson City dollars, sealed bulk bags filing as single coins, and a
    variety name - "Reverse of 78" - reading as a lot of 78 coins.
*/

function classify (title) {
    return CLASSIFY.classify({ title }, { series: 'US.MORGAN' })
}

function keyFor (title) {
    const r = classify(title)
    if (r.excluded) { return 'EXCLUDED ' + r.excluded.code }
    const keys = r.attributes ? INSTRUMENTS.keysFor(r.attributes) : []
    return keys.length ? keys[0].key : 'NO KEY'
}

test('real listings land in the pool their coin actually trades in', () => {
    const cases = [
        ['1882-CC Morgan Silver Dollar Carson City', 'US.MORGAN.KEY_DATE.DOLLAR'],
        ['1886 Morgan Silver Dollar Philadelphia Mint Nice Toning On Reverse', 'US.MORGAN.COMMON.DOLLAR'],
        ['1885 O Morgan Silver Dollar CACG MS64 High Grade Lustrous Coin', 'US.MORGAN.GRADED.DOLLAR'],
        /*  57% of real listings never state a mint. Filing those as
            Philadelphia would be guessing on half the corpus, and an
            unmarked 1889 that is really an 1889-CC is not a rounding error. */
        ['1880 morgan US 90% silver Dollar', 'US.MORGAN.UNATTRIBUTED.DOLLAR']
    ]
    for (const [title, expected] of cases) {
        assert.strictEqual(keyFor(title), expected, title)
    }
})

/*  The US Mint restruck both designs from 2021. They are .999 fine against
    the classic .900 - 0.858 oz of silver rather than 0.7734 - so pricing one
    as a classic dollar is a 10% error before anything else goes wrong. */
test('a modern restrike is not a classic dollar, and its CC is not a mint', () => {
    const title = 'NGC MS 70 2021-CC Morgan .999 Silver Dollar Centenary (Carson City Mint Mark)'
    assert.strictEqual(keyFor(title), 'EXCLUDED MODERN_TRIBUTE')

    /*  Belt and braces: even with the exclusion lifted, a CC mark outside
        Carson City's operating years must not reach the key-date pool,
        where it would sit beside genuine 1889-CCs and move their median. */
    assert.strictEqual(MORGAN.poolFor({ portrait: 'MORGAN', year: null, mint: 'CC' }), 'UNATTRIBUTED')
    assert.strictEqual(MORGAN.poolFor({ portrait: 'MORGAN', year: 2021, mint: 'CC' }), 'COMMON')
    assert.strictEqual(MORGAN.poolFor({ portrait: 'MORGAN', year: 1882, mint: 'CC' }), 'KEY_DATE')
})

test('a bulk lot is not a coin, but a variety name is not a bulk lot', () => {
    for (const title of [
        '5 Morgan Silver Dollars — Mixed Dates — US Silver Coins',
        'Collection Of 80 USA Silver Dollars 66 Morgan & 14 Peace',
        'Unopened Sealed Bag of Morgan, Flowing Hair, Peace, Seated Liberty Silver'
    ]) {
        assert.strictEqual(keyFor(title), 'EXCLUDED MULTI_DOLLAR_LOT', title)
    }
    /*  The one that got away: "Reverse of 78" is a die variety, not 78
        coins. A lot says dollarS. */
    assert.notStrictEqual(
        keyFor('1878-P 7TF Reverse of 78 Morgan Silver Dollar (Philadelphia)'),
        'EXCLUDED MULTI_DOLLAR_LOT')
})

/*  The dispatch rule that keeps two series apart. A pack is never told about
    another pack; the registry decides, and refuses to decide when two of
    them claim the same title. */
test('a title belongs to the series that recognises it, or to nobody', () => {
    assert.strictEqual(SERIES.recognise('1889 CC Morgan Silver Dollar').pack.id, 'US.MORGAN')
    assert.strictEqual(SERIES.recognise('1921 Peace Dollar').pack.id, 'US.MORGAN')
    assert.strictEqual(SERIES.recognise('1968 UK FULL GOLD SOVEREIGN COIN').pack.id, 'GB.SOV')

    /*  "Morgan" is a surname and "peace" an ordinary word; neither claims a
        title on its own. */
    assert.strictEqual(SERIES.recognise('Morgan Freeman signed photo').pack, null)
    assert.strictEqual(SERIES.recognise('Royal Doulton teacup').pack, null)

    /*  Two strong claims go to review NAMING BOTH, never to a coin flip - a
        Britannia priced as a sovereign is invisible until somebody notices
        the premium looks odd. */
    const both = SERIES.recognise('Gold Sovereign and Morgan Dollar collection')
    assert.strictEqual(both.pack, null)
    assert.deepStrictEqual(both.candidates.slice().sort(), ['GB.SOV', 'US.MORGAN'])
    assert.match(both.reasons[0], /which is it/)
})

test('a silver dollar is priced against silver, and a sovereign against gold', () => {
    assert.strictEqual(SERIES.metalForKey('US.MORGAN.COMMON.DOLLAR'), 'XAG')
    assert.strictEqual(SERIES.metalForKey('GB.SOV.BULLION.FULL'), 'XAU')

    /*  0.7734 oz ASW is the number every dealer quotes; if this drifts, every
        Morgan premium in the tool drifts with it. */
    const oz = MORGAN.DENOMINATIONS.DOLLAR.fineOz
    assert.ok(Math.abs(oz - 0.7734) < 0.0002, 'ASW was ' + oz)
})

test('1921 was struck in both designs, and the tool says so rather than picking', () => {
    const designs = MORGAN.designsForYear(1921).map(d => d.code)
    assert.deepStrictEqual(designs.slice().sort(), ['MORGAN', 'PEACE'])
    /*  Structurally the same as Victoria 1871-1885 on the sovereign side,
        which is why it needed no new machinery. */
    assert.strictEqual(MORGAN.designsForYear(1900).length, 1)
    assert.strictEqual(MORGAN.designsForYear(1930).length, 1)
})

/*  Each series' idea of an odd price is its own. A common Morgan trades at
    about twice its silver, which the sovereign thresholds call a PREMIUM,
    and an 1893-S at sixty times would read "rarity or error" - the badge
    that made that column ignorable once already. */
test('what counts as an odd price is a property of the series', () => {
    const sov = SERIES.get('GB.SOV').plausibility
    const dollar = SERIES.get('US.MORGAN').plausibility
    assert.ok(dollar.premiumAbove > sov.premiumAbove)
    assert.ok(dollar.extremeAbove > sov.extremeAbove)
    assert.ok(sov.extremeAbove < 2.0 + dollar.premiumAbove,
        'a Morgan at twice silver must not be extreme by any series measure')
})

/*  The verdict a reader sees, not just the threshold behind it. A key date
    at sixty times its silver labelled "priced near spot" would be absurd,
    and labelled "rarity or error" would be a libel - so the pool that says
    the metal does not price this coin says it in the label too. */
test('the plausibility verdict fits the coin it is describing', () => {
    const PLAUSIBILITY = require('../src/analytics/plausibility.js')
    const at = (price, key) => PLAUSIBILITY.assess(price, 0.7734, 49.7, { key })

    assert.strictEqual(at(77, 'US.MORGAN.COMMON.DOLLAR').verdict, 'BULLION',
        'a common Morgan at twice its silver is ordinary')
    assert.strictEqual(at(300, 'US.MORGAN.COMMON.DOLLAR').verdict, 'EXTREME',
        'a COMMON date at eight times silver is worth a second look')
    assert.strictEqual(at(2300, 'US.MORGAN.KEY_DATE.DOLLAR').verdict, 'NUMISMATIC',
        'an 1893-S at sixty times silver is an 1893-S, not an error')
    assert.strictEqual(at(900, 'US.MORGAN.GRADED.DOLLAR').verdict, 'NUMISMATIC')
    assert.strictEqual(at(5, 'US.MORGAN.COMMON.DOLLAR').verdict, 'IMPOSSIBLE',
        'under its own silver, it is not the coin claimed')

    /*  Sovereigns keep every threshold they had. */
    const sov = PLAUSIBILITY.assess(3100, 0.2354, 3290, { key: 'GB.SOV.BULLION.FULL' })
    assert.strictEqual(sov.verdict, 'EXTREME')

    /*  And no label mentions a metal, because two series now share them. */
    for (const key of ['US.MORGAN.COMMON.DOLLAR', 'GB.SOV.BULLION.FULL']) {
        const v = at(77, key)
        assert.ok(!/gold|silver/i.test(v.label + ' ' + v.detail),
            'metal-specific wording in: ' + v.label)
    }
})

/*
    The rule that makes two series safe to collect at once.

    A search for "morgan silver dollar" returns sovereigns, Britannias and
    fishing reels alongside Morgans, and a search for "gold sovereign"
    returns the occasional dollar. If the SEARCH decided the series, every
    one of those would be filed as whatever found it - and reclassify could
    never reproduce the decision, because a stored listing has no memory of
    which query returned it.
*/
test('the search that found a coin never decides what it is', () => {
    const { newDatabase } = require('../src/store/db.js')
    const { newRepository } = require('../src/store/repo.js')
    const RECLASSIFY = require('../src/catalogue/reclassify.js')
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    const rows = [
        ['v1|a|0', '1889 CC Morgan Silver Dollar', 'US.MORGAN'],
        ['v1|b|0', '1912 George V Gold Sovereign', 'GB.SOV'],
        /*  Nothing claims a fishing reel, and NULL is the right answer -
            not a guess at whichever series happened to be sweeping. */
        ['v1|c|0', 'Hardy Perfect fishing reel 3 inch', null]
    ]
    for (const [browseId, title] of rows) {
        repository.saveListing({ browseId, legacyId: browseId, title, buyingOptions: 'AUCTION', endTime: now }, now)
        repository.saveSnapshot(browseId, { price: 100, shipping: 0, observedAt: now })
    }

    RECLASSIFY.run(db, repository, { allowedCountries: [] })

    const seriesOf = (browseId) =>
        db.prepare('SELECT series FROM listing WHERE browse_id = ?').get(browseId).series
    for (const [browseId, title, expected] of rows) {
        assert.strictEqual(seriesOf(browseId), expected, title)
    }

    /*  And the one nothing recognised is in the queue rather than silently
        absent - a coin the tool cannot place is exactly what a human is for. */
    const queued = repository.reviewQueue(50, '?').map(r => r.browseId)
    assert.ok(queued.includes('v1|c|0'), 'the unplaceable lot must be asked about')
    db.close()
})

/*  The owner's constraint: one coin at a time. A queue that alternates
    sovereigns and silver dollars cannot be worked in one pass, because the
    judgements are different judgements. */
test('the review queue can be worked one coin at a time', () => {
    const { newDatabase } = require('../src/store/db.js')
    const { newRepository } = require('../src/store/repo.js')
    const db = newDatabase(':memory:')
    const repository = newRepository(db, { sellerSalt: 'test' })
    const now = new Date().toISOString()

    const add = (id, title, series) => {
        repository.saveListing({ browseId: id, legacyId: id, title, buyingOptions: 'AUCTION', endTime: now }, now)
        repository.setListingSeries(id, series)
        repository.queueForReview(id, 'needs a look', null, 0)
    }
    add('s1', 'Sovereign one', 'GB.SOV')
    add('s2', 'Sovereign two', 'GB.SOV')
    add('m1', 'Morgan one', 'US.MORGAN')
    add('x1', 'Something else', null)

    assert.strictEqual(repository.reviewQueue(50).length, 4, 'unfiltered is still everything')
    assert.deepStrictEqual(repository.reviewQueue(50, 'GB.SOV').map(r => r.browseId).sort(), ['s1', 's2'])
    assert.deepStrictEqual(repository.reviewQueue(50, 'US.MORGAN').map(r => r.browseId), ['m1'])
    assert.deepStrictEqual(repository.reviewQueue(50, '?').map(r => r.browseId), ['x1'])

    /*  The counts are what stop a chosen tab hiding the others. */
    const counts = repository.reviewCountsBySeries()
    assert.strictEqual(counts.find(c => c.series === 'GB.SOV').n, 2)
    assert.strictEqual(counts.find(c => c.series === 'US.MORGAN').n, 1)
    assert.strictEqual(counts.find(c => c.series === '?').n, 1)
    db.close()
})
