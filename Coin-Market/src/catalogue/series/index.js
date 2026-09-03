'use strict'

/*
    The series registry.

    A "series" is one family of coins that trades as its own market: British
    sovereigns, Morgan and Peace dollars, gold Britannias. Each is described
    by a pack - a plain object holding everything that is true of that family
    and nothing that is true of coins in general.

    WHY THIS EXISTS. Until now the tool knew about exactly one coin, and said
    so in a dozen places: 'GB.SOV' was a dotted literal in the key builder,
    displayName parsed keys by counting segments, the year parser was bounded
    at 1817 because that is when sovereigns start, and eight of thirteen
    exclusion rules mentioned sovereigns by name. Adding a second coin meant
    editing all of them and hoping.

    THE RULE THIS ENFORCES. A pack never sees another pack's data, and code
    outside a pack never hard-codes a series. So a series can be added by
    writing one file and registering it, and removed by deleting that file -
    which is the whole point, because a family of coins you stop caring about
    should be as cheap to drop as it was to add.

    Keys keep their existing shape: <SERIES>.<POOL>.<DENOMINATION>.<...>,
    where <SERIES> may itself contain dots ('GB.SOV', 'US.MORGAN'). Nothing
    in the store is re-keyed, which is why this is a refactor rather than a
    migration.
*/

const packs = new Map()

/*  Longest id first, so a future 'US.MORGAN_PROOF' can never be mistaken for
    'US.MORGAN' by a prefix match. Recomputed on register rather than sorted
    per lookup: forKey runs once per rendered row. */
let byLength = []

exports.register = function (pack) {
    if (!pack || typeof pack.id !== 'string' || pack.id === '') {
        throw new Error('a series pack needs an id')
    }
    packs.set(pack.id, pack)
    byLength = Array.from(packs.values()).sort((a, b) => b.id.length - a.id.length)
    return pack
}

exports.get = function (id) {
    return packs.get(id) || null
}

exports.all = function () {
    return Array.from(packs.values())
}

/*
    The pack that owns this instrument key, and the rest of the key after its
    id. Returns null for a key no registered series claims.

    Callers must handle null rather than assume the default pack: a key from
    a series that has been dropped is exactly the case where guessing
    produces a confident wrong answer, and this is the function every label
    on every page goes through.
*/
exports.forKey = function (key) {
    if (typeof key !== 'string') { return null }
    for (const pack of byLength) {
        if (key === pack.id) { return { pack, rest: [] } }
        if (key.startsWith(pack.id + '.')) {
            return { pack, rest: key.slice(pack.id.length + 1).split('.') }
        }
    }
    return null
}

/*
    Which series a title belongs to.

    A listing acquires its series from a pack that RECOGNISES it, never from
    the search that found it. reclassify has no memory of which query
    returned a stored listing, so a partition can only ever be a hint - and
    the hint alone must never decide, or a Peace dollar found by the Morgan
    sweep becomes a Morgan and a sovereign found by it becomes one too.

    The outcome is one of:
      { pack, confidence, reasons }         one series claims it
      { pack: null, candidates, reasons }   nobody claims it, or several do

    Two strong claimants go to REVIEW naming both, never to a coin flip. That
    is the case worth being slow about: a Britannia priced as a sovereign is
    invisible until somebody notices the premium looks odd.
*/
const STRONG = 0.8

exports.recognise = function (title, options) {
    const hint = options && options.hint ? packs.get(options.hint) : undefined

    const claims = []
    for (const pack of byLength) {
        if (typeof pack.recognise !== 'function') { continue }
        const claim = pack.recognise(title)
        if (claim && Number.isFinite(claim.confidence) && claim.confidence > 0) {
            claims.push({ pack, confidence: claim.confidence, reasons: claim.reasons || [] })
        }
    }
    claims.sort((a, b) => b.confidence - a.confidence)

    const strong = claims.filter(c => c.confidence >= STRONG)
    if (strong.length === 1) { return strong[0] }
    if (strong.length > 1) {
        return {
            pack: null,
            candidates: strong.map(c => c.pack.id),
            reasons: ['Could be ' + strong.map(c => c.pack.label).join(' or ') + ' - which is it?']
        }
    }

    /*  One weak claim, and the search that found it agrees. Good enough to
        file, not good enough to be quiet about: the caller flags it. */
    if (claims.length === 1 && hint !== undefined && claims[0].pack === hint) {
        return claims[0]
    }
    if (claims.length === 1) { return claims[0] }

    return {
        pack: null,
        candidates: claims.map(c => c.pack.id),
        reasons: claims.length === 0
            ? ['No tracked series recognises this']
            : ['Several series might claim this, none confidently']
    }
}

/*
    The metal a key is priced against.

    Falls back to gold for a key no series claims, because every row in the
    store today is a sovereign and a null would blank every premium on the
    page. That fallback is safe only while gold is the only metal with data;
    the guarantee that keeps it honest lives in spotAt, which returns null
    rather than another metal's price when the one asked for has no ticks.
*/
exports.metalForKey = function (key) {
    const found = exports.forKey(key)
    return found === null ? 'XAU' : found.pack.metal
}

/*
    The pack to assume when a caller has not said which series it means.

    Every listing in the store today is a sovereign and every existing call
    site was written for one, so this keeps them all working unchanged while
    the seams are opened one at a time. It is a migration aid, not a
    permanent feature: once a listing carries its own series, the callers
    should pass a pack and this should become an error.
*/
exports.DEFAULT_ID = 'GB.SOV'

exports.defaultPack = function () {
    const pack = packs.get(exports.DEFAULT_ID)
    if (pack === undefined) { throw new Error('the default series pack is not registered') }
    return pack
}

/*  Resolve whatever a caller passed: a pack, an id, or nothing. */
exports.resolve = function (packOrId) {
    if (packOrId === null || packOrId === undefined) { return exports.defaultPack() }
    if (typeof packOrId === 'string') {
        const found = packs.get(packOrId)
        if (found === undefined) { throw new Error('unknown series: ' + packOrId) }
        return found
    }
    return packOrId
}

/*
    What to CALL a coin, for anything a person reads.

    Every pack has declared a `vocabulary` since the packs were written, and
    until now exactly one line in the codebase read it. Twenty-odd others
    spelled "sovereign" into the page instead, so a Morgan dollar sat under a
    button saying "Not a sovereign" and a per-row control saying "Not a sov".

    IT TAKES WHAT THE CALLER ACTUALLY HAS. That is the whole reason the field
    went unused: a bulk bar has an array of rows, a review row has a series, a
    drill-down has an instrument key, and a proposal has a pack. Asking each
    of those to resolve a pack first is the friction that made hard-coding the
    word easier, so this resolves all four.

    THREE OUTCOMES, AND NONE OF THEM IS "SOVEREIGN". One pack, its words;
    several packs, the mixed words; nothing recognisable, the mixed words.
    That last is the important one - the front page's panels draw across every
    series by construction, so there is no single right coin name for the
    button above them, and inventing one would be a lie rather than a
    default. `mixed` is exposed so a caller can tell the two apart.
*/
const MIXED = {
    one: 'this coin',
    /*  Deliberately not "Not a coin": these buttons reject a listing for
        being something other than what it claims, which includes perfectly
        real coins of the wrong type. */
    notOne: 'Not what it says it is',
    plural: 'these coins',
    label: 'Coins',
    mixed: true
}

function packFrom (hint) {
    if (hint === null || hint === undefined) { return null }
    if (typeof hint === 'object' && typeof hint.id === 'string' && hint.vocabulary) { return hint }
    if (typeof hint === 'string') {
        /*  A series id, or an instrument key that begins with one. `get`
            first, because an id is also a valid prefix of itself and
            forKey's scan is the slower answer to the same question. */
        const direct = exports.get(hint)
        if (direct !== null) { return direct }
        const found = exports.forKey(hint)
        return found === null ? null : found.pack
    }
    if (typeof hint === 'object') {
        /*  A row. The same chain the plausibility cell already walks: what
            the listing was attributed to, then what it was filed under, then
            what the classifier guessed. */
        return packFrom(hint.series) || packFrom(hint.instrumentKey) || packFrom(hint.bestGuess)
    }
    return null
}

exports.words = function (hint) {
    const hints = Array.isArray(hint) ? hint : [hint]
    const found = new Set()
    for (const one of hints) {
        const pack = packFrom(one)
        if (pack !== null) { found.add(pack) }
    }
    if (found.size !== 1) { return MIXED }
    const pack = [...found][0]
    const vocabulary = pack.vocabulary || {}
    /*  A pack missing a word gets the mixed one rather than a sovereign one.
        The pack contract will make this unreachable; until then it must not
        fail back to the series the tool started with. */
    return {
        one: vocabulary.one || MIXED.one,
        notOne: vocabulary.notOne || MIXED.notOne,
        plural: vocabulary.plural || MIXED.plural,
        label: pack.label || MIXED.label,
        mixed: false
    }
}

exports.MIXED_WORDS = MIXED

/*  Registered here rather than by each caller, so requiring the registry is
    enough to have the tool's series available and there is no order-of-
    require hazard. New packs are added to this list. */
exports.register(require('./sovereign.js'))
exports.register(require('./morgan.js'))
