'use strict'

const COINS = require('./coins.js')
const EXCLUSIONS = require('./exclusions.js')
const CONDITIONS = require('./conditions.js')
const LEARNED = require('./learned.js')

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
    const marks = []
    /*
        The mint letter is glued to the year in the way dealers actually
        write it - "1887S", "1874M", "1918I" - and a word boundary after the
        digits never matches there, because S is a word character. That one
        missing case was most of the "Year not identified" review queue, and
        it cost the mintmark as well: a branch-mint coin whose mint went
        unread also fails the bullion-pool test for the wrong reason.
    */
    /*  The space is optional, because sellers write it both ways: "1887S"
        and "1919 P" are the same claim. 52 live listings had an unread mint
        for want of it - 1918 I Bombay, 1880 M Melbourne, 1871 S Sydney,
        1927 SA Pretoria - and a coin whose mint goes unread is not merely
        missing a field, it fails the pool test for the wrong reason.

        The trailing word boundary is what makes this safe: in "1887
        Sovereign" the S is followed by "overeign", so there is no boundary
        after it and the letter is not taken. Checked against 4,000 live
        titles with no false reading. */
    const pattern = /\b(1[89]\d{2}|20[0-4]\d)\s?(SA|[SMPCIA])?\b/gi
    let match
    while ((match = pattern.exec(title)) !== null) {
        const year = parseInt(match[1], 10)
        if (year >= 1817 && year <= 2049) {
            candidates.push(year)
            if (match[2] !== undefined) { marks.push(match[2].toUpperCase()) }
        }
    }
    if (candidates.length === 0) { return { year: null, confidence: 0, mintmark: null } }
    const mintmark = marks.length === 1 ? marks[0] : null
    if (candidates.length === 1) { return { year: candidates[0], confidence: 1, mintmark } }
    /*
        Several plausible years - e.g. "1817-1917 centenary" or a seller
        listing a date range. Ambiguous: take the first but flag it down,
        so it lands in review rather than silently mis-binning.
    */
    return { year: candidates[0], confidence: 0.4, mintmark }
}

/* -------------------------------------------------------- denomination */

/*
    Punctuation carries no denominational meaning, so it is removed before
    the denomination is read.

    This is the third time the same bug has been fixed by widening a list of
    allowed gap characters: first brackets and commas ("1/2 (Half) Sovereign",
    "quarter new design ,sovereign"), now asterisks and hashes ("*HALF*
    SOVEREIGN", "HALF SOLID #GOLD SOVEREIGN"). Both of the latter were sitting
    in the live opportunities panel priced against a FULL sovereign's gold -
    a half sovereign at GBP 663 looks like a 19% edge and is nothing of the
    kind.

    Enumerating permitted characters loses to the next seller who reaches for
    a symbol. Stripping the ones that cannot mean anything wins once. Kept:
    letters, digits, the fraction glyphs, the solidus in "1/2", and the pound
    sign for the multi-weight forms.
*/
function readableTitle (title) {
    return String(title).toLowerCase()
        .replace(/[^a-z0-9£¼½⅛⅑⅒/.\s-]+/g, ' ')
        .replace(/\s+/g, ' ')
}

function extractDenomination (title) {
    const t = readableTitle(title)
    /*  The gap tolerance matters, and so does what is allowed IN the gap.
        Sellers write "Quarter-Sovereign", "Quarter 2g Sovereign",
        "1/2 (Half) Sovereign" and "quarter new design ,sovereign" - and a
        gap class of word characters, spaces, hyphens and dots matched the
        first two and not the last two, because brackets and commas were
        missing from it. Both fell through to FULL and were priced against a
        full sovereign's 7.99g of gold, which is how a genuine 1980 half
        sovereign proof came to be suppressed from the opportunities panel
        as "below melt - not this coin". */
    /*  The word after, not before. "Royal Mint 2013 Gold Proof Sovereign
        Half with Original Box" is a genuine half sovereign that was priced
        against a full sovereign's 7.99g of gold and duly appeared in the
        live opportunities panel as a bargain. Same defect as the quarter
        below, one word order along. */
    const reversed = t.match(/\bsovereign\s*[-,]?\s*(half|quarter|double)\b/)
    if (reversed !== null) { return { denomination: reversed[1].toUpperCase(), confidence: 1 } }

    /*  "Qtr" is how dealers abbreviate it, and the Royal Mint's own listing
        titles use it - "Gold Proof Qtr Sovereign AGW 1.83g". */
    if (/(\bquarter\b|\bqtr\b|\bqrtr\b|\b1\s*\/\s*4\b|¼)[\s\-\w./]{0,16}?sovereign/.test(t)) { return { denomination: 'QUARTER', confidence: 1 } }
    if (/(\bhalf\b|\b1\s*\/\s*2\b|½)[\s\-\w./]{0,16}?sovereign/.test(t) || /\bhalf[-\s]?sov\b/.test(t)) { return { denomination: 'HALF', confidence: 1 } }
    /*  The multi-weight sovereigns, which sellers write nine different ways.

        Adjacency was the bug: requiring the multiplier immediately before
        "sovereign" missed "5 POUNDS SOVEREIGN" (the plural breaks it),
        "£5 GOLD SOVEREIGN" (the symbol), bare "5 Sovereign" and "2 SOV.".
        All of them fell through to the FULL catch-all, so 87 live lots were
        priced against a half or a fifth of the gold they actually contain -
        and a £9,654 five-sovereign piece duly read 1146% over melt.

        The negative lookbehind is not decoration: "Type 2 Sovereign" is a
        portrait variety of an ordinary full sovereign, not a double. */
    if (/\bquintuple\b/.test(t) ||
        /(£\s*5|\b(five|5)\s*pounds?)[\s\-\w.,()]{0,16}?\bsov/.test(t) ||
        /(?<!type\s)\b5\s*(gold\s*)?sovereign\b/.test(t)) {
        return { denomination: 'QUINTUPLE', confidence: 1 }
    }
    /*  A piedfort is a sovereign struck at double thickness, so it carries a
        double sovereign's gold. It is not literally a two-pound piece, but
        this tool measures premium over gold content and the gold content is
        what has to be right. */
    if (/\b(double|two\s*pound)\s*(gold\s*)?sovereign/.test(t) || /\bdouble[-\s]?sov\b/.test(t) ||
        /\bpie(d)?fort\b/.test(t) ||
        /(£\s*2|\b(two|2)\s*pounds?)[\s\-\w.,()]{0,16}?\bsov/.test(t) ||
        /(?<!type\s)\b2\s*(gold\s*)?sov\b/.test(t)) {
        return { denomination: 'DOUBLE', confidence: 1 }
    }
    /*  A fraction the sovereign series does not mint - eighths, tenths,
        twentieths, sold as "Classics Remastered" style private issues. The
        Royal Mint's smallest sovereign is the quarter, so these are not
        sovereigns at any size.

        Refusing a denomination truncates the key chain and sends the listing
        to review, which is what keyAt already does with an unknown mint. Far
        better than calling a GBP 120 eighth a full sovereign and leaving it
        in the bullion median. */
    /*  The ordinal suffix matters: sellers write "1/8th Gold Sovereign" as
        often as "1/8", and a word boundary after the digit does not match
        "8th". Missing it put a GBP 138 eighth into the full-sovereign
        pricing, where it is compared against 7.99g of gold. */
    /*  Bounded to the fractions the series does not mint, rather than any
        1/N. An unbounded denominator also matched limited-edition numbering
        - "Limited Edition 1/50" - and refused a denomination to a genuine
        full sovereign. The exclusion rule carries the same bound. */
    if (/\b1\s*\/\s*([5-9]|1\d|20|100)\s*(th|nd|rd|st)?\b|[⅛⅑⅒]|\b(eighth|tenth|sixteenth|twentieth|hundredth)\b/.test(t)) {
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

function extractMint (title, year, compactMark) {
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
    /*  The compact dealer form, "1887S" - read out of the year above rather
        than matched again here, so the letter is only ever taken when it is
        actually attached to a plausible year. */
    if (compactMark !== null && compactMark !== undefined) {
        const mint = COINS.MINTS[compactMark]
        if (mint !== undefined) {
            const impossible = year !== null && mint.from !== undefined &&
                (year < mint.from || year > mint.to)
            if (!impossible) { return { mint: compactMark, confidence: 0.9 } }
        }
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
/*
    context is optional and carries what a human has told us:
      label   - a stored decision about this exact coin, which outranks
                everything here.
      learned - rules compiled from earlier decisions, which generalise them
                to listings nobody has looked at.
    Absent, this behaves exactly as it did before there was anywhere to put
    a human decision.
*/
exports.classify = function (listing, context) {

    const title = String(listing.title || '')
    const aspects = listing.aspects || null
    const learned = (context && context.learned) || null
    const label = (context && context.label) || null

    /*  A confirmed coin skips the exclusion rules entirely rather than being
        excluded and then restored.

        Restoring afterwards threw away everything the parser knew: a
        three-coin lot marked genuine came back with no year, no portrait and
        no denomination, so confirming it created three more questions. The
        rules exist to guess in the absence of a human, and there is a human
        here. */
    const confirmed = label !== null && label.verdict === LEARNED.VERDICT.SOVEREIGN

    if (!confirmed) {
        const excluded = EXCLUSIONS.screen(title, aspects) ||
            (learned === null ? null : learned.exclusionFor(title))
        if (excluded !== null) {
            return LEARNED.apply(
                { excluded, attributes: null, confidence: 0, needsReview: false, reasons: [excluded.reason] },
                label)
        }
    }

    const yearResult = extractYear(title)
    const denomResult = extractDenomination(title)
    const portraitResult = extractPortrait(title, yearResult.year)
    const mintResult = extractMint(title, yearResult.year, yearResult.mintmark)
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

    /*  A denomination someone taught us, for the titles no rule reads -
        applied before the aspects-derived confidence is judged, and below a
        seller's own structured Denomination aspect, which is better
        evidence than either of us guessing from a title. */
    if (learned !== null && attributes.confidence.denomination < 1) {
        const taught = learned.denominationFor(title)
        if (taught !== null) {
            attributes.denomination = taught
            attributes.confidence.denomination = 1
        }
    }

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
    /*  Which pool it trades in, by the reason it is not ordinary bullion.
        The boolean above is kept because plenty of code still asks the
        simpler question. */
    attributes.pool = COINS.poolFor(attributes)

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

    return LEARNED.apply({
        excluded: null,
        attributes,
        confidence: Number(overall.toFixed(3)),
        needsReview: overall < 0.7 || attributes.denomination === null || unknownBand,
        reasons
    }, label)
}

exports.extractYear = extractYear
exports.extractDenomination = extractDenomination
exports.extractPortrait = extractPortrait
exports.extractMint = extractMint
exports.extractGrade = extractGrade
