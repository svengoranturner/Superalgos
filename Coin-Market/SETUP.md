# Setting up eBay access

Everything here is free. The whole sequence is roughly an hour of clicking plus
a day of waiting for registration.

The tool is built so that **step 3 alone gives you a working product** —
discovery, classification, snapshots and the uplift curve. Steps 4–6 add final
sale prices, which is where the clearing premiums come from.

---

## 1. Register

<https://developer.ebay.com> → join the eBay Developers Program. Free, usually
approved within a business day.

You end up on **Your Account → Application Keys**, holding two *separate*
keysets:

| | Sandbox | Production |
|---|---|---|
| App ID | = OAuth **Client ID** | = OAuth **Client ID** |
| Cert ID | = OAuth **Client Secret** | = OAuth **Client Secret** |
| Dev ID | | |

Sandbox works immediately. Production does not — see step 2.

## 2. Clear the account-deletion gate (this is the one that blocks you)

**Your production keyset stays inert until you either subscribe to eBay
Marketplace Account Deletion notifications or are granted an exemption.** It must
be done *before your first production API call*. The failure mode looks like
broken credentials rather than a missing compliance step, which is why people
lose a day to it.

This tool subscribes properly, and honours the notifications: seller identifiers
are stored as a salted hash rather than discarded, so the hash can be recomputed
from the username eBay sends and the matching rows genuinely deleted.

```bash
node bin/cli.js notify-token          # generate a verification token
```

Put that token in `config/settings.json`:

```json
"accountDeletion": {
  "endpointUrl": "https://metalhead.gold/ebay/account-deletion",
  "verificationToken": "<the generated token>",
  "host": "127.0.0.1",
  "port": 34261
}
```

Run the endpoint and put your reverse proxy in front of it:

```bash
node bin/cli.js notify-endpoint
```

Then in eBay's **Application Keys → Marketplace account deletion** form, enter
the same URL and the same token, and submit. eBay immediately GETs your URL with
a `challenge_code` and expects `SHA-256(challenge + token + url)` back as JSON.

Check it yourself first:

```bash
node bin/cli.js notify-check
```

**Two things break this, and eBay's error message names neither:**

- **The endpoint URL is part of the hash.** It must match byte for byte between
  `settings.json` and the eBay form — a trailing slash, `http` vs `https`, or a
  `www.` is enough to fail validation.
- **The path must not sit behind an auth gate.** eBay calls it
  unauthenticated, so if metalhead.gold is behind Cloudflare Access you need a
  **bypass rule for `/ebay/account-deletion`** or the challenge never reaches
  the process.

## 3. Application token — you now have a working tool

Put the production App ID and Cert ID into `config/settings.json` as `clientId`
and `clientSecret`. That is enough for the Browse API: discovery, classification,
snapshots, and the closing-uplift curve.

```bash
node bin/cli.js doctor
```

## 4. RuName (only needed for final sale prices)

The Trading API — outcome resolution and the watch-list mirror — needs a *user*
token, which needs a RuName.

**Application Keys → User Tokens** (next to your Client ID) → add a redirect URL.
You will be asked to confirm your legal contact details, then for a privacy
policy URL and accept/decline URLs. Any https pages you control will do;
metalhead.gold is fine.

A RuName is **not a URL** — it is an identifier eBay generates, looking like
`Your-App-Name-abcd-efgh`. That string goes in `settings.json` as `ruName`.
Sandbox and production get **different RuNames**.

## 5. Consent, once every 18 months

```bash
node bin/cli.js auth-url        # prints the consent URL; open it, approve
```

eBay redirects to your accept URL with `?code=...` in the address bar. Nothing
needs to be listening — just copy the code out of the bar:

```bash
node bin/cli.js auth-code '<the code>'
```

That prints a refresh token good for about 18 months. Put it in `settings.json`
as `refreshToken`. The access tokens it mints last two hours and the tool
refreshes them itself.

Consent codes are single-use and expire in minutes — if the exchange fails, get
a fresh one.

## 6. Verify the assumption everything rests on

```bash
COIN_MARKET_PROBE_ITEM=<an ended eBay item number> node bin/cli.js doctor
```

Take any ended sovereign auction on ebay.co.uk and copy the 12-digit number from
its URL.

The third check is the load-bearing one: **does Trading `GetItem` return final
prices for listings you do not own?** The whole outcome-resolution design rests
on it, and it is the one thing I could not confirm from eBay's documentation. If
it fails, the tool falls back to the last snapshot before close — less exact, but
it still works, which is why the resolver sits behind an interface.

`doctor` also reports whether Browse search results carry `bidCount`. If they do
not, snapshotting gets ~200× more expensive and the call budget needs replanning.

## 7. Point it at your gold feed

```json
"spot": {
  "type": "sqlite",
  "path": "/home/pi/metalhead/data/prices.db",
  "table": "spot_prices",
  "columns": { "observedAt": "timestamp", "gbpPerOz": "gbp_per_oz" }
}
```

Reads the metals.dev feed the portfolio app already collects, rather than polling
metals.dev again — two pollers would drift and the two tools would quote
different premiums for the same metal on the same day.

```bash
node bin/cli.js spot            # mirror it, check the counts look right
```

## 8. Run it

```bash
node bin/cli.js run             # the collector
node bin/cli.js dashboard       # http://127.0.0.1:34260
```

Expect the first useful numbers within days for common bullion sovereigns, and
months for scarce branch-mint dates. The tool reports sample sizes so you can see
which is which.

---

## Optional: apply for Marketplace Insights

It would hand you a 90-day backfill of sold data on day one. It is a Limited
Release API and community reports suggest individual developers are refused, but
applying costs nothing and the tool is designed to work without it.

## Rate limits

The default is 5,000 Browse calls/day, application-wide. The collector budgets
~1,800 and degrades gracefully — it drops snapshot cadence before discovery,
because a missed snapshot costs precision on one lot while a missed discovery
loses the lot entirely. If you approach the ceiling, request a free **Application
Growth Check**.
