'use strict'

const FS = require('node:fs')
const PATH = require('node:path')

const ROOT = PATH.resolve(__dirname, '..')

/*
    Configuration. Secrets live in config/settings.json, which is
    gitignored; config/settings.example.json is the committed template.
*/
exports.load = function (explicitPath) {

    const settingsPath = explicitPath || PATH.join(ROOT, 'config', 'settings.json')

    if (!FS.existsSync(settingsPath)) {
        throw new Error(
            'No configuration found at ' + settingsPath + '\n' +
            'Copy config/settings.example.json to config/settings.json and fill it in.\n' +
            'You can run "coin-market demo" with no configuration at all to see the tool work.'
        )
    }

    const settings = JSON.parse(stripComments(FS.readFileSync(settingsPath, 'utf8')))
    /*
        Which coins to go looking for.

        Named explicitly in settings, never discovered by scanning config/ -
        a stray file must not be able to start a sweep, and turning a series
        on should be a decision somebody made on a date rather than a side
        effect of adding a file. Absent, it means sovereigns, which is what
        every installation meant before there was a choice.
    */
    const names = Array.isArray(settings.series) && settings.series.length > 0
        ? settings.series
        : ['sovereign']

    settings.seriesConfigs = names.map(name => {
        const coins = JSON.parse(stripComments(
            FS.readFileSync(PATH.join(ROOT, 'config', 'coins.' + name + '.json'), 'utf8')
        ))
        if (typeof coins.seriesId !== 'string') {
            throw new Error('config/coins.' + name + '.json has no seriesId')
        }
        return { name, id: coins.seriesId, coins }
    })

    settings.databasePath = PATH.resolve(PATH.dirname(settingsPath), settings.database)
    /*  The first series' config, for the call sites written when there was
        only ever one. */
    settings.coins = settings.seriesConfigs[0].coins
    return settings
}

/* Keys beginning with an underscore are prose, not settings. */
function stripComments (text) {
    const parsed = JSON.parse(text)
    return JSON.stringify(prune(parsed))
}

function prune (value) {
    if (Array.isArray(value)) { return value.map(prune) }
    if (value !== null && typeof value === 'object') {
        const out = {}
        for (const [key, inner] of Object.entries(value)) {
            if (key.startsWith('_')) { continue }
            out[key] = prune(inner)
        }
        return out
    }
    return value
}

/*
    A credential still carrying the placeholder text from a copied command
    line. This exists because it happened twice: running an init line with
    the instructions' own "..." or "REAL_APP_ID" in it writes a settings.json
    that looks complete and then fails at the first eBay call, with an auth
    error that names none of this.
*/
const PLACEHOLDER = new RegExp(
    '^(' +
    '\\.{2,}' +                                              /* ...        */
    '|<.*>' +                                                /* <app id>   */
    '|x{3,}' +                                               /* xxxx       */
    '|(your|real|my|the)[-_ ]?(app|cert|dev|client|ru|runame|redirect)?[-_ ]?(id|secret|key|name|url)?' +
    '|(app|cert|dev|client|ru)[-_](id|secret|key|name)' +
    ')$', 'i')

exports.looksUnfilled = function (value) {
    if (value === undefined || value === null) { return true }
    const text = String(value).trim()
    if (text === '') { return true }
    return PLACEHOLDER.test(text)
}

/*
    Values that must survive an "init --force=".

    Two of these are shared with something outside this file the moment a
    setup starts working, and silently regenerating them breaks it:

      * sellerSalt        - every stored seller hash was computed with it. A
                            new salt orphans all of them, so an account
                            deletion notification would purge nothing while
                            still answering eBay 200. The subscription would
                            be honoured in name only, which is the one
                            outcome the whole design exists to avoid.
      * verificationToken - eBay holds a copy. The challenge response is
                            hashed with it, so a new token fails eBay's next
                            validation and the production keyset goes back to
                            disabled.

    endpointUrl, ruName and refreshToken are carried for the milder reason
    that they were work to obtain and nothing regenerates them.

    Pass --regenerate-secrets= to init to deliberately start fresh.
*/
exports.carryForward = function (existing, next) {
    if (existing === null || typeof existing !== 'object') { return next }

    const out = JSON.parse(JSON.stringify(next))
    const worthKeeping = value =>
        value !== undefined && value !== null &&
        String(value).length > 0 && !exports.looksUnfilled(value)

    const kept = []
    if (worthKeeping(existing.sellerSalt)) { out.sellerSalt = existing.sellerSalt; kept.push('sellerSalt') }

    const from = existing.ebay || {}
    const to = out.ebay || (out.ebay = {})
    for (const key of ['ruName', 'refreshToken']) {
        if (worthKeeping(from[key])) { to[key] = from[key]; kept.push('ebay.' + key) }
    }

    const fromDeletion = from.accountDeletion || {}
    const toDeletion = to.accountDeletion || (to.accountDeletion = {})
    for (const key of ['verificationToken', 'endpointUrl']) {
        if (worthKeeping(fromDeletion[key])) {
            toDeletion[key] = fromDeletion[key]
            kept.push('ebay.accountDeletion.' + key)
        }
    }

    Object.defineProperty(out, 'carriedForward', { value: kept, enumerable: false })
    return out
}

exports.ROOT = ROOT
