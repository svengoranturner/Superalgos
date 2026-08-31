'use strict'

const COINS = require('./coins.js')
const SERIES = require('./series/index.js')

/*
    Instrument keys.

    A key is a progressive truncation of the attribute vector, so every
    listing belongs to one instrument at each level of specificity. That is
    what lets the tool answer "what is a sovereign worth" from hundreds of
    observations and "what is this 1874 Melbourne worth" from four, using
    the same data and without pretending the second is as certain as the
    first.
*/

/*  The ladder belongs to the series now: a coin family with no portraits,
    or with a mintmark that means something different, declares its own
    rather than bending this one. MAX_LEVEL stays as the default series'
    depth because callers loop up to it. */
exports.MAX_LEVEL = SERIES.defaultPack().levelFields.length - 1

/*
    Builds the key at a given level, or null when a required attribute is
    unknown. Returning null rather than a placeholder is deliberate: an
    "unknown mint" bucket would silently merge London coins with branch
    mints that trade at multiples of the price.
*/
exports.keyAt = function (attributes, level, packOrId) {
    if (attributes === null || attributes === undefined) { return null }
    if (attributes.denomination === null || attributes.denomination === undefined) { return null }

    /*  attributes.series is honoured ahead of the argument, because a stored
        attribute vector already carries the series it was classified as and
        a caller that forgot to pass a pack must not silently re-badge it. */
    const pack = SERIES.resolve(attributes.series || packOrId)
    const ladder = pack.levelFields[level]
    if (ladder === undefined) { return null }

    /*
        Bullion and collector coins are separate instruments, not the same
        instrument at different prices.

        eBay's sellers split by format: bullion-grade sovereigns go to
        auction, while proofs, slabbed pieces, branch mints and pre-1871
        coins are listed buy-it-now at collector prices. Pooling them made
        the headline compare auction clearing against numismatic asks - a
        median ask of 62.8% over spot where bullion runs nearer 13% - which
        reads as an enormous opportunity that does not exist.

        COINS.isBullionPool already drew this line and nothing used it. The
        pool sits immediately after the series so it divides at EVERY level:
        GB.SOV.BULLION.FULL and GB.SOV.COLLECTOR.FULL never mix, and neither
        do their year and mint refinements.

        Absent bullionPool reads as bullion. classify.js always sets it; the
        default only matters for callers building attributes by hand.
    */
    /*  Six pools, not two. A single COLLECTOR bucket reported one median
        across a GBP 10,000 1832 William IV, an ordinary branch-mint
        Victorian and a modern proof - a number that described none of them.
        See COINS.poolFor. The boolean is the fallback for attribute vectors
        built by hand. */
    const pool = attributes.pool ||
        (attributes.bullionPool === false ? 'COLLECTOR' : 'BULLION')
    const parts = [pack.id, pool, attributes.denomination]

    for (const field of ladder) {
        const value = attributes[field]
        if (value === null || value === undefined) { return null }
        parts.push(String(value))
    }
    return parts.join('.')
}

/* Every key this listing belongs to, coarsest first. */
exports.keysFor = function (attributes, packOrId) {
    const keys = []
    const pack = SERIES.resolve((attributes && attributes.series) || packOrId)
    for (let level = 0; level < pack.levelFields.length; level++) {
        const key = exports.keyAt(attributes, level, pack)
        if (key === null) { break }        /* levels are nested: a gap ends the chain */
        keys.push({ key, level })
    }
    return keys
}

/*
    The gold in ONE of these coins.

    Deliberately not multiplied by any lot quantity: this value is written to
    the shared instrument row, so a three-coin lot passing 3x through here
    would redefine the spot value for every other listing filed under the same key.
    The lot size lives on listing_instrument.quantity instead, and the
    queries multiply the two when they read a listing's spot.
*/
exports.fineOzFor = function (attributes, packOrId) {
    const pack = SERIES.resolve((attributes && attributes.series) || packOrId)
    const denomination = pack.denominations[attributes.denomination]
    return denomination === undefined ? null : denomination.fineOz
}

const GRADE_LABELS = {
    SLAB_PROOF: 'Proof (slabbed)', SLAB_MS65_PLUS: 'MS65+', SLAB_MS64: 'MS64',
    SLAB_MS63: 'MS63', SLAB_MS62: 'MS62', SLAB_MS61_BELOW: 'MS61 or below',
    RAW_PROOF: 'Proof', RAW_BU: 'BU / Uncirculated', RAW_EF: 'Extremely Fine',
    RAW_VF: 'Very Fine', RAW_FINE_BELOW: 'Fine or below', RAW_UNSPECIFIED: 'Ungraded'
}

exports.gradeLabel = function (band) {
    return GRADE_LABELS[band] !== undefined ? GRADE_LABELS[band] : band.replace(/_/g, ' ')
}

/*  One ladder field, rendered. Falls back to the raw value for anything the
    pack does not recognise, because a code on screen is still findable and a
    blank is not. */
function labelFor (pack, field, value) {
    if (field === 'portrait') {
        const portrait = pack.portraitByCode ? pack.portraitByCode.get(value) : undefined
        return portrait === undefined ? value : portrait.label
    }
    if (field === 'mint') {
        const mint = pack.mints ? pack.mints[value] : undefined
        return mint === undefined ? value : mint.label
    }
    if (field === 'gradeBand') { return exports.gradeLabel(value) }
    return value
}

/*
    The name a coin type goes by on screen.

    This used to parse its key BY POSITION - parts[2] is the pool, parts[3]
    the denomination - which worked only because every key began with exactly
    two segments of series. On any other shape it read the wrong fields and
    returned an empty string, which was then written to a NOT NULL column;
    test/store.test.js has stored such a key since long before anyone noticed.

    Now the registry says which series owns the key, and the series' own
    ladder says what each remaining segment means. So a series id of any
    length works, and an unrecognised key returns the key itself: a name you
    cannot read is bad, but a row you cannot find is worse, and a blank
    "Coin type" cell reads as a rendering fault rather than a data one.
*/
exports.displayName = function (key) {
    const found = SERIES.forKey(key)
    if (found === null) { return String(key) }

    const { pack, rest } = found
    const [pool, denominationCode, ...tail] = rest
    const denomination = pack.denominations[denominationCode]
    const bits = [denomination === undefined ? denominationCode : denomination.label]

    /*  The deepest ladder names every field in order, so segment i of the
        tail is field i. That is the same mapping keyAt used to build it. */
    const fields = pack.levelFields[pack.levelFields.length - 1]
    tail.forEach((value, i) => {
        if (value === undefined || fields[i] === undefined) { return }
        bits.push(labelFor(pack, fields[i], value))
    })

    /*  Every pool is labelled, not just the unusual ones. An unlabelled
        "Sovereign" is exactly the ambiguity this split exists to remove. */
    const label = bits.join(' · ')
    const poolLabel = pack.pools[pool]
    return poolLabel === undefined ? label : label + ' (' + poolLabel + ')'
}
