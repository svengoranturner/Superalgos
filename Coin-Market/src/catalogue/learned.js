'use strict'

/*
    Human judgement, stored and generalised.

    Everything in exclusions.js is a guess made from outside the market. It
    can only ever chase the last thing that went wrong, and the list has no
    end: fishing reels, sunglasses, fantasy Edward VIII strikes, empty
    presentation boxes, gold bars keyword-stuffed with the word "sovereign".
    Somebody who knows the market answers each of those in a second without
    opening the listing, and until there was somewhere to put that answer it
    had to be re-encoded by hand as another pattern.

    Three things happen here:

      apply()   - a stored label is the truth for that listing, outranking
                  every rule in the pipeline.
      compile() - accepted rules generalise those labels to listings nobody
                  has looked at.
      induce()  - proposes those rules, with the evidence for each, so a
                  person accepts a rule rather than writing one.

    The design is deliberately not a model. With a few hundred labels a
    statistical classifier would be both weaker than these rules and unable
    to say why it dropped anything; here every exclusion traces back through
    a rule to the label a human actually made. The labels are the asset -
    a model can be trained on them later without collecting them again.
*/

/*
    What a human decided, and about which coin.

    The verdict says whether this is a coin the tool TRACKS; the series says
    which family the decision was about. Together they can express the thing
    the old pair could not: "this is a Britannia, not a sovereign" is
    TRACKED for GB.BRIT, where before it could only be recorded as
    NOT_SOVEREIGN - true, but throwing away the half that mattered, and
    inducing a rule that would empty the Britannia pack the day it landed.

    SOVEREIGN and NOT_SOVEREIGN survive as aliases so that the ~57 call
    sites, and any form a browser still has open, keep working. They are
    values, not separate verdicts: VERDICT.SOVEREIGN IS VERDICT.TRACKED.
*/
const VERDICT = {
    TRACKED: 'TRACKED',
    NOT_TRACKED: 'NOT_TRACKED',
    UNSURE: 'UNSURE',

    /* Deprecated spellings of the two above. */
    SOVEREIGN: 'TRACKED',
    NOT_SOVEREIGN: 'NOT_TRACKED'
}

exports.VERDICT = VERDICT

/* ------------------------------------------------------------- matching */

/*
    Phrases are stored as literal text and escaped here, never stored as a
    regex. Two reasons: a rule someone accepted should be readable back to
    them in the words they accepted, and no stored string can then become a
    pattern that eats the collector.
*/
function phrasePattern (phrase) {
    const escaped = String(phrase).trim().toLowerCase()
        .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\s+/g, '\\s+')
    /*  Word boundaries only where the phrase actually starts and ends with a
        word character. "1/8" ends in a digit but starts with one too;
        ".999" starts with punctuation and \b there would mean the opposite
        of what it looks like. */
    const left = /^[a-z0-9]/.test(escaped.replace(/\\/g, '')) ? '\\b' : ''
    const right = /[a-z0-9]$/.test(escaped.replace(/\\/g, '')) ? '\\b' : ''
    return new RegExp(left + escaped + right, 'i')
}

exports.phrasePattern = phrasePattern

/*
    rules: [{ phrase, kind, value, enabled }]
    Returns a matcher over titles. Compiled once per request rather than per
    listing - there are a few thousand listings and this runs on a Pi.
*/
exports.compile = function (rules) {
    const compiled = (rules || [])
        .filter(rule => rule.enabled === undefined || rule.enabled)
        .map(rule => ({ rule, test: phrasePattern(rule.phrase) }))

    /*
        A rule applies to the series it was learned from, and to no other.

        This is the whole point of the migration. "Britannia" is a perfectly
        good reason to reject a sovereign and a catastrophic reason to reject
        a Britannia, and the two are indistinguishable once the scope is
        gone. A rule with no series is deliberately universal - the
        confirmation page makes that an explicit choice rather than a
        default, because it is the one that cannot be undone by accident.
    */
    const inScope = (rule, seriesId) =>
        rule.series === null || rule.series === undefined ||
        seriesId === null || seriesId === undefined ||
        rule.series === seriesId

    return {
        /* The first matching NOT_TRACKED rule for this series, or null. */
        exclusionFor (title, seriesId) {
            for (const entry of compiled) {
                if (entry.rule.kind !== VERDICT.NOT_TRACKED) { continue }
                if (!inScope(entry.rule, seriesId)) { continue }
                if (entry.test.test(title)) {
                    return {
                        code: 'LEARNED',
                        /*  Named in the words of the coin the rule is
                            scoped to - and an UNSCOPED rule has no coin to
                            name. A rule widened to every coin is a deliberate
                            choice the confirmation page makes you tick, so
                            the reason says so rather than reaching for a word
                            that would be wrong on most of what it catches.

                            Lazily required for the same reason as `apply`
                            below: the registry's packs reach back into this
                            module. */
                        reason: entry.rule.series === null || entry.rule.series === undefined
                            ? 'You marked listings containing "' + entry.rule.phrase +
                              '" as not worth tracking, on every coin'
                            : 'You marked listings containing "' + entry.rule.phrase +
                              '" as not ' + require('./series/index.js')
                                  .words(entry.rule.series).plural,
                        phrase: entry.rule.phrase
                    }
                }
            }
            return null
        },

        denominationFor (title, seriesId) {
            for (const entry of compiled) {
                if (entry.rule.kind !== 'DENOMINATION') { continue }
                if (!inScope(entry.rule, seriesId)) { continue }
                if (entry.test.test(title)) { return entry.rule.value }
            }
            return null
        },

        size: compiled.length
    }
}

/* ------------------------------------------------------------ induction */

/*
    Words that carry no information about whether something is a sovereign,
    because nearly every listing in the corpus has them. Computed from the
    corpus rather than hardcoded, so it adapts as the search terms change -
    a hardcoded list would go stale silently, which is the failure mode
    worth avoiding in a component whose whole job is to be trusted.
*/
const MAX_DOCUMENT_FREQUENCY = 0.2

/*
    Function words. They are frequent enough to look like strong rules and
    mean nothing at all - the first version of this offered to drop every
    listing containing "of", on the strength of 239 matches.
*/
const FUNCTION_WORDS = new Set([
    'of', 'the', 'and', 'with', 'for', 'in', 'on', 'at', 'to', 'from', 'by',
    'or', 'as', 'is', 'it', 'its', 'this', 'that', 'new', 'used', 'rare',
    'very', 'all', 'no', 'not', 'only', 'inc', 'plus', 'per', 'x'
])

/* Punctuation and case are noise; "1/8" and ".999" are not. */
function tokenise (title) {
    return String(title).toLowerCase()
        .replace(/[^a-z0-9/.]+/g, ' ')
        .split(' ')
        .map(t => t.replace(/^\.+|\.+$/g, ''))
        .filter(t => t.length > 1)
}

/*
    A bare year generalises catastrophically - "1984" would exclude every
    1984 sovereign because one 1984 fantasy piece was rejected - so years
    are never offered as a rule on their own.
*/
function isYear (token) { return /^(1[89]\d{2}|20[0-4]\d)$/.test(token) }

function candidates (title) {
    const tokens = tokenise(title)
    const out = []
    for (let i = 0; i < tokens.length; i++) {
        if (!isYear(tokens[i])) { out.push(tokens[i]) }
        if (i + 1 < tokens.length) { out.push(tokens[i] + ' ' + tokens[i + 1]) }
        if (i + 2 < tokens.length) { out.push(tokens[i] + ' ' + tokens[i + 1] + ' ' + tokens[i + 2]) }
    }
    /*  A candidate made only of years is no better than a bare year, and a
        candidate made only of function words is worse than useless. Both
        are judged on the whole phrase: "house of hardy" is a fine rule and
        "of" is not. */
    return [...new Set(out)].filter(phrase => {
        const words = phrase.split(' ')
        return !words.every(isYear) && !words.every(w => FUNCTION_WORDS.has(w))
    })
}

/*
    Proposes rules that would generalise one label.

    label:  { title, verdict }
    corpus: [{ legacyId, title }]           - everything currently tracked
    labels: [{ legacyId, title, verdict }]  - every decision made so far

    Each proposal reports what it would actually do: how many live listings
    it matches, and whether it contradicts anything already labelled. A
    proposal with conflicts is still shown - the conflict is the useful part,
    because it says the phrase is too broad and needs another word.
*/
exports.induce = function (label, corpus, labels, options) {
    const config = Object.assign({ maxProposals: 6, minSupport: 2 }, options || {})
    const all = corpus || []
    const known = (labels || []).filter(l => l.verdict !== VERDICT.UNSURE)

    /*  Never below minSupport, or on a small corpus the cap and the floor
        cross and nothing can ever be proposed. */
    const documentFrequencyCap = Math.max(config.minSupport,
        Math.floor(all.length * MAX_DOCUMENT_FREQUENCY))

    const proposals = []
    for (const phrase of candidates(label.title)) {
        const test = phrasePattern(phrase)

        const matches = all.filter(row => test.test(row.title))
        if (matches.length < config.minSupport) { continue }
        /*  Matches most of the corpus: true of "gold" and "sovereign", and
            a rule on either would empty the market. */
        if (matches.length > documentFrequencyCap) { continue }

        const labelled = known.filter(l => test.test(l.title))
        const agreeing = labelled.filter(l => l.verdict === label.verdict).length
        const conflicts = labelled.filter(l => l.verdict !== label.verdict)

        /*
            The number that decides whether a rule is safe.

            Reach alone cannot tell a good rule from a destructive one:
            "hardy" reaches 35 listings and none of them are being priced,
            because they are all fishing reels; "london" reaches 233 and 97
            of them are sovereigns currently in the market statistics.
            Both look identical on support.
        */
        const breaks = matches.filter(row => row.priced)

        proposals.push({
            phrase,
            support: matches.length,
            breaks: breaks.length,
            breakSamples: breaks.slice(0, 3).map(b => b.title),
            agreement: labelled.length === 0 ? null : agreeing / labelled.length,
            conflicts: conflicts.map(c => c.title),
            samples: matches.slice(0, 5).map(m => m.title),
            words: phrase.split(' ').length
        })
    }

    /*
        Ranked by what makes a rule safe to accept, in order: no
        contradictions, then nothing currently priced destroyed, then reach,
        then the shorter phrase where two reach equally - a shorter rule
        that covers the same listings is the more honest description of why
        they are junk.

        The middle term is bucketed rather than compared numerically, or a
        two-listing rule that breaks nothing would outrank a two-hundred
        listing rule that breaks one.
    */
    proposals.sort((a, b) =>
        (a.conflicts.length - b.conflicts.length) ||
        (Math.min(a.breaks, 1) - Math.min(b.breaks, 1)) ||
        (b.support - a.support) ||
        (a.words - b.words) ||
        (a.phrase.length - b.phrase.length))

    /*  Drop a longer phrase that reaches exactly the listings a shorter,
        already-offered one reaches: it is the same rule wearing more words. */
    const kept = []
    for (const proposal of proposals) {
        const redundant = kept.some(k => k.support === proposal.support &&
            proposal.phrase.includes(k.phrase))
        if (!redundant) { kept.push(proposal) }
        if (kept.length >= config.maxProposals) { break }
    }
    return kept
}

/* ---------------------------------------------------------------- apply */

/*
    A label outranks everything. If a person has said this listing is not a
    sovereign, no amount of classifier confidence should put it back in the
    pricing set - and the reverse matters just as much: a coin they have
    confirmed is genuine must survive a rule that would otherwise drop it,
    or the review queue becomes a place where decisions go to be undone.
*/
exports.apply = function (classification, label) {
    if (label === undefined || label === null) { return classification }

    if (label.verdict === VERDICT.NOT_SOVEREIGN) {
        return {
            /*  In the words of the series it was judged against: "not a
                sovereign" for one, "not a silver dollar" for another. A
                generic phrase would be correct and useless - the reason
                shows on the review queue, where knowing WHICH coin you
                rejected it as is the whole content. Required lazily; the
                registry's packs reach back into this module. */
            excluded: {
                code: 'HUMAN',
                reason: 'You marked this as ' + require('./series/index.js')
                    .resolve(label.series || undefined).vocabulary.notOne.toLowerCase()
            },
            attributes: null,
            confidence: 1,
            needsReview: false,
            reasons: ['Your decision'],
            labelled: true
        }
    }

    if (label.verdict === VERDICT.SOVEREIGN) {
        const attributes = classification.attributes === null
            ? { series: label.series || 'GB.SOV', denomination: null, year: null, portrait: null, mint: null,
                finish: 'BULLION', gradeBand: 'RAW_UNSPECIFIED', gradeDetail: null,
                confidence: { year: 0, denomination: 0, portrait: 0, mint: 0, finish: 0, grade: 0 } }
            : classification.attributes

        if (label.denomination) {
            attributes.denomination = label.denomination
            attributes.confidence.denomination = 1
        }

        /*
            Which pool you put it in, and why that outranks the classifier.

            poolFor() reads a coin's pool off its year, grade band, finish and
            mint - all inferred from the title. It is right most of the time
            and wrong often enough to matter: measured on this store's own
            sold auctions, a full sovereign in the bullion pool clears at
            +9.6% and one in the proof pool at +40.6%, so a coin in the wrong
            pool is a thirty point error in what the tool believes it is
            worth, and it flows into the ceiling of every offer on that type.

            Set here rather than by editing finish or gradeBand, because those
            are evidence and this is a conclusion. A human saying "that is a
            proof" is not claiming to have read the word PROOF in the title -
            they have looked at the picture. Writing the conclusion straight
            into attributes.pool leaves the evidence honestly as it was found
            and lets instruments.keyFor use the answer, which already prefers
            attributes.pool over anything it would derive.
        */
        if (label.pool) {
            attributes.pool = label.pool
            attributes.confidence.pool = 1
        }

        /*  How many coins are in the lot.

            Left alone, this is 1 and nothing changes. Set, it says the lot
            is that many of the same coin, and the spot value it is measured
            against becomes that many coins' worth - which is the only way a
            genuine three-sovereign lot can be priced without pretending it
            is one sovereign at three times the price.

            Not guessed from the title: detectQuantity already does that and
            its answer is to exclude. This is the override. */
        if (Number.isFinite(label.quantity) && label.quantity > 1) {
            attributes.quantity = Math.floor(label.quantity)
        }

        /*  Confirmed genuine, but a denomination is still required before it
            can be priced - spot against the wrong coin is how a real
            sovereign came to read "below spot". Confirming does not mean
            guessing the rest. */
        const priceable = attributes.denomination !== null
        return {
            excluded: null,
            attributes,
            confidence: priceable ? 1 : 0.5,
            needsReview: !priceable,
            reasons: priceable
                ? []
                : ['You confirmed this is a ' +
                   require('./series/index.js').words(label.series).one +
                   ' - which denomination?'],
            labelled: true
        }
    }

    return classification
}
