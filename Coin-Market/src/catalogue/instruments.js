'use strict'

const COINS = require('./coins.js')

/*
    Instrument keys.

    A key is a progressive truncation of the attribute vector, so every
    listing belongs to one instrument at each level of specificity. That is
    what lets the tool answer "what is a sovereign worth" from hundreds of
    observations and "what is this 1874 Melbourne worth" from four, using
    the same data and without pretending the second is as certain as the
    first.
*/

const LEVEL_FIELDS = [
    [],                                                  /* L0: series + denomination */
    ['portrait'],
    ['portrait', 'year'],
    ['portrait', 'year', 'mint'],
    ['portrait', 'year', 'mint', 'gradeBand']
]

exports.MAX_LEVEL = LEVEL_FIELDS.length - 1

/*
    Builds the key at a given level, or null when a required attribute is
    unknown. Returning null rather than a placeholder is deliberate: an
    "unknown mint" bucket would silently merge London coins with branch
    mints that trade at multiples of the price.
*/
exports.keyAt = function (attributes, level) {
    if (attributes === null || attributes === undefined) { return null }
    if (attributes.denomination === null || attributes.denomination === undefined) { return null }

    /*
        Bullion and collector coins are separate instruments, not the same
        instrument at different prices.

        eBay's sellers split by format: bullion-grade sovereigns go to
        auction, while proofs, slabbed pieces, branch mints and pre-1871
        coins are listed buy-it-now at collector prices. Pooling them made
        the headline compare auction clearing against numismatic asks - a
        median ask of 62.8% over melt where bullion runs nearer 13% - which
        reads as an enormous opportunity that does not exist.

        COINS.isBullionPool already drew this line and nothing used it. The
        pool sits immediately after the series so it divides at EVERY level:
        GB.SOV.BULLION.FULL and GB.SOV.COLLECTOR.FULL never mix, and neither
        do their year and mint refinements.

        Absent bullionPool reads as bullion. classify.js always sets it; the
        default only matters for callers building attributes by hand.
    */
    const pool = attributes.bullionPool === false ? 'COLLECTOR' : 'BULLION'
    const parts = [attributes.series || 'GB.SOV', pool, attributes.denomination]

    for (const field of LEVEL_FIELDS[level]) {
        const value = attributes[field]
        if (value === null || value === undefined) { return null }
        parts.push(String(value))
    }
    return parts.join('.')
}

/* Every key this listing belongs to, coarsest first. */
exports.keysFor = function (attributes) {
    const keys = []
    for (let level = 0; level <= exports.MAX_LEVEL; level++) {
        const key = exports.keyAt(attributes, level)
        if (key === null) { break }        /* levels are nested: a gap ends the chain */
        keys.push({ key, level })
    }
    return keys
}

/*
    The gold in the lot, not in the coin.

    Almost always the same thing, because almost every lot is one coin. Where
    somebody has told us a lot holds several of the same coin, the melt it
    should be measured against is that many coins' worth - otherwise a
    genuine three-sovereign lot reads as one sovereign at three times the
    price, which is exactly the mistake that put fake bargains on the front
    page from the other direction.
*/
exports.fineOzFor = function (attributes) {
    const denomination = COINS.DENOMINATIONS[attributes.denomination]
    if (denomination === undefined) { return null }
    const quantity = Number.isFinite(attributes.quantity) && attributes.quantity > 1
        ? Math.floor(attributes.quantity)
        : 1
    return denomination.fineOz * quantity
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

exports.displayName = function (key) {
    const parts = key.split('.')
    /* parts[0..1] are the series prefix 'GB','SOV'; parts[2] is the pool. */
    const pool = parts[2]
    const denomination = COINS.DENOMINATIONS[parts[3]]
    const bits = [denomination === undefined ? parts[3] : denomination.label]

    if (parts[4] !== undefined) {
        const portrait = COINS.PORTRAIT_BY_CODE.get(parts[4])
        bits.push(portrait === undefined ? parts[4] : portrait.label)
    }
    if (parts[5] !== undefined) { bits.push(parts[5]) }
    if (parts[6] !== undefined) {
        const mint = COINS.MINTS[parts[6]]
        bits.push(mint === undefined ? parts[6] : mint.label)
    }
    if (parts[7] !== undefined) { bits.push(exports.gradeLabel(parts[7])) }

    /*  Both pools are labelled, not just the collector one. An unlabelled
        "Sovereign" is exactly the ambiguity this split exists to remove. */
    const label = bits.join(' · ')
    if (pool === 'COLLECTOR') { return label + ' (collector)' }
    if (pool === 'BULLION') { return label + ' (bullion)' }
    return label
}
