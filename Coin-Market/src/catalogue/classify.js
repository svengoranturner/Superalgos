'use strict'

const COINS = require('./coins.js')
const EXCLUSIONS = require('./exclusions.js')
const CONDITIONS = require('./conditions.js')

/*
    Turns a free-text eBay listing into a structured attribute vector.

    Order matters: structured item specifics are trusted first, because
    they are seller-entered against eBay's own schema; the title parser is
    the fallback, because most sovereign listings say little more than
    "1974 gold sovereign". Anything the pipeline cannot place with
    confidence goes to the review queue rather than being guessed at.
*/

/* ---------------------------------------------------------------- year */

/*
    Sovereign-plausible years only. Bounded at 1817 (first modern
    sovereign) so that "22ct", "9ct", weights and postcodes cannot be
    mistaken for dates.
*/
function extractYear (title) {
    const candidates = []
    const pattern = /\b(1[89]\d{2}|20[0-4]\d)\b/g
    let match
    while ((match = pattern.exec(title)) !== null) {
        const year = parseInt(match[1], 10)
        if (year >= 1817 && year <= 2049) { candidates.push(year) }
    }
    if (candidates.length === 0) { return { year: null, confidence: 0 } }
    if (candidates.length === 1) { return { year: candidates[0], confidence: 1 } }
    /*
        Several plausible years - e.g. "1817-1917 centenary" or a seller
        listing a date range. Ambiguous: take the first but flag it down,
        so it lands in review rather than silently mis-binning.
    */
    return { year: candidates[0], confidence: 0.4 }
}

/* -------------------------------------------------------- denomination */

function extractDenomination (title) {
    const t = title.toLowerCase()
    if (/\b(quarter|1\/4)\s*(gold\s*)?sovereign/.test(t)) { return { denomination: 'QUARTER', confidence: 1 } }
    if (/\b(half|1\/2)\s*(gold\s*)?sovereign/.test(t) || /\bhalf[-\s]?sov\b/.test(t)) { return { denomination: 'HALF', confidence: 1 } }
    if (/\b(double|two\s*pound)\s*(gold\s*)?sovereign/.test(t) || /\bdouble[-\s]?sov\b/.test(t)) { return { denomination: 'DOUBLE', confidence: 1 } }
    if (/\b(quintuple|five\s*pound|5\s*pound)\s*(gold\s*)?sovereign/.test(t)) { return { denomination: 'QUINTUPLE', confidence: 1 } }
    /*  A fraction the sovereign series does not mint - eighths, tenths,
        twentieths, sold as "Classics Remastered" style private issues. The
        Royal Mint's smallest sovereign is the quarter, so these are not
        sovereigns at any size.

        Refusing a denomination truncates the key chain and sends the listing
        to review, which is what keyAt already does with an unknown mint. Far
        better than calling a GBP 120 eighth a full sovereign and leaving it
        in the bullion median. */
    if (/\b1\s*\/\s*(8|10|16|20|25|32|50)\b|\b(eighth|tenth|sixteenth|twentieth)\b/.test(t)) {
        return { denomination: null, confidence: 0 }
    }
    if (/\bsovereign\b|\bsov\b/.test(t)) { return { denomination: 'FULL', confidence: 0.9 } }
    return { denomination: null, confidence: 0 }
}

/* ------------------------------------------------------------ portrait */

const PORTRAIT_KEYWORDS = [
    { code: 'VIC_JUBILEE',      test: /\bjubilee\s*head\b|\bjubilee\b/i },
    { code: 'VIC_OLD',          test: /\b(old|veiled|widow)\s*head\b/i },
    { code: 'VIC_YOUNG_SHIELD', test: /\b(shield|shield[-\s]?back|shieldback)\b/i },
    { code: 'VIC_YOUNG_GEORGE', test: /\byoung\s*head\b/i },
    { code: 'GEORGE_III',       test: /\bgeorge\s*(iii|3rd|3)\b/i },
    { code: 'GEORGE_IV',        test: /\bgeorge\s*(iv|4th|4)\b/i },
    { code: 'WILLIAM_IV',       test: /\bwilliam\s*(iv|4th|4)\b/i },
    { code: 'EDWARD_VII',       test: /\bedward\s*(vii|7th|7)\b/i },
    { code: 'GEORGE_V',         test: /\bgeorge\s*(v|5th|5)\b(?!i)/i },
    { code: 'GEORGE_VI',        test: /\bgeorge\s*(vi|6th|6)\b/i },
    { code: 'CHARLES_III',      test: /\bcharles\s*(iii|3rd|3)\b/i }
]

/*
    Portrait resolution combines two weak signals into one strong one:
    a monarch keyword narrows the family, and the year picks the portrait
    within it. Neither alone is sufficient - "Victoria" spans four distinct
    types with materially different prices, and a bare year in 1871-1885
    cannot separate shield from St George.
*/
function extractPortrait (title, year) {

    const byYear = COINS.portraitsForYear(year)

    for (const keyword of PORTRAIT_KEYWORDS) {
        if (!keyword.test.test(title)) { continue }
        const portrait = COINS.PORTRAIT_BY_CODE.get(keyword.code)
        if (year === null) { return { portrait: keyword.code, confidence: 0.6 } }
        /* Keyword and date agree - the strongest signal available. */
        if (year >= portrait.from && year <= portrait.to) {
            return { portrait: keyword.code, confidence: 1 }
        }
        /* They disagree. Trust the date; a seller naming the wrong monarch
           is far more common than a mistyped year. */
        if (byYear.length === 1) { return { portrait: byYear[0].code, confidence: 0.5 } }
        return { portrait: null, confidence: 0 }
    }

    if (/\bvictoria(n)?\b/i.test(title) && byYear.length > 0) {
        const victorian = byYear.filter(p => p.code.startsWith('VIC_'))
        if (victorian.length === 1) { return { portrait: victorian[0].code, confidence: 0.9 } }
        if (victorian.length > 1) { return { portrait: null, confidence: 0.3 } }
    }
    if (/\belizabeth\s*(ii|2nd|2)?\b/i.test(title) && byYear.length === 1) {
        return { portrait: byYear[0].code, confidence: 0.95 }
    }

    if (byYear.length === 1) { return { portrait: byYear[0].code, confidence: 0.85 } }
    if (byYear.length > 1) { return { portrait: null, confidence: 0.3 } }
    return { portrait: null, confidence: 0 }
}

/* ---------------------------------------------------------------- mint */

/*
    Only explicit evidence counts. A bare capital letter in a title is far
    more likely to be an initial or a grade than a mint mark, so single
    letters are accepted only next to the words "mint mark".
*/
const MINT_KEYWORDS = [
    { code: 'S',  test: /\bsydney\b/i },
    { code: 'M',  test: /\bmelbourne\b/i },
    { code: 'P',  test: /\bperth\b/i },
    { code: 'C',  test: /\bottawa\b|\bcanada\b/i },
    { code: 'I',  test: /\bbombay\b|\bmumbai\b/i },
    { code: 'SA', test: /\bpretoria\b|\bsouth\s*africa\b/i }
]

function extractMint (title, year) {
    for (const keyword of MINT_KEYWORDS) {
        if (keyword.test.test(title)) {
            const mint = COINS.MINTS[keyword.code]
            if (year !== null && mint.from !== undefined && (year < mint.from || year > mint.to)) {
                return { mint: null, confidence: 0 }   /* impossible pairing */
            }
            return { mint: keyword.code, confidence: 1 }
        }
    }
    const explicit = title.match(/\bmint\s*mark\s*[:\-]?\s*([SMPCI]|SA)\b/i)
    if (explicit !== null) {
        return { mint: explicit[1].toUpperCase(), confidence: 0.9 }
    }
    if (/\blondon\b|\bno\s*mint\s*mark\b/i.test(title)) { return { mint: 'LON', confidence: 0.9 } }
    /*
        Absence of evidence is weak evidence of London, since London is the
        only mint that strikes no mark - but only for years when branch
        mints were not operating.
    */
    if (year !== null && (year < 1871 || year > 1932)) { return { mint: 'LON', confidence: 0.8 } }
    return { mint: null, confidence: 0 }
}

/* ------------------------------------------------------- finish, grade */

function extractFinish (title) {
    if (/\bproof\b|\bpf\b|\bpr\d{2}\b/i.test(title)) { return { finish: 'PROOF', confidence: 1 } }
    if (/\bb\.?u\.?\b|\bbrilliant\s+uncirculated\b/i.test(title)) { return { finish: 'BU', confidence: 0.9 } }
    return { finish: 'BULLION', confidence: 0.6 }
}

function bandForSlab (service, prefix, numeric) {
    if (/^(PF|PR)$/i.test(prefix)) { return 'SLAB_PROOF' }
    if (numeric >= 65) { return 'SLAB_MS65_PLUS' }
    if (numeric === 64) { return 'SLAB_MS64' }
    if (numeric === 63) { return 'SLAB_MS63' }
    if (numeric === 62) { return 'SLAB_MS62' }
    return 'SLAB_MS61_BELOW'
}

function extractGrade (title, finish) {
    const slab = title.match(/\b(NGC|PCGS|ANACS|CGS)\s*[-\s]?\s*(MS|PF|PR|AU)\s*[-\s]?(\d{2})\b/i)
    if (slab !== null) {
        return {
            gradeBand: bandForSlab(slab[1], slab[2], parseInt(slab[3], 10)),
            gradeDetail: slab[1].toUpperCase() + ' ' + slab[2].toUpperCase() + slab[3],
            confidence: 1
        }
    }
    /*  A bare Sheldon number - "AU50", "XF45", "MS63" - with no grading
        service named. This is grading vocabulary: a seller writing AU50 is
        describing a graded coin, and the parser read straight past it and
        called the coin ungraded, which put GBP 13,000 Victoria 1874 shield
        sovereigns in the bullion pool.

        Confidence sits below an explicit service match because the slab is
        inferred from the wording rather than stated. */
    const sheldon = title.match(/\b(MS|PF|PR|AU|XF|EF|VF|VG|AG)\s?-?\s?(\d{1,2})\b/i)
    if (sheldon !== null) {
        const numeric = parseInt(sheldon[2], 10)
        if (numeric >= 1 && numeric <= 70) {
            const prefix = sheldon[1].toUpperCase()
            return {
                gradeBand: bandForSlab(null, prefix, numeric),
                gradeDetail: prefix + sheldon[2],
                confidence: 0.8
            }
        }
    }
    if (finish === 'PROOF') { return { gradeBand: 'RAW_PROOF', gradeDetail: null, confidence: 0.7 } }
    if (/\b(bu|unc|uncirculated|mint\s*state)\b/i.test(title)) { return { gradeBand: 'RAW_BU', gradeDetail: null, confidence: 0.6 } }
    if (/\b(gef|aunc|about\s*unc|extremely\s*fine|\bef\b)\b/i.test(title)) { return { gradeBand: 'RAW_EF', gradeDetail: null, confidence: 0.6 } }
    if (/\b(gvf|very\s*fine|\bvf\b)\b/i.test(title)) { return { gradeBand: 'RAW_VF', gradeDetail: null, confidence: 0.6 } }
    if (/\b(fine|\bf\b|fair|poor|worn)\b/i.test(title)) { return { gradeBand: 'RAW_FINE_BELOW', gradeDetail: null, confidence: 0.5 } }
    return { gradeBand: 'RAW_UNSPECIFIED', gradeDetail: null, confidence: 0.4 }
}

/* --------------------------------------------------- aspect overrides */

/*
    eBay item specifics, when the seller filled them in, beat anything the
    title parser can infer. Applied after parsing so they can override.
*/
function applyAspects (attrs, aspects) {
    if (aspects === undefined || aspects === null) { return attrs }

    const get = (...names) => {
        for (const name of names) {
            for (const key of Object.keys(aspects)) {
                if (key.toLowerCase() === name.toLowerCase()) { return aspects[key] }
            }
        }
        return undefined
    }

    const year = get('Year', 'Year of Issue')
    if (year !== undefined) {
        const parsed = parseInt(String(year).match(/\b(1[89]\d{2}|20[0-4]\d)\b/)?.[1], 10)
        if (Number.isFinite(parsed)) { attrs.year = parsed; attrs.confidence.year = 1 }
    }

    const certification = get('Certification')
    const grade = get('Grade')
    if (certification !== undefined && /NGC|PCGS|ANACS|CGS/i.test(certification) && grade !== undefined) {
        const m = String(grade).match(/(MS|PF|PR|AU)\s*-?\s*(\d{2})/i)
        if (m !== null) {
            attrs.gradeBand = bandForSlab(certification, m[1], parseInt(m[2], 10))
            attrs.gradeDetail = certification.toUpperCase() + ' ' + m[1].toUpperCase() + m[2]
            attrs.confidence.grade = 1
        }
    }

    const denomination = get('Denomination')
    if (denomination !== undefined) {
        const d = String(denomination).toLowerCase()
        if (/half/.test(d)) { attrs.denomination = 'HALF'; attrs.confidence.denomination = 1 }
        else if (/quarter/.test(d)) { attrs.denomination = 'QUARTER'; attrs.confidence.denomination = 1 }
        else if (/double/.test(d)) { attrs.denomination = 'DOUBLE'; attrs.confidence.denomination = 1 }
        else if (/sovereign/.test(d)) { attrs.denomination = 'FULL'; attrs.confidence.denomination = 1 }
    }

    return attrs
}

/* ------------------------------------------------------------- public */

/*
    Returns { excluded, attributes, confidence, needsReview, reasons }.
    Never throws on odd input - an unparseable title is a review item, not
    an error.
*/
exports.classify = function (listing) {

    const title = String(listing.title || '')
    const aspects = listing.aspects || null

    const excluded = EXCLUSIONS.screen(title, aspects)
    if (excluded !== null) {
        return { excluded, attributes: null, confidence: 0, needsReview: false, reasons: [excluded.reason] }
    }

    const yearResult = extractYear(title)
    const denomResult = extractDenomination(title)
    const portraitResult = extractPortrait(title, yearResult.year)
    const mintResult = extractMint(title, yearResult.year)
    const finishResult = extractFinish(title)
    const gradeResult = extractGrade(title, finishResult.finish)

    let attributes = {
        series: 'GB.SOV',
        denomination: denomResult.denomination,
        year: yearResult.year,
        portrait: portraitResult.portrait,
        mint: mintResult.mint,
        finish: finishResult.finish,
        gradeBand: gradeResult.gradeBand,
        gradeDetail: gradeResult.gradeDetail,
        confidence: {
            year: yearResult.confidence,
            denomination: denomResult.confidence,
            portrait: portraitResult.confidence,
            mint: mintResult.confidence,
            finish: finishResult.confidence,
            grade: gradeResult.confidence
        }
    }

    attributes = applyAspects(attributes, aspects)

    /*
        Standardised condition descriptors outrank both the aspects and the
        title. eBay requires sellers to supply them on coin listings from
        May 2026, so this is structured seller-entered data against eBay's
        own schema - strictly better evidence than a regex over a title
        somebody wrote to attract clicks.
    */
    const descriptors = CONDITIONS.parseDescriptors(listing.conditionDescriptors)
    const fromDescriptors = CONDITIONS.gradeFromDescriptors(descriptors)

    if (fromDescriptors !== null && fromDescriptors.gradeBand !== null) {
        attributes.gradeBand = fromDescriptors.gradeBand
        attributes.gradeDetail = fromDescriptors.detail
        attributes.confidence.grade = 1
        attributes.gradeSource = 'descriptor'
        /* A slabbed grade implies the coin is not a raw bullion piece. */
        if (fromDescriptors.gradeBand === 'SLAB_PROOF') { attributes.finish = 'PROOF' }
    } else {
        attributes.gradeSource = 'title'
    }

    if (descriptors.certNumber !== undefined) { attributes.certNumber = descriptors.certNumber }

    attributes.bullionPool = COINS.isBullionPool(attributes)

    const reasons = []
    if (attributes.denomination === null) { reasons.push('Denomination not identified') }
    if (attributes.year === null) { reasons.push('Year not identified') }
    if (attributes.portrait === null && attributes.year !== null) { reasons.push('Portrait type ambiguous for that year') }
    if (fromDescriptors !== null && fromDescriptors.source === 'descriptor_unknown') {
        /* eBay added or reworded a condition band. Surfaced rather than
           silently binned, because a wrong grade moves the premium. */
        reasons.push('Unrecognised eBay condition band: ' + fromDescriptors.detail)
    }

    /*
        Overall confidence is the weakest link, not the average: a listing
        with a certain year but an unknown denomination is not "half sure",
        it is unusable for pricing.
    */
    const c = attributes.confidence
    const overall = Math.min(c.denomination, Math.max(c.year, 0.5), Math.max(c.portrait, 0.5))

    /* An unrecognised condition band means eBay changed something and our
       grade mapping is now incomplete - that needs a human, not a default. */
    const unknownBand = fromDescriptors !== null && fromDescriptors.source === 'descriptor_unknown'

    return {
        excluded: null,
        attributes,
        confidence: Number(overall.toFixed(3)),
        needsReview: overall < 0.7 || attributes.denomination === null || unknownBand,
        reasons
    }
}

exports.extractYear = extractYear
exports.extractDenomination = extractDenomination
exports.extractPortrait = extractPortrait
exports.extractMint = extractMint
exports.extractGrade = extractGrade
