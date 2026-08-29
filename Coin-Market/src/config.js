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
    const coins = JSON.parse(stripComments(
        FS.readFileSync(PATH.join(ROOT, 'config', 'coins.sovereign.json'), 'utf8')
    ))

    settings.databasePath = PATH.resolve(PATH.dirname(settingsPath), settings.database)
    settings.coins = coins
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

exports.ROOT = ROOT
