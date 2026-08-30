'use strict'

/*
    eBay's own view of how much of the daily call quota is left.

    budget.js keeps a local count, and a local count can only ever be an
    estimate. Retries, timeouts and anything else that spends a call without
    returning cleanly all drift it, always in the optimistic direction.

    Worse, the two clocks disagree. The local counter rolls at UTC midnight;
    eBay's Browse window resets at 07:00 UTC. So for seven hours every day the
    local count reads as a fresh 5,000 while eBay is still charging against the
    previous window. At the observed rate - roughly 4,600 calls a day, ~92% of
    the limit - that gap is enough to exhaust the real quota in the small hours
    and spend the rest of the window rejected, losing exactly the auction
    closes the collector exists to watch.

    budget.reconcile() was written for this and never called. This is the
    other half of it.
*/
exports.browseRemaining = async function (auth, fetchImpl) {
    const doFetch = fetchImpl || fetch
    const token = await auth.applicationToken()

    const response = await doFetch(auth.endpoints.analytics + '/rate_limit/', {
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' }
    })
    if (!response.ok) { return null }

    const payload = await response.json()
    /*  Production keys this by apiName "Browse" with resource "buy.browse".
        Matching only one of the two makes the reader depend on which of them
        eBay happens to spell that way, and a reader that silently finds
        nothing here degrades to the local estimate - the exact failure this
        module exists to prevent. So match either. */
    const browse = (payload.rateLimits || [])
        .flatMap(api => (api.resources || []).map(resource => ({
            api: api.apiName, resource: resource.name, rates: resource.rates
        })))
        .find(entry => /browse/i.test(entry.api || '') || /browse/i.test(entry.resource || ''))

    if (browse === undefined) { return null }

    const remaining = (browse.rates || [])
        .map(rate => rate.remaining)
        .filter(value => Number.isFinite(value))

    if (remaining.length === 0) { return null }

    /*  eBay returns more than one row for the same resource - production
        answered with both 4960 and 5000 for Browse on the same call. Believe
        the lower one: over-counting costs a few calls, under-counting costs
        the window. */
    return Math.min(...remaining)
}
