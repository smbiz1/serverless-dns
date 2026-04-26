# Deepmarket DNS API

A small JSON wrapper around this fork's serverless-dns Cloudflare Worker, built
for the deepmarket app. It is layered on top of the existing RFC 8484 DoH
endpoint (`/dns-query`) — the wire-format endpoint still works unchanged.

## Endpoints

All endpoints live on the same Worker.

| Method     | Path             | Purpose                                   |
| ---------- | ---------------- | ----------------------------------------- |
| `GET`      | `/resolve`       | DNS lookup (Cloudflare-style query args)  |
| `POST`     | `/resolve`       | DNS lookup (JSON body)                    |
| `GET`      | `/dns-json`      | Alias of `/resolve`                       |
| `GET`      | `/__health`      | Liveness probe — returns `{ok: true}`     |
| `OPTIONS`  | any of the above | CORS preflight                            |
| `GET/POST` | `/dns-query`     | Standard RFC 8484 DoH (untouched)         |

## Request

`GET /resolve?name=example.com&type=A`

Query parameters:

- `name` — hostname to resolve. Required.
- `type` — RR type as either name (`A`, `AAAA`, `CNAME`, `TXT`, `MX`, `NS`,
  `SOA`, `SRV`, `CAA`, `HTTPS`, `SVCB`, `PTR`, `DS`, `DNSKEY`, `TLSA`,
  `NAPTR`, `RRSIG`, `NSEC`, `NSEC3`, `SSHFP`, `SPF`) or numeric IANA code.
  Defaults to `A`.
- `cd` — disable DNSSEC validation if `1`/`true`. Default `false`.
- `do` — request DNSSEC records via EDNS DO bit if `1`/`true`. Default `false`.
- `key` — optional API key (only required if `DEEPMARKET_API_KEY` is configured
  on the Worker; prefer the header form below).

`POST /resolve` accepts the same fields as JSON:

```json
{ "name": "example.com", "type": "AAAA", "cd": false, "do": false }
```

`Content-Type: application/json` is required for POST.

### Authentication

If you set the `DEEPMARKET_API_KEY` secret on the Worker, every `/resolve` and
`/dns-json` call must present the key. If the secret is unset, the API is open.

```
X-API-Key: <your-key>
# or
Authorization: Bearer <your-key>
```

`401` is returned when the key is missing, `403` when it does not match. The
comparison is constant-time.

Set the secret with:

```sh
wrangler secret put DEEPMARKET_API_KEY --env deepmarket
```

## Response

The shape mirrors Cloudflare's `application/dns-json`, so most existing client
libraries work unchanged.

```json
{
  "Status": 0,
  "TC": false,
  "RD": true,
  "RA": true,
  "AD": false,
  "CD": false,
  "Question": [{ "name": "example.com", "type": 1 }],
  "Answer": [
    { "name": "example.com", "type": 1, "TTL": 3600, "data": "93.184.216.34" }
  ],
  "blocked": false,
  "region": "ORD"
}
```

Extra fields beyond the Cloudflare format:

- `blocked` — `true` if the answer was filtered by the configured blocklist.
- `flag` — opaque blocklist flag (only present when the resolver tagged the
  answer).
- `region` — Cloudflare colo that served the request, useful for debugging.

Errors come back as JSON with the `error` field set:

```json
{ "Status": -1, "error": "Missing 'name'" }
```

## Privacy posture

- Response headers: `Strict-Transport-Security`, `Referrer-Policy: no-referrer`,
  `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Permissions-Policy: interest-cohort=()`.
- `Cache-Control: no-store, private` for error responses; for successful
  answers the directive uses the DNS TTL so callers can cache by the record's
  own lifetime.
- Cloudflare Workers logging is disabled for this env (`logpush = false` is the
  default in `wrangler.toml`). To run with zero request logs in production,
  leave the `one`-style logpush blocks alone and stick to the `deepmarket` env.
- CORS is wide open (`Access-Control-Allow-Origin: *`) so browser callers in
  the deepmarket frontend can hit the API directly. Restrict by setting up a
  Worker route or front it with Cloudflare Access if needed.

## Deploying

```sh
wrangler deploy --env deepmarket            # deploys as `deepmarket-dns`
wrangler tail --env deepmarket              # live log
wrangler secret put DEEPMARKET_API_KEY --env deepmarket   # optional
```

Add `routes = ["dns.deepmarket.example.com/*"]` under `[env.deepmarket]` in
`wrangler.toml` once you have a custom domain bound to the Worker.

## Calling from the deepmarket app

Browser / fetch:

```js
const r = await fetch(
  "https://dns.deepmarket.example.com/resolve?name=example.com&type=A",
  { headers: { "X-API-Key": process.env.DEEPMARKET_DNS_KEY } }
);
const data = await r.json();
```

Node:

```js
const u = new URL("https://dns.deepmarket.example.com/resolve");
u.searchParams.set("name", host);
u.searchParams.set("type", "AAAA");
const res = await fetch(u, {
  headers: { "X-API-Key": process.env.DEEPMARKET_DNS_KEY },
});
const json = await res.json();
return json.Answer?.map((a) => a.data) ?? [];
```

`curl`:

```sh
curl -H "X-API-Key: $KEY" \
  "https://dns.deepmarket.example.com/resolve?name=example.com&type=A"
```
