# Yoto integration research

Researched 28 September 2026. Implementation targets the published developer
API; no APK was downloaded or decompiled.

## Existing MCP servers

There are community implementations, so Yoto does not need to be reverse
engineered from its Android application:

- [bperkinspdx/yoto-mcp-server](https://github.com/bperkinspdx/yoto-mcp-server)
  provides a Node/stdio MCP server for audio upload and MYO content. Its source
  uses device authorization and a local `~/.yoto-mcp-config.json` token file.
- [vgaro/yotocli](https://github.com/vgaro/yotocli) provides a Go CLI with MCP
  support, local audio processing, library editing and player commands. Its
  current login uses browser OAuth with PKCE and local token storage.

Neither is a drop-in adapter for this project's Cloudflare Worker and
client-held sealed grants. This implementation uses Yoto's documented HTTP
API directly, adds no runtime dependency, and does not copy either server.

## Authentication and storage

[Yoto's developer portal](https://dashboard.yoto.dev/) issues application
credentials. Its [glossary](https://yoto.dev/get-started/glossary/) distinguishes
public clients (PKCE) from confidential server clients (client secret).

The adapter uses the existing `user-client-oauth` contract, like Monzo:

1. The user creates a confidential Yoto application with
   `https://<worker>/yoto/callback` as its allowed callback.
2. The shared setup form collects the client ID and secret into sealed state.
3. The browser visits `https://login.yotoplay.com/authorize`, with audience
   `https://api.yotoplay.com`. The user enters their password only on Yoto.
4. The Worker exchanges the code at `https://login.yotoplay.com/oauth/token`.
   MCP-facing authorization continues to require PKCE S256.
5. Access and refresh tokens are sealed into the MCP client's protocol tokens.

The [authentication guide](https://yoto.dev/authentication/browser-auth/)
documents the endpoints, audience and single-use rotating refresh tokens.
The Yoto coordinator follows the existing Monzo design: persistent state holds
only a generation number and SHA-256 refresh-token hash. A concurrent burst
shares one rotation; retries can use the result held in memory for 30 seconds.
After that window, stale generations fail before contacting Yoto. Unexpired
upstream access tokens are reused without rotation.

This does not recover a rotated token after a crash or a lost response beyond
the retry window. Reconnect in that case. No password, developer secret,
access token, refresh token, card data or player data is persisted by the
adapter. The running Worker necessarily sees credentials while handling a
request, and a client still needs to protect its sealed tokens.

Requested [scopes](https://yoto.dev/authentication/scopes/):
`family:library:view user:content:manage family:devices:view offline_access`.
Content management includes content viewing; player control, player settings,
family member details and profile access are not requested.

## Tool coverage and API evidence

| Tool | Upstream request | Primary reference |
| --- | --- | --- |
| `list_players` | `GET /device-v2/devices/mine` | [Devices](https://yoto.dev/api/devices/getdevices/) |
| `list_myo_cards` | `GET /content/mine` | [MYO content](https://yoto.dev/api/content/getusersmyocontent/) |
| `get_card` | `GET /content/{cardId}` | [Content details](https://yoto.dev/api/content/getcontent/) |
| `list_library_groups` | `GET /card/family/library/groups` | [Library groups](https://yoto.dev/api/family-library-groups/getgroups/) |
| `get_library_group` | `GET /card/family/library/groups/{groupId}` | [Group details](https://yoto.dev/api/family-library-groups/getagroup/) |
| `create_streaming_card` | `POST /content` | [Create content](https://yoto.dev/api/content/createorupdatecontent/), [streaming tracks](https://yoto.dev/myo/streaming-tracks/) |

Streaming creation makes one chapter per supplied track using the documented
`trackUrl`, `type: stream` and `format` fields. It only passes HTTPS audio URLs
to Yoto; the Worker never downloads the audio. Playback requires internet.
Link the resulting playlist to a physical MYO card using the Yoto app.

## Boundaries and validation

- `list_myo_cards` is not the purchased-card library. Library groups can contain
  other accessible content but are not a complete enumeration of ungrouped cards.
- No local-file uploads, transcoding, physical-card linking, deletion or
  playback commands are implemented in this initial adapter.
- The documented [REST status endpoint](https://yoto.dev/api/devices/getdevicestatus/)
  is deprecated and requires a scope absent from the public scope list. Current
  [live status](https://yoto.dev/players-mqtt/getting-player-status/) uses MQTT.
  `list_players` reports only the inventory's online flag; it does not claim to
  provide live battery or playback state.
- The real Worker is tested locally against a fake Yoto service, including
  browser OAuth, PKCE rejection, token-response validation, all tools, invalid
  inputs, error redaction, cross-provider token rejection, 20 concurrent
  refreshes, stale-generation rejection and a scan of durable storage for
  credential sentinels.
- No real Yoto account, developer client or physical player was used for
  validation. Provider-side acceptance of a new confidential client and actual
  card creation remain live checks. The implementation is based on documentation,
  not a claim that those live checks passed.

Run `bun run test:yoto` for the local protocol and tool proof. It starts and
stops its own Worker and fake provider, and removes its temporary durable state.
