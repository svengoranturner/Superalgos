'use strict'

/*
    eBay standardised coin condition descriptors.

    From May 2026 eBay requires sellers to supply structured condition
    detail on coin listings, and a later phase blocks listings that do
    not. That is a seller obligation - we create no listings - but the
    data comes back to us, and it converts the single most price-relevant
    attribute after metal content from a title-regex guess into a read.

    Two shapes arrive:

      graded  - grading company, numeric grade, letter grade (required)
                and certification number (optional)
      raw     - one of four standardised bands

    NOTE ON SHAPE: eBay documents conditionDescriptors as objects carrying
    a name (or numeric descriptor id) and a values array. The exact field
    naming differs between the Browse and Trading representations and I
    have not been able to confirm it against a live coin listing, so the
    reader below is deliberately tolerant: it accepts name or id keys, and
    values as objects or bare strings. Anything it cannot interpret is
    ignored rather than guessed, leaving the title parser in charge.
*/

/*
    eBay's four standardised raw-coin bands, mapped onto our grade bands.
    Mapped explicitly rather than by string-matching so that a wording
    change on eBay's side fails visibly instead of silently re-binning
    coins into the wrong grade - which would shift every grade-level
    premium without any error appearing.
*/
const RAW_BAND_MAP = [
    { match: /^uncirculated$/i,                                  band: 'RAW_BU' },
    { match: /^extremely\s+fine\s+to\s+about\s+uncirculated$/i,   band: 'RAW_EF' },
    { match: /^fine\s+to\s+very\s+fine$/i,                        band: 'RAW_VF' },
    { match: /^below\s+fine$/i,                                   band: 'RAW_FINE_BELOW' }
]

/* Descriptor names eBay uses for the graded-coin attributes. */
const FIELD_ALIASES = {
    gradingCompany: [/^grader$/i, /^grading\s*(company|service)$/i, /^professional\s*grader$/i],
    gradeNumeric:   [/^(number|numeric)\s*grade$/i, /^grade\s*(number|numeric)$/i],
    gradeLetter:    [/^letter\s*grade$/i, /^grade\s*letter$/i],
    certNumber:     [/^certification\s*number$/i, /^cert(ificate)?\s*(number|no\.?)$/i],
    conditionBand:  [/^(coin\s*)?condition$/i, /^condition\s*(descriptor|detail)$/i]
}

function firstValue (descriptor) {
    const values = descriptor.values || descriptor.value || descriptor.contents
    if (values === undefined || values === null) { return null }
    const list = Array.isArray(values) ? values : [values]
    for (const entry of list) {
        if (typeof entry === 'string' && entry.trim().length > 0) { return entry.trim() }
        if (entry !== null && typeof entry === 'object') {
            const content = entry.content !== undefined ? entry.content
                : (entry.value !== undefined ? entry.value : entry.text)
            if (typeof content === 'string' && content.trim().length > 0) { return content.trim() }
        }
    }
    return null
}

function nameOf (descriptor) {
    const name = descriptor.name !== undefined ? descriptor.name
        : (descriptor.descriptorName !== undefined ? descriptor.descriptorName : descriptor.label)
    return typeof name === 'string' ? name.trim() : null
}

/*
    Flattens an eBay conditionDescriptors array into a plain object.
    Returns {} when nothing recognisable is present, which is the correct
    outcome for a pre-change listing.
*/
exports.parseDescriptors = function (descriptors) {
    const result = {}
    if (!Array.isArray(descriptors)) { return result }

    for (const descriptor of descriptors) {
        if (descriptor === null || typeof descriptor !== 'object') { continue }
        const name = nameOf(descriptor)
        const value = firstValue(descriptor)
        if (name === null || value === null) { continue }

        for (const [field, patterns] of Object.entries(FIELD_ALIASES)) {
            if (patterns.some(pattern => pattern.test(name))) {
                result[field] = value
                break
            }
        }
    }
    return result
}

/*
    Turns parsed descriptors into one of our grade bands.

    Returns null when the descriptors say nothing about grade, so the
    caller falls back to the title parser rather than recording a coin as
    ungraded on no evidence.
*/
exports.gradeFromDescriptors = function (parsed) {
    if (parsed === null || parsed === undefined) { return null }

    /* Graded: the numeric grade decides the band, exactly as the market
       prices it. A proof designation (PF/PR) outranks the number. */
    if (parsed.gradeNumeric !== undefined || parsed.gradingCompany !== undefined) {
        const letter = String(parsed.gradeLetter || '').toUpperCase()
        const numeric = parseInt(String(parsed.gradeNumeric || '').replace(/\D/g, ''), 10)

        if (/^(PF|PR)/.test(letter)) {
            return { gradeBand: 'SLAB_PROOF', detail: describe(parsed), source: 'descriptor' }
        }
        if (Number.isFinite(numeric)) {
            let band
            if (numeric >= 65) { band = 'SLAB_MS65_PLUS' }
            else if (numeric === 64) { band = 'SLAB_MS64' }
            else if (numeric === 63) { band = 'SLAB_MS63' }
            else if (numeric === 62) { band = 'SLAB_MS62' }
            else { band = 'SLAB_MS61_BELOW' }
            return { gradeBand: band, detail: describe(parsed), source: 'descriptor' }
        }
    }

    /* Raw: one of the four standardised bands. */
    if (parsed.conditionBand !== undefined) {
        for (const entry of RAW_BAND_MAP) {
            if (entry.match.test(parsed.conditionBand)) {
                return { gradeBand: entry.band, detail: parsed.conditionBand, source: 'descriptor' }
            }
        }
        /*
            A band we do not recognise. Do NOT fall through to a default -
            eBay may have added or reworded a band, and quietly filing it
            under "ungraded" would move premiums with no visible error.
        */
        return { gradeBand: null, detail: parsed.conditionBand, source: 'descriptor_unknown' }
    }

    return null
}

function describe (parsed) {
    const bits = []
    if (parsed.gradingCompany !== undefined) { bits.push(String(parsed.gradingCompany).toUpperCase()) }
    if (parsed.gradeLetter !== undefined) { bits.push(String(parsed.gradeLetter).toUpperCase()) }
    if (parsed.gradeNumeric !== undefined) { bits.push(String(parsed.gradeNumeric)) }
    return bits.length > 0 ? bits.join(' ') : null
}

exports.RAW_BAND_MAP = RAW_BAND_MAP
exports.FIELD_ALIASES = FIELD_ALIASES
