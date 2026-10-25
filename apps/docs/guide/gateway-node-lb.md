# Gateway Node Load Balancer (SSE)

How to put multiple Clash **self-host gateway-node** `api` processes behind a
load balancer without breaking Server-Sent Events. Locked topology: **Postgres
multi-instance only** (decision 12) — no SQLite single-node product path.

Checked-in nginx config: `apps/api-node/deploy/nginx.conf`
(compose mounts it as `./deploy/nginx.conf` next to the Epic B compose file, #374).

**Staging / self-host only.** Clash official cloud traffic stays on Cloudflare
Workers (`apps/api-cf`); this guide is for Node self-host operators.

## Requirements (NODES §3.7)

| Rule | Why |
| --- | --- |
| `least_conn` | Streams are long and unequal; round-robin piles work on busy nodes. |
| `proxy_buffering off` (and no response cache / gzip on the stream) | Buffering destroys TTFT and can hold an entire SSE body. |
| Read/send timeouts ≥ max stream (+ grace), e.g. **900s** | Must exceed `GATEWAY_MAX_STREAM_MS` and the SSE `: ping` interval. |
| **No POST retry** after the body was sent (`proxy_next_upstream off` for `/v1/*`) | Retry doubles billing and can duplicate tool calls. |
| Admin on a **separate upstream / network**, not on the public listener | Different threat model (key rotation, refunds, RBAC). |
| No sticky sessions | Auth is token/cookie; durable state is Postgres. |
| TLS at the LB | Nodes speak plain HTTP on the private network. |

## nginx

Use the checked-in file. Highlights:

- `upstream gateway_api { least_conn; ... }`
- `location /v1/`: `proxy_buffering off`, `proxy_cache off`, `gzip off`,
  `proxy_request_buffering off`, `proxy_next_upstream off`,
  `proxy_read_timeout` / `proxy_send_timeout` 900s
- Public server returns 404 for `/admin` and `/api/v1/admin`
- `/readyz` is what the LB should health-check so a draining node
  (`503` on ready) is ejected before new streams arrive

Validate locally (staging compose):

```bash
nginx -t -c /path/to/apps/api-node/deploy/nginx.conf
# or inside the lb container after compose up
```

## TLS termination

Terminate TLS on the LB (or a dedicated TLS proxy in front of nginx). Nodes
keep HTTP on the private network.

Checklist:

1. Certificate and private key only on the TLS tier (not in the gateway image).
2. Forward `X-Forwarded-Proto https` (the sample nginx sets this from `$scheme`
   when nginx itself terminates TLS — if a outer proxy terminates TLS, set it
   explicitly to `https`).
3. `GATEWAY_PUBLIC_URL` must be the public `https://…` origin clients use
   (cookies, CORS, signed URLs).
4. Enforce body size limits at the TLS/LB tier appropriate for non-stream
   JSON; do not buffer SSE bodies to apply them.
5. HSTS and modern ciphers are operator policy; not dictated by gateway-core.

Example: nginx listening on 443 with certificates (sketch — merge into the
checked-in file or a site overlay; do not commit secrets):

```nginx
server {
  listen 443 ssl http2;
  ssl_certificate     /etc/nginx/certs/fullchain.pem;
  ssl_certificate_key /etc/nginx/certs/privkey.pem;
  # … same location blocks as deploy/nginx.conf …
}
```

## Caddy equivalent

```caddy
# Public data plane only. Bind admin elsewhere (see below).
{$GATEWAY_PUBLIC_HOST} {
  encode off
  reverse_proxy gateway-1:8080 gateway-2:8080 gateway-3:8080 {
    lb_policy least_conn
    flush_interval -1
    transport http {
      read_timeout 900s
      write_timeout 900s
      dial_timeout 10s
    }
    # Caddy does not retry failed POSTs by default for reverse_proxy;
    # do not add `lb_try_duration` / retry handlers for /v1/*.
  }
}

# Admin: private bind or separate host, never the public site block.
# :8081 {
#   bind 127.0.0.1
#   reverse_proxy admin:8081
# }
```

`flush_interval -1` disables response buffering so SSE events flush
immediately. Caddy terminates TLS automatically for public hostnames when
certificates are available.

## Traefik equivalent

```yaml
# Dynamic config sketch (file provider). EntryPoint `websecure` terminates TLS.
http:
  middlewares:
    gateway-buffers:
      buffering:
        maxResponseBodyBytes: 0
        memResponseBodyBytes: 0
  services:
    gateway-api:
      loadBalancer:
        sticky: false
        # Note: prefer least-connection when your Traefik edition exposes it;
        # prefer least-connection when available in your Traefik edition.
        servers:
          - url: "http://gateway-1:8080"
          - url: "http://gateway-2:8080"
          - url: "http://gateway-3:8080"
        healthCheck:
          path: /readyz
          interval: 5s
          timeout: 3s
    # gateway-admin: separate router, entryPoint on private network only
  routers:
    gateway-v1:
      rule: "PathPrefix(`/v1/`)"
      entryPoints: [websecure]
      service: gateway-api
      middlewares: [gateway-buffers]
      # Do not enable retry middleware on this router.
```

Notes for Traefik operators:

- Disable response buffering / set flush for SSE (version-specific;
  `buffering` middleware with zero caps, or entrypoint `transport.respondingTimeouts`
  `readTimeout`/`writeTimeout` ≥ 900s).
- **Do not** attach a `retry` middleware to `/v1/*` POST routes.
- Expose admin on a different entrypoint (VPN / internal only).

## Drain interaction

On `SIGTERM`, an `api` node flips `/readyz` to 503, waits for the LB to eject
it, then finishes in-flight streams up to `GATEWAY_SHUTDOWN_GRACE_MS` (#375).
The LB idle timeout must stay above the SSE keep-alive ping interval so the
proxy does not cut a healthy stream during drain.

## Out of scope

- Cloudflare Workers official cloud (no nginx in front of api-cf).
- SQLite / single-process "minimal" topology (removed as a supported product
  path; decision 12).
