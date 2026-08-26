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

    const parts = [attributes.series || 'GB.SOV', attributes.denomination]

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

exports.fineOzFor = function (attributes) {
    const denomination = COINS.DENOMINATIONS[attributes.denomination]
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

exports.displayName = function (key) {
    const parts = key.split('.')
    /* parts[0..1] are the series prefix 'GB','SOV' */
    const denomination = COINS.DENOMINATIONS[parts[2]]
    const bits = [denomination === undefined ? parts[2] : denomination.label]

    if (parts[3] !== undefined) {
        const portrait = COINS.PORTRAIT_BY_CODE.get(parts[3])
        bits.push(portrait === undefined ? parts[3] : portrait.label)
    }
    if (parts[4] !== undefined) { bits.push(parts[4]) }
    if (parts[5] !== undefined) {
        const mint = COINS.MINTS[parts[5]]
        bits.push(mint === undefined ? parts[5] : mint.label)
    }
    if (parts[6] !== undefined) { bits.push(exports.gradeLabel(parts[6])) }

    return bits.join(' · ')
}
