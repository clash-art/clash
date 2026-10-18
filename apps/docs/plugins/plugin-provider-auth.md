# Plugin Provider Auth

How a plugin gets the credential it needs, and what Clash does on its behalf.

The short version: **Clash stores things and runs flows; the plugin decides what
those things mean.** There is no auth type registry, no per-vendor header table,
and no sandbox.

## Why not an auth type registry

The obvious design is a closed set of auth kinds the host implements —
`api-key`, `oauth`, `basic` — and a plugin picks one. It breaks on contact with
real providers. Counted in this codebase, before any of this was written:

- **kling** holds an accessKey and a secretKey, signs an HS256 JWT locally,
  valid 30 minutes, and **exchanges with nobody**. It is not an api key and not
  a token exchange.
- A plugin may run its own authenticated helper. The credential never reaches
  the host at all; the helper makes the request and the plugin returns output.
- **device-code** flows have three columns in the database and no vocabulary
  anywhere.

Each of these needed a new kind, and the next provider would need another. So
the host stopped classifying auth and started offering primitives.

## The primitives

### Storage

Opaque key/value with a lifetime. The host does not interpret the values.

```ts
await store.put("apiKey", value, { secret: true });
await store.put("accessToken", token, { secret: true, expiresAt: Date.now() + 3600_000 });
const key = await store.get("apiKey");
```

`secret: true` is encrypted at rest. `expiresAt` is what makes renewal
schedulable — it is the only thing the host reads.

This replaces a table with a column per flow. `provider_oauth` had
`device_code`, `user_code`, `interval_seconds` and `oauth_state`, which meant a
new flow was a schema change.

**A plugin reads only what it wrote.** Keys are scoped to the plugin, so one
plugin cannot read another's credentials, and a key name is a private choice
rather than something to coordinate. Since plugins hold their credentials in
plaintext, this is the boundary that remains: installing a plugin exposes the
accounts you configure *for that plugin*, not every account on the machine.

### A plugin cannot name itself

The scoping above is only a boundary if the plugin cannot choose which scope it
is in. If a store call carried a plugin id, any plugin could read any other's
credentials by asking for them, and the isolation would be a naming convention.

So the plugin never sends one. The Host binds the selected account to each
pending invocation. A broker request carries only its unforgeable active
`invocationId` plus the store key; the Host looks up the pending invocation,
then supplies `{ pluginId, accountId }` to the store adapter internally. One
stdio process may serve concurrent invocations for different accounts without
ever receiving either account id on the plugin wire.

```
host                                     plugin
 │ invoke(invocationId), remember         │
 │ invocationId → { pluginId, accountId } │
 │───────────────────────────────────────▶│
 │                                        │
 │ ◀── get(invocationId, "apiKey") ──────│
 │ resolve pending invocation and scope    │
```

Why the binding belongs to the pending invocation rather than the process:

- **No forgeable scope field.** A plugin id is public and an account id is not
  authority; neither appears in a broker store operation.
- **It dies with the invocation.** A broker request for an invocation that is
  no longer pending is rejected.
- **It is concurrency-safe.** Two requests handled by one process retain their
  own account bindings even when their async work overlaps.

The key is data, not a path. `"../other/apiKey"` addresses a row named exactly
that, in the caller's own scope, and finds nothing.

### Account selection belongs to the Host

A Provider contribution describes a vendor route and the form used to configure
accounts for it. It does not select one of those accounts. In particular,
`accountId` is not valid in Provider `bindingDefaults`, a contributed
`model-provider-binding`, or a contributed model Card's
`providerImplementations`.

Those documents are package content shared by every installation, while an
account is user- and Host-local state. Allowing a bundled or third-party package
to name an account would make the package choose credentials it does not own and
would make the same binding mean different things on different Hosts.

At execution time the Host resolves the eligible configured accounts, applies
Host-owned routing policy, and binds the selected account to its private
pending-invocation record. Host internals may therefore carry an `accountId`,
but the plugin invocation and broker operation do not. `context.store` resolves
through that record, so the plugin receives the assigned account scope without
gaining a way to switch scopes in its manifest, Provider document, model
binding, invocation, or store call.

### This is where settings live now, too

Not only credentials. Anything an account states about itself is a key here,
because the alternative was a fixed column and there were never enough of them.

`provider_accounts` has `region`, `label`, `api_shape`, `priority`, `weight`.
A `--location` flag was written against it, parsed correctly, printed success,
and dropped the value — none of the columns was `location`. A parameter that
cannot be stored is worse than a missing one, because the failure is silent.

So `region`, `service`, `label` and whatever the next provider needs are all
just keys:

```ts
await store.put("service", "agent-platform");
await store.put("region", "us-central1");
```

The host reads none of them. It does not know that Google has services, that
MiniMax has two hosts, or that Agent Platform has locations — which is the
point, since it also does not know about the provider you are about to add.

### Methods

A Provider declares one or more **methods**. A method is a whole coherent configuration — a way of
authenticating, carrying exactly the fields that way needs.

This was originally a single flat form, and the ways of authenticating had to be reconstructed from
it. Google broke that. It has two surfaces and two credentials, and they do not pair off evenly: a
service account signs an assertion only Agent Platform accepts; an API key works on AI Studio *and*
on Agent Platform in Express mode; and a region is an Agent Platform concept that AI Studio has no
notion of. Expressed as one form this needed a `service` choice, a rule saying two keys were
alternatives, and a condition hiding the choice once a service account was pasted — three
mechanisms for the host to infer a structure the plugin knew outright. It also carried a notice
claiming Agent Platform refuses API keys, which is false, and which is what made the choice look
redundant in the first place.

```jsonc
{
  "methods": [
    { "id": "ai-studio", "label": "Google AI Studio (Developer API)",
      "form": [ { "kind": "field", "key": "apiKey", "label": "API key", "secret": true } ] },

    { "id": "service-account", "label": "Google Cloud Agent Platform (service account)",
      "form": [ { "kind": "field", "key": "serviceAccountKey", "secret": true },
                { "kind": "choice", "key": "region", "options": [ /* ... */ ] } ] }
  ]
}
```

`region` is absent from the AI Studio method rather than present and ignored. A field that is
present and ignored teaches the reader that fields can be ignored.

An account records which method it uses, so method ids must be unique. A method must collect
something, start a flow, or declare an installed-app import: one that does none of those offers a
name and nothing to do with it.

How many methods is the vendor's business, not a matter of symmetry. MiniMax declares one, because
the same key is presented the same way to either host — its `international`/`domestic` choice is a
deployment, not a second way in, and splitting it would ask the user to choose an authentication
method in order to express a region.

### Form

Declared, not coded. The host renders it and writes results to storage. A form belongs to a method.

| Kind | Use |
| --- | --- |
| `field` | api key, base url |
| `choice` | a menu — MiniMax region, Google region |
| `button` | starts a flow: "Sign in with Google" |
| `notice` | explains a field |
| `display-code` | shows a code the user types elsewhere (device-code flows) |

```jsonc
{
  "form": [
    { "kind": "field",  "key": "apiKey", "label": "API key", "secret": true },
    { "kind": "notice", "text": "Create one at aistudio.google.com/apikey" }
  ]
}
```

A field with no declared default is required. A declared form `button` is only drawn when its own
method declares a flow — under the old flat shape there was one flow for the whole declaration, so
a button in one part of the form was enabled by a flow declared for another. A flow-only method is
also valid: the Host draws one action using the method label, without inventing a form field.

The host never learns what a field **means**. `apiKey` is a secret field and `serviceAccountKey` is
a secret field; that one is a token and the other is JSON, and what either authorises, stays the
plugin's business. Any host logic keyed on those names would be the host guessing at something the
plugin never told it.

### Browser flow

Anything that needs a browser window and an address back.

```jsonc
{
  "flow": {
    "open": "https://accounts.google.com/o/oauth2/v2/auth",
    "callback": { "type": "loopback" }
  }
}
```

`loopback` binds `http://127.0.0.1:<random port>` and hands the query
parameters to the plugin. **Google requires this** for desktop clients; the
out-of-band flow (`urn:ietf:wg:oauth:2.0:oob`) was withdrawn in 2022.

`scheme` registers a custom URL scheme instead, for platforms where that is the
convention.

`poll-until` covers device-code: show a code, poll an endpoint until the user
finishes elsewhere.

PKCE, the `state` parameter, the port and the timeout are the host's. A plugin
that had to implement `state` correctly would eventually implement it
incorrectly, and the failure is a silent CSRF rather than an error.

### Hosted (Cloudflare) web redirect

The hosted Worker bundles no Provider declarations. The operator registers
OAuth Providers in the optional `PROVIDER_OAUTH_PROVIDERS` Worker secret, a
JSON array of the same flow declaration a plugin writes:

```jsonc
[
  {
    "id": "acme",
    "label": "Acme Media",
    "flow": {
      "open": "https://auth.acme.example/authorize",
      "tokenUrl": "https://auth.acme.example/token",
      "clientId": "<web client id registered by the operator>",
      "clientSecret": "<optional>",
      "params": { "scope": "media" },
      "callback": { "type": "loopback" }
    }
  }
]
```

`tokenUrl` and `clientId` are required. The hosted adapter always answers on
its own redirect, `${WORKER_PUBLIC_URL}/api/v1/provider-oauth/callback`, so
register that address with the vendor; a `loopback` or `scheme` callback in the
declaration describes the same authorization-code grant, and `poll-until`
(device code) is rejected. The secret is parsed on first use, not at Worker
startup; an invalid entry fails that Provider's start with
`PROVIDER_OAUTH_NOT_CONFIGURED`, and a Provider absent from the secret answers
404.

`POST /api/v1/provider-oauth/:id/start` seals the PKCE verifier and `state`
(ACTION_SECRET_KEY envelope) on a pending row that expires after 10 minutes and
returns the authorization URL with `callbackType: "web"`. The vendor redirects
to the callback, which finds the state among the signed-in user's pending flows
in constant time, consumes it once, exchanges the code, and stores the tokens
encrypted. It always answers with a redirect to
`/settings?section=providers&providerOAuth=<id>&status=authorized|error&code=<code>`;
the settings page shows the message for the code. Codes:
`PROVIDER_OAUTH_STATE_INVALID` (unknown, reused or another user's state),
`PROVIDER_OAUTH_STATE_EXPIRED`, `PROVIDER_OAUTH_DENIED` (`access_denied`),
`PROVIDER_OAUTH_VENDOR_ERROR`, `PROVIDER_OAUTH_EXCHANGE_FAILED`,
`PROVIDER_OAUTH_NOT_CONFIGURED`, `PROVIDER_OAUTH_UNAUTHENTICATED`.
`/complete` answers 409 for a web flow; reusing an installed app's login
(`import-local`) still needs the desktop runtime and answers 501 when hosted.

### Installed-app import

An import-only method lets the Host reuse a credential already held by an installed desktop app.
It has no form and no browser flow; the method label is the action shown to the user.

```jsonc
{
  "id": "reuse-local-login",
  "label": "Reuse MiniMax Hub login",
  "import": {
    "format": "electron-store-aes-256-gcm-v2",
    "appDataSubdirectory": "@hilo/MiniMax Hub Global",
    "configFile": "hub-config-global.json",
    "keyFile": ".token-key",
    "tokenPath": ["tokens", "accessToken"],
    "storeAs": "accessToken"
  }
}
```

The path is constrained to a declared subdirectory of the platform application-data root, and the
format is explicit rather than sniffed. This is not a plugin sandbox—installed plugins already run
with the user's process privileges. The declaration gives the Host enough structure to make the
operation visible, validate accidental path escapes, and write the result into the selected
account's scoped store under `storeAs`. The Host resolves `pluginId` from the installed Provider and
requires an existing Host-selected `accountId`; neither value comes from plugin business code. The
public authorization record keeps only status and label, not a second copy of the imported secret.

### Renewal

The plugin declares whether renewal applies and when. The plugin's own code
performs it.

```jsonc
{ "renew": { "before": "60s" } }  // when a stored expiresAt approaches
{ "renew": { "every": "12h" } }   // on a fixed schedule
```

The host wakes the plugin's `renew` export; the plugin refreshes however its
vendor requires and writes the result back to storage. Renewal is not a
protocol the host knows — a refresh-token exchange, a re-signed JWT and a
re-run CLI are all just code.

These two are declarations because only the host can act on them: it is the one
awake when nobody is using the app. A plugin may refresh an expired credential
before it crosses the semantic Provider submit/poll boundary. Once that
Provider operation has been sent, however, it must not refresh and issue a
second submit or poll inside the same invocation. It returns the structured
authentication or transport failure instead; Host durable policy decides
whether another invocation is allowed without losing the request-state
boundary.

What the host does own is the **failure**: when renewal fails, the account is
marked as needing attention and the form says so. A dead refresh token must not
surface as a generation error three screens away.

### Verification

The host can ask whether a credential currently works, and reports the answer
in the form. This is the existing provider test — `POST
/api/v1/model-providers/test` — which **runs a real generation** on a real
model rather than pinging an endpoint.

That distinction is the point. A key can be well-formed, accepted by an auth
check, and still fail on the model you wanted: the project may not have the API
enabled, the model may not exist in your region, or the account may lack the
role. All three were measured here with a key that authenticated correctly.

It matters most for credentials the user obtained elsewhere. `gcloud auth login`
produces something we did not mint and cannot audit; the useful question is not
"is this well-formed" but "does this provider serve that model, for you, now".

## The auth shape is plugin code

Every vendor puts the credential somewhere different, with a different name:

| Vendor | Where |
| --- | --- |
| Google API key | header `x-goog-api-key` |
| Google OAuth | header `Authorization: Bearer` |
| ElevenLabs | header `xi-api-key` |
| fal | header `Authorization: Key` |
| Replicate | header `Authorization: Token` |

There is no rule to discover here. `Key`, `Token` and `Bearer` differ for no
reason, and some providers want the credential in the query string. This is
part of the vendor's API shape, which is exactly what a plugin is for:

```js
const key = await store.get("apiKey");
const response = await fetch(url, { headers: { "x-goog-api-key": key } });
```

The host previously carried this as a table keyed by provider id, which meant
adding a provider meant editing the host, and a third-party plugin could not
introduce one at all.

## No sandbox

Plugins run as ordinary processes with ordinary network and filesystem access.
They read their credentials in plaintext.

This is a deliberate trade. The alternative — network primitives replaced with
throwing stubs, every request brokered, the plugin never seeing the token —
forces the host to know each vendor's auth shape in order to inject it, which
puts vendor knowledge back in the host and blocks any provider the host has not
been taught.

Installing a plugin is therefore giving it your provider credentials. That is
the same trust as installing any other software, and it is stated here rather
than implied by a sandbox that could not hold anyway.

## Worked example: Google

Google is four different credentials, which is why it is the useful test of
whether these primitives are enough.

### API key

```jsonc
{
  "id": "google-api-key",
  "form": [{ "kind": "field", "key": "apiKey", "label": "API key", "secret": true }]
}
```

```js
authorize: (c) => ({ headers: { "x-goog-api-key": c.apiKey } })
```

Reaches the Gemini Developer API. A Cloud API key works only if the Gemini API
is enabled on its project — otherwise the response is
`403 Gemini API has not been used in project <n>`.

### OAuth

```jsonc
{
  "id": "google-oauth",
  "form": [{ "kind": "button", "key": "signIn", "label": "Sign in with Google", "flow": "oauth" }],
  "flow": {
    "open": "https://accounts.google.com/o/oauth2/v2/auth",
    "callback": { "type": "loopback" },
    "params": { "access_type": "offline", "prompt": "consent",
                "scope": "https://www.googleapis.com/auth/cloud-platform" }
  },
  "renew": { "before": "60s" }
}
```

Clash bundles a Desktop OAuth client. A Desktop client id is not a secret —
RFC 8252 treats native apps as public clients, and no desktop application can
keep a client secret. Security comes from PKCE, `state`, the system browser and
a strict redirect, not from hiding the id.

Two facts worth knowing before depending on this:

- An OAuth app in **Testing** status issues refresh tokens that expire after
  **7 days**. Production use requires publishing and verification, and
  `cloud-platform` is a sensitive scope.
- A refresh token can also die from revocation, long disuse or an org policy
  change. `invalid_grant` means sign in again, and the form has to say that.

### Service account

```jsonc
{
  "id": "google-service-account",
  "form": [{ "kind": "field", "key": "serviceAccountKey", "label": "Service account JSON", "secret": true }],
  "renew": { "before": "60s" }
}
```

The stored key is not the credential: the plugin signs a JWT with the private
key and exchanges it at `oauth2.googleapis.com/token` (RFC 7523) for an access
token that lasts about an hour. The key lasts until revoked, which makes this
the only unattended source of a Google token.

Required for **Gemini Omni**, which is reachable only through the Interactions
API — measured: `POST /v1beta1/projects/{p}/locations/global/interactions`
answers an api key with `401 API keys are not supported by this API`, while
`:generateContent` refuses the model with `400 only supported in the
Interactions API`.

### An externally obtained token

```jsonc
{
  "id": "google-adc",
  "form": [
    { "kind": "notice", "text": "Run: gcloud auth login" },
    { "kind": "button", "key": "check", "label": "Check access", "flow": "verify" }
  ]
}
```

The plugin runs `gcloud auth print-access-token` and verifies the result
against the provider. Clash mints nothing and stores nothing long-lived; the
token lasts about an hour and the plugin fetches a fresh one when it needs one.

Suitable for developer machines. It requires the Google Cloud SDK, which most
users do not have.

## Choosing between them

| You have | Use |
| --- | --- |
| An AI Studio key (`AIza…`) | API key |
| A Google account, no tooling | OAuth |
| A server, or Gemini Omni | Service account |
| gcloud already installed | ADC |
