# Cloudflare Tunnel: exposing the eBay deletion endpoint

metalhead.gold is already served through a `cloudflared` tunnel. This adds
**one path** to it, and nothing else about the tool becomes publicly reachable.

> **Now verified against the real setup, and section 1 was wrong.** The
> original assumed a locally-configured tunnel with a `config.yml` to merge
> into. This Pi does not have one.

## Why this path has to be public at all

A production eBay keyset **stays inert** until eBay's Marketplace Account
Deletion notification is either subscribed or exempted. We subscribe, and honour
it properly — the endpoint recomputes a seller's salted hash from the identifier
eBay sends and genuinely purges their rows.

To validate the subscription, eBay sends an **unauthenticated GET** carrying a
challenge code. That is the whole reason this one path cannot sit behind your
Access gate.

## 1. The route — in the dashboard, not a file

This tunnel is **remotely managed**. `cloudflared.service` runs:

```
/usr/bin/cloudflared --no-autoupdate tunnel run --token-file /etc/cloudflared/token
```

With `--token-file` there is no local ingress config: `/etc/cloudflared/` holds
only the token, and the routing lives in Cloudflare. So there is nothing to
merge, and `cloudflared tunnel ingress validate` / `ingress rule` have no config
to read — they do not apply here. Any recipe telling you to edit `config.yml` is
for a different kind of tunnel.

Add the route in **Zero Trust → Networks → Tunnels →** your tunnel **→ Public
Hostnames**:

| Field | Value |
|---|---|
| Subdomain | *(blank)* |
| Domain | `metalhead.gold` |
| Path | `ebay/account-deletion` |
| Service | `HTTP` → `localhost:34261` |

**Order matters and the dashboard list is the order.** The existing bare
`metalhead.gold` entry points at the portfolio app on `127.0.0.1:8000` and will
swallow every path if it comes first. Drag the new entry **above** it.

Note the Path field takes no leading slash in the dashboard.

## 2. Access bypass — the step that is easy to miss

**Confirmed necessary here, by measurement.** metalhead.gold is behind Cloudflare
Access (team domain `late-wave-cdce.cloudflareaccess.com`), and an unauthenticated
GET to the target path today returns:

```
HTTP/2 302
location: https://late-wave-cdce.cloudflareaccess.com/cdn-cgi/access/login/metalhead.gold?...
```

That is precisely what eBay would receive instead of the JSON it expects. The
failure surfaces only as "endpoint validation failed", which names neither the
gate nor the path — so do this step before touching eBay's form.

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
sudo systemctl status coin-market-notify    # installed and enabled; listens on 127.0.0.1:34261
```

`init` already generated the verification token and endpoint URL into
`settings.json`, so `notify-token` is only needed if you want to rotate it.

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

**Routes match in order.** A path entry listed after the bare-hostname entry for
the same hostname is dead — the catch-all wins and eBay reaches the portfolio
app instead. On a token-managed tunnel the order is the dashboard list order, so
check it by eye; `cloudflared tunnel ingress rule` needs a local config file and
has none to read here.

## Nothing else is exposed

Only this one path. The dashboard binds to `127.0.0.1` and stays reachable only
over SSH — it holds your buying intentions and there is no reason for it to be
on the internet.
