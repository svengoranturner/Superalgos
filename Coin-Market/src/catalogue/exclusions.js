'use strict'

/*
    Exclusion rules.

    Every downstream statistic is only as good as this file. A mounted
    pendant, a brass copy or a five-coin job lot that leaks into the sample
    does not merely add noise - it biases the clearing price in a specific
    direction and produces a confident, wrong answer. That is worse than no
    tool at all, so exclusions run BEFORE classification and a listing that
    trips one is never priced.

    Each rule carries a reason so the dashboard can show why something was
    dropped, and so a false positive is diagnosable rather than invisible.
*/

const RULES = [
    {
        code: 'COUNTERFEIT',
        reason: 'Copy, replica or fantasy piece',
        /* "restrike" is deliberately absent: official Royal Mint restrikes
           (e.g. the 1925-dated sovereigns struck later) are genuine coins. */
        test: /\b(copy|copies|replica|reproduction|fantasy|imitation|tribute|not\s+gold|non[-\s]?gold|fake)\b/i
    },
    {
        code: 'NOT_GOLD',
        reason: 'Base metal or plated',
        test: /\b(brass|gilt|gold[-\s]?plated|plated|silver[-\s]?gilt|clad)\b/i
    },
    {
        code: 'JEWELLERY',
        reason: 'Mounted, or sold as jewellery',
        /* 9ct is decisive: a sovereign is 22ct, so 9ct in the title refers
           to the mount, not the coin. */
        test: /\b(9\s?ct|mount(ed|s)?|pendant|necklace|chain|bracelet|brooch|cufflink|earring|ring\s+(?:size|mount)|jewellery|jewelry)\b/i
    },
    {
        code: 'ACCESSORY',
        reason: 'Case, capsule or holder rather than a coin',
        test: /\b(capsule|coin\s+case|sovereign\s+case|display\s+case|display\s+box|presentation\s+case|holder|album|empty|no\s+coin)\b/i
    },
    {
        code: 'NOT_A_COIN',
        reason: 'Publication, ephemera or memorabilia',
        /* Found in the live bullion pool: a 1982 Ipswich Speedway programme
           at GBP 3, a first edition of Marsh's book on the sovereign at GBP
           104. Both contain the word "sovereign" and neither is a coin, and
           at those prices they drag a premium median downwards as hard as a
           rarity drags it up. */
        test: /\b(programme|program|book|1st\s+edition|first\s+edition|paperback|hardback|magazine|catalogue|catalog|leaflet|poster|postcard|newspaper|ticket|speedway|racecard)\b/i
    },
    {
        code: 'ABOUT_A_SOVEREIGN',
        reason: 'A different coin that merely depicts or commemorates the sovereign',
        /* "2009 UK GBP 2 Two Pounds Coin - Anniversary of the Gold Sovereign"
           is a two-pound commemorative, not a sovereign. Worded to avoid the
           genuine Double Sovereign, which is "two pound SOVEREIGN" rather
           than "two pounds COIN". */
        test: /\b(two\s+pounds\s+coin|2\s*pound\s+coin)\b|\banniversary\s+of\s+the\s+(gold\s+)?sovereign\b/i
    },
    {
        code: 'MEDAL',
        reason: 'Medal or token, not legal tender',
        test: /\b(medal|medallion|token|crown[-\s]?sized)\b/i
    },
    {
        code: 'PROOF_SET_OR_BUNDLE',
        reason: 'Multi-coin set or job lot',
        test: /\b(job\s?lot|bulk|collection\s+of|set\s+of|\d+\s?[x×]\s?(?:gold\s+)?(?:full\s+|half\s+)?sovereign|sovereign\s+set|3[-\s]coin|4[-\s]coin|5[-\s]coin)\b/i
    }
]

/*
    Quantity detection. Multi-coin lots are excluded from per-coin pricing
    rather than divided through: the per-coin price of a job lot is not
    comparable to a single-coin sale (bulk discounts, mixed dates, and the
    buyer pool is different).
*/
const QUANTITY_PATTERNS = [
    /\b(\d+)\s?[x×]\s?(?:gold\s+)?(?:full\s+|half\s+)?sovereign/i,
    /\bsovereign\s?[x×]\s?(\d+)\b/i,
    /\b(two|three|four|five|six|ten)\s+(?:gold\s+)?sovereigns\b/i
]

const WORD_NUMBERS = { two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 }

exports.detectQuantity = function (title) {
    for (const pattern of QUANTITY_PATTERNS) {
        const match = title.match(pattern)
        if (match === null) { continue }
        const raw = match[1].toLowerCase()
        const value = WORD_NUMBERS[raw] !== undefined ? WORD_NUMBERS[raw] : parseInt(raw, 10)
        if (Number.isFinite(value) && value > 1) { return value }
    }
    /* A bare plural is weak evidence, but combined with "lot" it is enough. */
    if (/\bsovereigns\b/i.test(title) && /\b(lot|bundle|pair)\b/i.test(title)) { return 2 }
    return 1
}

/*
    Returns null when the listing is acceptable, or {code, reason} when it
    must be dropped.
*/
/*
    eBay's own leaf category, which is far better evidence than the title.

    A title regex can only ever chase the last thing that went wrong. The
    seller has already told eBay what kind of thing they are listing, and
    that answer sits on every row: a Royal Doulton coffee cup is in pottery
    (262372), a "Sovereign" wristwatch is in watches (31387), a sovereign
    ring is in jewellery (261994). None of them are in a coin category, and
    no amount of title matching would reliably have caught the cup while
    still admitting a genuine coin whose title happens to mention china.

    Fails open on purpose. An empty allow-list means the categories have not
    been enumerated yet - "coin-market categories" does that - and screening
    everything out because we have not looked is far worse than screening
    nothing.
*/
exports.screenCategory = function (categoryId, allowedIds) {
    if (allowedIds === undefined || allowedIds === null) { return null }
    const allowed = allowedIds instanceof Set ? allowedIds : new Set((allowedIds || []).map(String))
    if (allowed.size === 0) { return null }
    if (categoryId === undefined || categoryId === null || categoryId === '') { return null }

    if (allowed.has(String(categoryId))) { return null }
    return { code: 'NOT_A_COIN_CATEGORY', reason: 'Listed outside the coin categories (eBay category ' + categoryId + ')' }
}

exports.screen = function (title, aspects) {

    for (const rule of RULES) {
        if (rule.test.test(title)) { return { code: rule.code, reason: rule.reason } }
    }

    if (exports.detectQuantity(title) > 1) {
        return { code: 'MULTI_LOT', reason: 'More than one coin in the lot' }
    }

    /* Structured aspects override title guesswork when they contradict it. */
    if (aspects !== undefined && aspects !== null) {
        const composition = aspects.Composition || aspects.composition
        if (composition !== undefined && /silver|copper|nickel|brass|bronze/i.test(composition) &&
            !/gold/i.test(composition)) {
            return { code: 'NOT_GOLD', reason: 'Composition aspect is not gold' }
        }
    }

    return null
}

exports.RULES = RULES
