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
