# Yoto integration research

Researched 28 September 2026. Content tools use the published developer API;
playback and full library discovery were traced through the Android APK.

## Existing MCP servers

There are existing community implementations:

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
`family:library:view user:content:manage family:devices:view family:devices:control family:devices:manage offline_access`.
Content management includes content viewing. Player control is now requested;
existing connections must enable this scope in their developer client and
reconnect to consent. Refreshing an old grant does not add scopes. Player
settings now require `family:devices:manage`; family member details and profile
access are not requested. See [authoring/config additions](yoto-authoring.md).

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

- `list_myo_cards` covers MYO only; `list_library` uses the Android family library
  view, and `get_library_card` obtains chapters/tracks for purchased content.
- Audio imports, direct file-upload handoff, provider transcoding, covers and icons
  are supported by the authoring tools. Physical-card linking and deletion are not.
- Player commands use Android REST endpoints. A successful empty HTTP response
  means the command was accepted, not that an offline player executed it. No
  automatic retry is performed.
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
  card creation/playback remain live checks. Android endpoints may have different
  authorization requirements for developer clients; a 403 is surfaced with a
  scope/reconnect hint. No official-app OAuth credentials are extracted or reused.

Run `bun run test:yoto` for the local protocol and tool proof. It starts and
stops its own Worker and fake provider, and removes its temporary durable state.

## Android playback evidence

APK: `com.yotoplay.yoto`, version **4.0**, version code **15800**. Retrieved from
[APKPure's Yoto download](https://apkpure.net/yoto-music-stories-sleep/com.yotoplay.yoto/download)
on 28 September 2026 and decompiled with JADX. Base APK SHA-256:
`57583987ad242373fc83eec33f8b237eb51701fd1cec3421ae52c77aa8833fa6`.
No APK, decompiled source, app credentials or bundled signed media URLs are committed.
JADX reported errors in unrelated methods; the interfaces, request models and
bundled fixtures below were readable. Decompiled class filenames may differ in
case/obfuscation; the package and method/route identify each reference.

| Tool | APK HTTP request | Request body |
| --- | --- | --- |
| `list_library` | GET `/card/family/library?view=groups` | — |
| `get_library_card` | GET `/card/details/{cardId}?timezone={timezone}` | — |
| `play_card` | POST `/device-v2/{deviceId}/command/card-play` | `uri`, optional `chapterKey`/`trackKey`, `secondsIn`, `cutOff: 0` |
| `pause_playback` | POST `/device-v2/{deviceId}/command/card-pause` | `{}` |
| `resume_playback` | POST `/device-v2/{deviceId}/command/card-resume` | `{}` |
| `stop_playback` | POST `/device-v2/{deviceId}/command/card-stop` | `{}` |
| `set_volume` | POST `/device-v2/{deviceId}/command/set-volume` | `volume` (0–100) |
| `set_sleep_timer` | POST `/device-v2/{deviceId}/command/sleep` | `seconds` |

Evidence trail:

- `de/InterfaceC4772a` (DevicePlaybackService): Retrofit routes and HTTP methods.
- `de/C4773b`: uses `{}` for pause/resume/stop; constructs PlayCardRequest,
  VolumeRequest and SleepTimerRequest; play response reads `x-amzn-RequestId`.
- `com/yotoplay/yoto/datamodels/PlayCardRequest` and its Moshi adapter: exact
  serialized field names. SleepTimerRequest and VolumeRequest likewise.
- `Uf/a` (DevicePlaybackRepository): card URI is `https://yoto.io/` + card ID;
  normal play passes `cutOff: 0`. Volume maps the UI's 0–16 steps to
  `ceil(step * 6.25)` before invoking the API. The MCP accepts the resulting
  percentage directly, avoiding a mistaken 0–16 wire scale.
- `rd/c` and `rd/d`: family library route and dynamic card/details URL with
  timezone query. Details do not use the separate resolve/addToFamily flow.
- Bundled `assets/wiremock/mappings/postPlayOnPlayer.json`: POST card-play
  succeeds with HTTP 200 **and no body**. `getLibrary.json` and
  `getCardDetails_afr13.json` independently confirm the discovery routes.

`play_card` also supports choosing a track or seeking to seconds within one;
relative next/previous requires current playback state and is not claimed here.
Real-time MQTT state/acknowledgements remain outside this REST adapter. Requests
are authenticated with the user's own developer client, using the public
[control scope](https://yoto.dev/authentication/scopes/).
