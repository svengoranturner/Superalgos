# Cloudflare Tunnel: exposing the eBay deletion endpoint

metalhead.gold is already served through a `cloudflared` tunnel. This adds
**one path** to it, and nothing else about the tool becomes publicly reachable.

> **Not verified on your setup.** These were written without access to your
> `config.yml` or Cloudflare account. Read your existing config first and merge
> — do not overwrite it.

## Why this path has to be public at all

A production eBay keyset **stays inert** until eBay's Marketplace Account
Deletion notification is either subscribed or exempted. We subscribe, and honour
it properly — the endpoint recomputes a seller's salted hash from the identifier
eBay sends and genuinely purges their rows.

To validate the subscription, eBay sends an **unauthenticated GET** carrying a
challenge code. That is the whole reason this one path cannot sit behind your
Access gate.

## 1. Ingress rule

Find your tunnel config — usually `/etc/cloudflared/config.yml` or
`~/.cloudflared/config.yml`. Add the **specific path rule before** any catch-all
for the same hostname; cloudflared matches ingress rules **in order** and the
first match wins, so a rule placed after your existing `metalhead.gold` entry
will never be reached.

```yaml
ingress:
  # eBay account-deletion endpoint - must come BEFORE the metalhead.gold rule
  - hostname: metalhead.gold
    path: ^/ebay/account-deletion$
    service: http://localhost:34261

  # your existing rules follow unchanged
  - hostname: metalhead.gold
    service: http://localhost:PORT_OF_PORTFOLIO_APP

  - service: http_status:404
```

Validate and restart:

```bash
cloudflared tunnel ingress validate
sudo systemctl restart cloudflared
```

`ingress validate` also has a useful companion for checking rule ordering:

```bash
cloudflared tunnel ingress rule https://metalhead.gold/ebay/account-deletion
```

It prints which rule that URL matches. If it names your portfolio app rather
than `localhost:34261`, the ordering is wrong.

## 2. Access bypass — the step that is easy to miss

If metalhead.gold is behind **Cloudflare Access**, the challenge request will be
intercepted and eBay will see a login page instead of the JSON it expects. The
failure surfaces only as "endpoint validation failed", which names neither the
gate nor the path.

In the Cloudflare dashboard: **Zero Trust → Access → Applications**.

Either add a **Bypass** policy scoped to that exact path on the existing
application, or define a separate application for
`metalhead.gold/ebay/account-deletion` whose single policy is:

| | |
|---|---|
| Action | **Bypass** |
| Include | Everyone |

Bypass means no authentication is required for that path — which is correct
here, and safe: the endpoint accepts only a challenge code (which it echoes back
hashed) and deletion notifications (which it verifies before acting on). It
exposes no data and offers nothing to an unauthenticated caller.

## 3. Confirm it end to end

On the Pi:

```bash
node bin/cli.js notify-token          # generate the verification token, put it in settings.json
node bin/cli.js notify-endpoint       # leave running
```

From anywhere:

```bash
curl "https://metalhead.gold/ebay/account-deletion"
```

Should return `coin-market notification endpoint` as plain text. If you get an
Access login page, HTML, or a 404, stop — fix that before touching eBay's form,
because eBay's own error will not tell you which of the three it was.

Then the real check:

```bash
node bin/cli.js notify-check
```

This computes the expected challenge hash locally, calls your public URL, and
compares. It names the likely cause on mismatch.

## The two things that actually break this

**The endpoint URL is part of the challenge hash.** eBay hashes
`challengeCode + verificationToken + endpointUrl`. So the URL in
`settings.json`, the URL registered in eBay's form, and the URL eBay actually
reaches must be byte-identical. A trailing slash, `http` vs `https`, or a `www.`
prefix all produce a valid-looking hash that eBay rejects.

**Ingress rules match in order.** A path rule placed after a hostname catch-all
for the same hostname is dead. `cloudflared tunnel ingress rule <url>` tells you
which rule wins.

## Nothing else is exposed

Only this one path. The dashboard binds to `127.0.0.1` and stays reachable only
over SSH — it holds your buying intentions and there is no reason for it to be
on the internet.
