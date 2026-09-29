# Monzo integration: verified behavior and zero-trust design

Research date: 2026-08-06. Claims below use Monzo's official Developer API documentation except where explicitly marked as an inference or operational assumption.

## Security invariant

Persistent operator-side state must not be sufficient to call Monzo. A current secret-bearing blob held and presented by the MCP client must be required.

The implementation satisfies that invariant as follows:

- The MCP client's sealed access token contains the current Monzo access token.
- The MCP client's sealed refresh token contains the user's Monzo client ID, client secret, current access and refresh tokens, and refresh generation.
- The Worker secret `SEAL_KEY` can decrypt those artifacts only when a client presents one; the Worker does not persist a copy.
- One Durable Object per connection persists only `{ generation, SHA-256(current refresh token) }`.
- The coordinator receives credentials transiently during refresh, coalesces overlapping refreshes in memory, persists the successor hash before returning, and never persists the token response.
- Worker observability is disabled because request logs could otherwise retain bearer tokens or sealed OAuth state.
- There is no transaction mirror, webhook ingestion, background sync, or operator-key escrow. Webhook tools register a user-supplied receiver with Monzo; the Worker never receives the events.

This protects against an at-rest compromise of Worker configuration plus Durable Object storage. It does not protect against a malicious or actively compromised Worker runtime: the runtime necessarily sees usable tokens while serving a request.

## Verified Monzo behavior

### OAuth

- Users create OAuth clients at [developers.monzo.com](https://developers.monzo.com/). Monzo distinguishes confidential and non-confidential clients; non-confidential clients do not receive refresh tokens. This integration therefore requires a **Confidential** client. ([Developer API: Authentication](https://docs.monzo.com/))
- The authorization-code exchange sends `client_id`, `client_secret`, `redirect_uri`, and `code` to `POST /oauth2/token`. The successful response includes `access_token`, `expires_in`, `user_id`, and, for a confidential client, `refresh_token`. ([Developer API](https://docs.monzo.com/))
- Refresh sends the client ID, client secret, and refresh token. The Developer API documentation says refreshing invalidates the previous access token and calls refresh a one-time operation. Monzo's separate Open Banking documentation is more explicit that its refresh tokens rotate, are single-use, must not be used concurrently, and must be persisted atomically. Because the Developer API wording is less explicit, this implementation takes the conservative operational stance that its refresh token rotates and must be serialized. ([Developer API](https://docs.monzo.com/), [Open Banking: Refreshing tokens](https://docs.monzo.com/open-banking/))
- Monzo documents one active access token per client per user. Acquiring a new one invalidates the old one. Users should create **one Monzo developer client per MCP connection** so two MCP clients do not evict each other. ([Developer API](https://docs.monzo.com/))
- Access-token lifetime is not treated as a constant. The implementation uses each response's `expires_in`, re-wraps a still-valid upstream access token when the shorter MCP token expires, and rotates upstream only near actual Monzo expiry.
- Monzo's Developer API documentation does not describe upstream PKCE support. This repo still enforces PKCE S256 on the MCP-facing OAuth relationship; the Monzo-facing relationship uses `state` as documented.

### Approval and data windows

- The access token initially has no data permissions until the user approves the request in the Monzo app. There is no documented completion callback, so a tool call may temporarily receive a permission error while approval is pending. ([Developer API](https://docs.monzo.com/), [Monzo staff SCA explanation](https://community.monzo.com/t/strong-customer-authentication-upcoming-changes-to-developer-apps/78763))
- Full transaction history is available only for five minutes after in-app approval; after that Monzo limits synchronization to roughly the last 90 days. This implementation deliberately has no mirror or backfill, so it does not race to ingest history. ([Developer API](https://docs.monzo.com/), [SCA explanation](https://community.monzo.com/t/strong-customer-authentication-upcoming-changes-to-developer-apps/78763))
- Monzo requires periodic access reconfirmation (described by Monzo staff as every 90 days). A declined or lapsed reconfirmation can make API requests fail and may require the authorization flow again. ([SCA explanation](https://community.monzo.com/t/strong-customer-authentication-upcoming-changes-to-developer-apps/78763))

### API surface

- Implemented reads are `/ping/whoami`, `/accounts`, `/balance`, `/pots`, `/transactions`, and `/transactions/{id}`, the last two with `expand[]=merchant`.
- Implemented writes are webhook management: `POST /webhooks`, `GET /webhooks`, and `DELETE /webhooks/{id}`. Monzo sends `transaction.created` events with full transaction and merchant data to the registered URL, retrying failures up to five times. ([Developer API: Webhooks](https://docs.monzo.com/#webhooks))
- Transaction pagination supports `since`, `before`, and `limit`; Monzo documents a maximum page size of 100. This MCP tool caps responses at 50 to protect model context. ([Developer API](https://docs.monzo.com/))
- Monzo documents `429` but no contractual numeric rate limit. Money movement, annotations, and bulk history fetching are intentionally omitted.
- Monzo's developer API is intended for a user's own account or a small allowlisted set, not general public applications. BYO clients reduce credential custody but are not an explicit Monzo endorsement of a public hosted connector. Keep this deployment personal/small-scale unless Monzo approves a broader use. ([Developer API introduction](https://docs.monzo.com/))

### Webhooks

A registered webhook sends account data outside this design's boundary, to whatever URL was registered. Disconnecting the MCP client does not delete it. `register_webhook` therefore accepts HTTPS only and tells the model to use only URLs the user supplied. This limits, but cannot prevent, a prompt-injected agent registering an attacker's URL.

- Monzo does not document payload signatures. Receivers should put an unguessable secret in the URL and treat bodies as untrusted.
- Monzo lists only the webhooks "your application has registered", so `list_webhooks` will not show one registered through a different OAuth client.
- Monzo does not document deduplicating registrations, so the tool is marked non-idempotent and tells the model to check `list_webhooks` first.
- `bun run test:monzo:tools` checks each tool's method, path, form encoding, and HTTPS validation against a stubbed `fetch`. No live webhook has been registered.

## OAuth flow

1. The MCP client performs discovery, dynamic registration, and PKCE against `/monzo/*`.
2. `/monzo/authorize` renders fields for the user's confidential Monzo client ID and secret.
3. The Worker seals those credentials into the short-lived OAuth `state` artifact and redirects to Monzo. No scratch KV or server cookie is used.
4. `/monzo/callback` unseals the state, exchanges Monzo's code, initializes the coordinator with only the refresh-token hash, and seals the result into a 10-minute browser-held handoff.
5. The shared completion page polls `/monzo/complete`; Monzo's provider adapter reports ready only when `/accounts` succeeds. The Worker persists none of the handoff.
6. Once ready, the page creates a fresh two-minute authorization code and offers a clear return-to-client action.
7. The MCP client exchanges that code for client-held sealed MCP access and refresh tokens.
8. Valid MCP tool calls go directly to Monzo and never contact the coordinator.
9. Near upstream expiry, `/monzo/token` presents the sealed grant to the coordinator. Concurrent same-generation calls share one in-memory rotation result.

## When interactive OAuth is required again

Normal MCP access-token expiry does **not** require user interaction: the client refreshes automatically. Interactive authorization is needed when the current client-held grant can no longer produce or recover the current Monzo grant, including:

- the user revokes/deletes the Monzo OAuth client, changes its secret, or Monzo rejects the grant;
- another authorization using the same Monzo client evicts the connection's active token;
- the MCP client loses its current sealed refresh token or presents a stale generation;
- a Monzo refresh succeeds but the response is lost after the coordinator commits the successor hash—the hash-only coordinator intentionally cannot recover the token value;
- `SEAL_KEY` is rotated without retaining compatibility with existing sealed artifacts;
- Monzo requires periodic reconfirmation and the user does not complete it.

Concurrent refreshes themselves should not cause reauthorization: the coordinator's purpose is to collapse them to one upstream request. It deliberately cannot solve the lost-successful-response case without persisting recoverable token ciphertext, which would be a different security trade-off.

## Verification

`bun run test:monzo` launches the real Worker and Durable Object locally against a fake provider that enforces one-time rotating refresh tokens. It completes the public OAuth flow, sends 20 concurrent refresh requests, checks that exactly one reaches the provider, uses all 20 returned access tokens for concurrent MCP calls, and scans Durable Object persistence for credential/token sentinels.

The live proof script drives the same MCP OAuth surface against the deployed Worker and the user's own Monzo client. It does not print or persist OAuth tokens.
