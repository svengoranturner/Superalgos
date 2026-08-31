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
        /*  "ring" was previously only matched next to "size" or "mount",
            which missed 55 live listings - "Gold Sovereign Ring", "1982
            Proof Half Sovereign Ring". A ring is a ring wherever the word
            appears, and the same goes for the Sovereign-brand watches and
            the 14k coin bezels. */
        test: /\b(9\s?ct|mount(ed|s)?|pendant|necklace|chain|bracelet|brooch|cufflink|earring|ring|bezel|watch|wristwatch|jewellery|jewelry)\b/i
    },
    {
        code: 'ACCESSORY',
        reason: 'Case, capsule or holder rather than a coin',
        /*  Plurals matter here and cost real money. "*No Coins*" and "Without
            Gold Sovereign's" are both empty boxes that reached the live
            opportunities panel, and both slipped a rule written in the
            singular. */
        /*  Plurals, again. The trailing word boundary meant "Capsules" never
            matched "capsule" at all, so a listing selling ten of them read
            as a coin. Same shape of bug as "*No Coins*" and "Without Gold
            Sovereign's" - it is worth checking every noun in this file
            pluralises. */
        test: /\b(capsules?|coin\s+cases?|sovereign\s+cases?|display\s+cases?|display\s+box(es)?|presentation\s+cases?|holders?|albums?|empty|no\s+coins?|without\s+(the\s+)?(gold\s+)?sovereigns?)\b/i
    },
    {
        code: 'NOT_A_COIN',
        reason: 'Publication, ephemera or memorabilia',
        /* Found in the live bullion pool: a 1982 Ipswich Speedway programme
           at GBP 3, a first edition of Marsh's book on the sovereign at GBP
           104. Both contain the word "sovereign" and neither is a coin, and
           at those prices they drag a premium median downwards as hard as a
           rarity drags it up. */
        /*  "Hardy Gold Sovereign" is a fly reel, and there were 27 of them
            in the pricing set. Sporting goods sit in their own category
            tree, so the ancestry test would have caught them had eBay's
            path been populated on every row - it is not, and a listing with
            no path fails open by design. */
        test: /\b(programme|program|book|1st\s+edition|first\s+edition|paperback|hardback|magazine|catalogue|catalog|leaflet|poster|postcard|newspaper|ticket|speedway|racecard|marsh|spink|krause|sunglasses|t-shirt|tshirt|hoodie|mug|spoon|plate|platter|saucer|reel|spool|fly\s?rod|fishing|tackle)\b/i
    },
    {
        code: 'NOT_A_SOVEREIGN',
        reason: 'Gold, but not a sovereign',
        /*  Fineness is decisive and needs no keyword list. A sovereign is
            22ct - 916 fine - by definition, so a title claiming 24ct or
            .999 is describing something else: a Umicore bar, an Alderney
            proof, a 1/20oz Britannia, a Pitcairn ten dollars. All 22 live
            matches were checked by hand and none was a sovereign.

            The loose form "999" is deliberately absent. It matches mintage
            figures - "(999 mintage)", "Mintage 999" - and would have
            deleted two genuine sovereigns. Only the decimal forms and an
            explicit fineness word count. */
        /*  No leading \b on the decimal form: sellers write ".9999" after a
            space, and a boundary between two non-word characters does not
            exist, so "\b\.999" silently matched "0.999" and never ".9999". */
        test: /\b24\s?(ct|k|kt|carat)\b|\.999\d?\b|\b999\.9\b|\b999\s*(fine|purity)\b|\b(bars?|ingots?|wafer)\b|\b(umicore|pamp|valcambi|metalor|heraeus|argor)\b|\bguineas?\b|\bbritannia\b/i
    },
    {
        code: 'NOVELTY',
        reason: 'A souvenir copy, not a coin',
        /*  "2023 Gold-Coloured Sovereign Style Coins St George & the Dragon
            (10pcs)" reached the live opportunities panel at GBP 710 with a
            13% edge. Ten of them, gold-COLOURED, sovereign-STYLE. The
            existing COUNTERFEIT rule looks for copy/replica/fake and none of
            those words appear - the seller is not claiming they are coins,
            and is not hiding it either. */
        test: /\bgold[\s-]?colou?red\b|\bsovereign\s+style\b|\bstyle\s+coins?\b|\b\d+\s?pcs\b|\bnovelty\b|\bsouvenir\b/i
    },
    {
        code: 'PICK_YOUR_COIN',
        reason: 'One listing covering several different coins',
        /*  "2026 Royal Mint Sovereign Range Sets & Singles - CHOOSE YOUR
            COIN!" is a variation listing: the price shown is whichever
            variant is cheapest, and the coin is whichever you pick. There is
            no single coin to price, so the headline price belongs to a
            quarter while the title says sovereign - which is exactly how it
            came to show a 10.9% edge. */
        test: /\bchoose\s+your\b|\bselect\s+your\b|\byour\s+choice\b|\bpick\s+your\b|\bsets?\s*(&|and)\s*singles?\b|\brange\s+sets?\b|\bmultiple\s+(years|dates)\b|\bany\s+year\b/i
    },
    {
        code: 'FANTASY_ISSUE',
        reason: 'A coin that was never struck as a sovereign',
        /*  There is no Edward VIII sovereign. He abdicated before any
            circulating coinage was issued; the handful of 1937 patterns are
            seven-figure museum pieces that will never appear in a search
            like this one. Every "Edward VIII sovereign" on the market is a
            private fantasy strike - the live examples were a 1984 Straits
            piece and a 1984 Gibraltar piece, both slabbed by NGC, which
            grades fantasy issues as readily as coins.

            Three live matches, all fantasy. If a genuine pattern ever does
            appear it will be excluded and this reason will say why, which
            is the right way round for something that cannot be priced from
            comparables anyway. */
        test: /\bedward\s*(viii|8th)\b/i
    },
    {
        code: 'SUB_SOVEREIGN',
        reason: 'Smaller than a quarter - not a sovereign denomination',
        /*  The Royal Mint's smallest sovereign is the quarter. Eighths,
            tenths and hundredths are private issues from Hattons and the
            London Mint that borrow the name; 94 of them were sitting in the
            review queue with no denomination, permanently, because the
            classifier could only refuse to price them rather than say why.

            Bounded to fractions the series does not mint and required to
            sit near the word, so a limited-edition number like "1/50" is
            not mistaken for a denomination. */
        test: /(\b1\s*\/\s*([5-9]|1\d|20|100)\s*(th|nd|rd|st)?\b|[⅛⅑⅒]|\b(one[\s-])?(eighth|tenth|sixteenth|twentieth|hundredth)\b)[\s\-\w.,'()&]{0,32}?sov/i
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
        /*  Sellers spell the count out far more often than they use a
            digit - "Three-Coin Set", "Four-coin Sovereign Collection" - and
            the digit-only form missed 28 live multi-coin lots, each of
            which was being priced as a single sovereign. */
        test: /\b(job\s?lot|bulk|collection\s+of|set\s+of|\d+\s?[x×]\s?(?:gold\s+)?(?:full\s+|half\s+)?sovereign|sovereign\s+set|sovereign\s+collection|coins\s+sovereign|sovereign\s+lot|[3-9][-\s]coin|(two|three|four|five|six|seven|eight|nine|ten)[-\s]?coin)\b/i
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
exports.screenCategory = function (categoryPath) {
    if (categoryPath === undefined || categoryPath === null || categoryPath === '') { return null }

    if (/\bcoins?\b|\bbullion\b/i.test(categoryPath)) { return null }

    /*  Reported with the path, because a false positive here silently
        deletes a whole class of listing and the path is what makes it
        diagnosable from the review queue. */
    return {
        code: 'NOT_A_COIN_CATEGORY',
        reason: 'Not listed in a coin category (' + categoryPath + ')'
    }
}

/*
    Where the coin is.

    OFF BY DEFAULT, and that default is the whole point.

    Screening on location looks obviously right - a lot in Cyprus is a
    different market from one in Birmingham - and it is a trap. Turned on
    for GB alone it removed 1,268 genuine sovereigns from the pricing set in
    a single pass, 744 of them Australian: Sydney, Melbourne and Perth mint
    coins are British sovereigns and the scarcest part of the series. Rare
    1859, 1863 and 1867 Sydney sovereigns went with them.

    That is the same mistake migration 004 documents at the category level,
    where an allow-list of leaf categories discarded 2,491 Australian
    sovereigns. Same error, different column, one screen later.

    So `allowed` must be passed by a caller that has decided to filter and
    knows what it costs. With no allow-list this screens nothing, and an
    unknown country is never treated as foreign. The country is stored and
    shown on the listing either way, which is what actually answers "where
    is this?" without deciding it on your behalf.
*/
exports.screenLocation = function (country, allowed) {
    if (allowed === undefined || allowed === null || allowed.length === 0) { return null }
    if (country === undefined || country === null || country === '') { return null }
    if (allowed.map(c => String(c).toUpperCase()).includes(String(country).toUpperCase())) { return null }

    return {
        code: 'NOT_ALLOWED_COUNTRY',
        reason: 'Listed outside your chosen countries (' + String(country).toUpperCase() + ')'
    }
}

/*
    What a coin is NOT, and what it came in.

    Two ways a title can trip a rule by saying the opposite of what the rule
    is looking for, and both were costing us the most valuable rows in the
    store - completed auctions with real hammer prices:

      "Never Cleaned Or Mounted"     - a selling point, and the strongest
                                       possible statement that this coin is
                                       not jewellery. Three sovereigns that
                                       sold for GBP 809, 829 and 861 with 7,
                                       15 and 28 bids were dropped on the
                                       word "mounted".
      "Full Sovereign 22ct in Capsule" - a capsule is what the coin arrived
                                       in, not what is being sold. Two more
                                       sales lost, GBP 795 and GBP 405.

    So these phrases are removed before the rules run. A listing whose only
    mention of a capsule is "in capsule" no longer reads as an empty capsule;
    one actually selling capsules still says "coin capsules" and still trips.
*/
const NEGATED = /\b(never|not|un|non)[\s-]*(been\s+)?(cleaned\s*(,|\/|or|and)?\s*)?(mounted|mount|polished)\b/gi
const PACKAGING = /\b(in|with|inc|includes|including)\s+(a\s+|its\s+|the\s+|original\s+)*(capsule|case|box|holder|wallet|pouch)e?s?\b|\bcapsuled\b|\bboxed\b/gi

exports.readableAs = function (title) {
    return String(title).replace(NEGATED, ' ').replace(PACKAGING, ' ')
}

exports.screen = function (title, aspects) {

    /*  Read the title with its negations and packaging removed, so a coin
        described as "never mounted, in capsule" is not dropped for being a
        mounted capsule. */
    const readable = exports.readableAs(title)

    for (const rule of RULES) {
        if (rule.test.test(readable)) { return { code: rule.code, reason: rule.reason } }
    }

    /*  Quantity is counted on the original: "3 x Sovereign in capsules" is
        still three coins, and the scrub would have eaten the plural. */
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
