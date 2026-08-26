'use strict'

/*
    OAuth for eBay.

    Two token types, and the distinction matters for what this tool can do
    without you:

      application token  - client credentials, no user consent. Enough for
                           ALL Browse discovery and snapshotting, which is
                           the entire active-market picture. The tool is
                           useful with nothing but this.

      user token         - authorization code grant, needs a RuName. Only
                           required to mirror your watch list via the
                           Trading API. Its refresh token lasts ~18 months,
                           so consent is a rare event, not a daily chore.
*/

const PRODUCTION = {
    oauth: 'https://api.ebay.com/identity/v1/oauth2/token',
    browse: 'https://api.ebay.com/buy/browse/v1',
    trading: 'https://api.ebay.com/ws/api.dll',
    taxonomy: 'https://api.ebay.com/commerce/taxonomy/v1',
    analytics: 'https://api.ebay.com/developer/analytics/v1_beta'
}

const SANDBOX = {
    oauth: 'https://api.sandbox.ebay.com/identity/v1/oauth2/token',
    browse: 'https://api.sandbox.ebay.com/buy/browse/v1',
    trading: 'https://api.sandbox.ebay.com/ws/api.dll',
    taxonomy: 'https://api.sandbox.ebay.com/commerce/taxonomy/v1',
    analytics: 'https://api.sandbox.ebay.com/developer/analytics/v1_beta'
}

exports.endpointsFor = function (environment) {
    return environment === 'sandbox' ? SANDBOX : PRODUCTION
}

const APPLICATION_SCOPE = 'https://api.ebay.com/oauth/api_scope'

exports.newAuth = function (credentials, options) {

    const config = Object.assign({ environment: 'production' }, options || {})
    const endpoints = exports.endpointsFor(config.environment)

    let applicationToken = null          /* { value, expiresAt } */
    let userToken = null

    function basicHeader () {
        const pair = credentials.clientId + ':' + credentials.clientSecret
        return 'Basic ' + Buffer.from(pair).toString('base64')
    }

    async function requestToken (body) {
        const response = await fetch(endpoints.oauth, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization: basicHeader()
            },
            body: new URLSearchParams(body).toString()
        })
        const payload = await response.json().catch(() => ({}))
        if (!response.ok) {
            throw new Error('eBay OAuth failed (' + response.status + '): ' +
                (payload.error_description || payload.error || 'unknown error'))
        }
        return {
            value: payload.access_token,
            /* Refresh a minute early - a token that expires mid-flight
               turns into a confusing 401 halfway through a sweep. */
            expiresAt: Date.now() + (payload.expires_in - 60) * 1000,
            /* Only present on the authorization_code exchange, and it is
               the whole point of that call - the access token expires in
               two hours, this one lasts ~18 months. */
            refreshToken: payload.refresh_token
        }
    }

    return {
        endpoints,

        async applicationToken () {
            if (applicationToken !== null && applicationToken.expiresAt > Date.now()) {
                return applicationToken.value
            }
            applicationToken = await requestToken({
                grant_type: 'client_credentials',
                scope: credentials.scopes || APPLICATION_SCOPE
            })
            return applicationToken.value
        },

        async userToken () {
            if (userToken !== null && userToken.expiresAt > Date.now()) {
                return userToken.value
            }
            if (!credentials.refreshToken) {
                throw new Error(
                    'No eBay refresh token configured. The watch-list mirror needs a user token; ' +
                    'run "coin-market auth-url" to start the consent flow. ' +
                    'Discovery and pricing work without it.'
                )
            }
            userToken = await requestToken({
                grant_type: 'refresh_token',
                refresh_token: credentials.refreshToken,
                scope: credentials.userScopes || APPLICATION_SCOPE
            })
            return userToken.value
        },

        /* The consent URL you open once in a browser to authorise the app. */
        consentUrl (state) {
            const base = config.environment === 'sandbox'
                ? 'https://auth.sandbox.ebay.com/oauth2/authorize'
                : 'https://auth.ebay.com/oauth2/authorize'
            const params = new URLSearchParams({
                client_id: credentials.clientId,
                redirect_uri: credentials.ruName,
                response_type: 'code',
                scope: credentials.userScopes || APPLICATION_SCOPE
            })
            if (state !== undefined) { params.set('state', state) }
            return base + '?' + params.toString()
        },

        /* Exchanges the ?code= from the consent redirect for a refresh
           token, which is what gets stored. */
        async exchangeCode (code) {
            const token = await requestToken({
                grant_type: 'authorization_code',
                code,
                redirect_uri: credentials.ruName
            })
            if (token.refreshToken === undefined) {
                throw new Error('eBay returned no refresh token for that code. ' +
                    'Consent codes are single-use and expire quickly - request a fresh one.')
            }
            return token
        }
    }
}

exports.APPLICATION_SCOPE = APPLICATION_SCOPE
