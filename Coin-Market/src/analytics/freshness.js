'use strict'

/*
    How recently a sweep must have seen a lot before the tool will tell you
    to go and spend money on it.

    A Buy-It-Now listing is the problem. It carries no end time, and its
    outcome is never resolved (COL-01), so neither of the two things that
    normally retire a lot applies to it: last_seen is the ONLY evidence that
    it still exists. The store keeps a lot "active" for 24 hours after it was
    last seen, which is right for counting asks into a median - a slightly
    stale sample barely moves one - and wrong for a panel that prints a price
    to type into eBay.

    What that cost: the owner opened the offers panel and the lot ranked
    FIRST had last been seen 21.3 hours earlier and had already sold. The
    ranking made it worse rather than better, because the panel ranks by
    closeness to the bid ceiling and a lot that has already sold is exactly
    the lot most likely to look keenly priced. The best-looking suggestions
    were the deadest ones.

    Two hours, chosen from the store rather than from intuition. The sweep
    runs hourly and sees a stable ~6,510 listings each time, so it is not
    rotating through a subset - an absence is evidence. Measured over 237,850
    gaps between consecutive observations of a listing that was later seen
    again (i.e. periods a live lot went unseen): p50 0.33h, p90 1.00h,
    p99 2.04h. Only 2.3% of those gaps exceed two hours, so a two-hour rule
    wrongly hides a live lot about that often. Against that, of the lots that
    HAVE missed a sweep, 63% are still alive after one and 43% after two - so
    beyond two hours a majority of what is shown is gone.

    It is close to free. Corpus freshness never fell below 92.5% at any hour
    boundary across a full retained day, and the panel shows 20 rows out of
    ~87 candidates, so the cut removed no displayed row at any hour that
    could be measured. It buys correctness with rows nobody was reading.

    Deliberately NOT applied to the statistics. medianAskPremium, fair value,
    sell-through and the instrument table keep the 24-hour window: they are
    describing a market, not sending you to a checkout, and narrowing their
    sample to buy precision they do not need would trade a real cost for no
    gain.
*/
const ACTIONABLE_HOURS = 2

exports.ACTIONABLE_HOURS = ACTIONABLE_HOURS

const HOUR_MS = 60 * 60 * 1000

/* Hours since a sweep last saw this lot, or null if we never recorded it. */
exports.hoursSince = function (lastSeen, now) {
    if (!lastSeen) { return null }
    const then = Date.parse(lastSeen)
    if (!Number.isFinite(then)) { return null }
    const at = now === undefined ? Date.now() : now
    return (at - then) / HOUR_MS
}

/*
    Whether a lot is fresh enough to act on.

    An unknown last_seen fails OPEN rather than closed. Every row the store
    holds has one, so this only fires on a caller that forgot to select the
    column - and silently emptying a panel is a worse failure than showing a
    stale row, because the empty panel looks like a true "nothing to see".
*/
exports.isActionable = function (lastSeen, now, hours) {
    const age = exports.hoursSince(lastSeen, now)
    if (age === null) { return true }
    return age <= (hours === undefined ? ACTIONABLE_HOURS : hours)
}

/* How long ago, for a human. Deliberately coarse: the exact minute is not
   the point, "is this current" is. */
exports.describe = function (lastSeen, now) {
    const age = exports.hoursSince(lastSeen, now)
    if (age === null) { return null }
    if (age < 0.03) { return 'seen just now' }
    if (age < 1) { return 'seen ' + Math.round(age * 60) + ' min ago' }
    if (age < 24) { return 'seen ' + Math.round(age) + 'h ago' }
    return 'seen ' + Math.round(age / 24) + 'd ago'
}
