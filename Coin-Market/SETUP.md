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

Write the config from your keys rather than hand-editing JSON:

Run this **on the Pi** (bash), where the tool will actually live:

```bash
node bin/cli.js init
```

It asks for the App ID, Cert ID and Dev ID in turn. **The Cert ID does not
echo**, and no key reaches your shell history or `ps` output — which is why
there is nothing to substitute into that command. A run with placeholder text
still in it is refused rather than written.

The flags (`--app-id=` and friends) still work for scripting. They are the
worse path for a human: an unsubstituted placeholder writes a `settings.json`
that looks complete and fails much later, at the first eBay call, with an error
that names none of this. That has already happened twice here.

Run it **on the Pi**, not from Git Bash on the Windows workstation. Git Bash
rewrites an absolute Unix path in an argument into a Windows one, so a
`--spot-project=/home/stacker/...` flag silently becomes
`C:/Program Files/Git/home/stacker/...` and the setting is quietly wrong. The
spot block in the committed template already points at the right place, so you
should not need that flag at all.

That writes `config/settings.json` at mode 0600 (gitignored), and generates two
values you should not choose by hand: the seller-hash salt, which is what stops
stored seller hashes being reversible by anyone holding a copy of the database,
and the account-deletion verification token.

Then probe eBay for real:

```bash
node bin/cli.js smoke          # every API path, pass/fail/unknown per capability
node bin/cli.js doctor         # the narrower load-bearing checks
```

`smoke` reports **UNKNOWN** rather than a false green where the environment
genuinely cannot answer — sandbox has no real coin listings, so it can prove the
client is correctly built and nothing whatsoever about the coin market. It also
writes `smoke-shapes.json`: the actual field names eBay returned on ItemSummary
and inside `conditionDescriptors`. Several readers are written tolerantly
because eBay documents those ambiguously, and that file is what lets them be
tightened to reality. It contains no credentials.

Re-run `smoke` after flipping `environment` to `production`, and any time eBay
announces a change.

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

The portfolio app (`metal-stack`) keeps spot in **PostgreSQL, inside Docker, in
GBP per gram** — not in a SQLite file in GBP per ounce, which is what the first
draft of this tool assumed. The reader that matches what is actually there:

```json
"spot": {
  "type": "postgres",
  "projectDir": "/home/stacker/apps/metal-stack",
  "service": "db",
  "user": "metalstack",
  "database": "metalstack",
  "metalValue": "Au",
  "units": "gbp_per_gram",
  "includeDaily": false,
  "toleranceMinutes": 90
}
```

It shells out to `psql` through the portfolio app's own compose project rather
than adding a Postgres driver — that keeps the zero-dependency promise that
makes this installable on a Pi with no compiler, and it is still a **local**
read: no HTTP, no domain, no Cloudflare. The connection is opened with
`default_transaction_read_only=on`, so a bug here cannot corrupt the portfolio
app's data even though the role it connects as could.

Reading that feed rather than polling metals.dev again is deliberate — two
pollers would drift and the two tools would quote different premiums for the
same metal on the same day.

**Which series.** `spot_tick` is the ~20-minute intraday stream and the only one
fine enough to price a lot against the moment it closed; that is what gets
mirrored. `spot_history` is one row per day going back to 1968. Set
`includeDaily` to also mirror the stretch *before* the ticks begin — those rows
are stamped at `dailyHourUtc` (a daily close has no true intraday timestamp) and
carry the source `metals.dev-daily`, so a premium priced off one is visibly
coarser rather than passing for a 20-minute observation.

If your portfolio store is a SQLite file instead, `--spot-db=/path/to.db` at
`init` switches the whole block over to the `sqlite` reader.

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

---

## Platform changes this tool already handles

Two of the notices on the developer console banner affect buy-side integrations.

**Usernames replaced by immutable user IDs** (live 15 May 2026). The tool stores
a salted hash of *both* identifiers, and the account-deletion endpoint purges on
either. This matters more than it sounds: if eBay names a departing user by
immutable id while your stored hash came from a username, a purge keyed on one
column alone returns 200 to eBay having deleted nothing — failing the very
obligation the subscription exists to meet. It also fixes a quieter problem that
predates the change: a seller who renames their account used to look like two
different sellers to relist detection.

**Standardised coin condition details** (from 6 May 2026). This is a *seller*
obligation — you create no listings, so you owe eBay nothing here. But the data
flows back to buyers in a `conditionDescriptors` array, and the tool now reads
it in preference to parsing the title:

- graded coins → grading company, numeric grade, letter grade, certification number
- raw coins → one of *Uncirculated*, *Extremely Fine to About Uncirculated*,
  *Fine to Very Fine*, *Below Fine*

Grade is the second-largest driver of a sovereign's price after its metal
content, so this converts a regex guess into a structured read — and eBay is
making it mandatory, so coverage should approach total.

The **certification number** is the valuable part: it identifies one physical
slabbed coin, so the tool can follow that exact coin across relistings *and*
resales by different sellers — something no title-matching heuristic can do.

If eBay adds or rewords a condition band, the listing goes to the review queue
rather than being filed under "ungraded". A wrong grade moves the premium, so it
must fail visibly.

`node bin/cli.js doctor` reports how many UK sovereign listings actually carry
descriptors yet — the phase-in dates were announced for the US and the UK timing
is unconfirmed.

**Not applicable:** the Authenticity Guarantee expansion for coins (Aug 2026,
PCGS, $500+) is US-only and this tool is UK-only. Worth watching — the threshold
sits right around a sovereign's price, so if it reaches the UK it becomes a real
premium factor. The apparel size and EU return-reason notices are seller-side and
irrelevant here.
