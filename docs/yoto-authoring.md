# Yoto authoring and settings

This extends the adapter to 28 tools. Audio, art and settings use the same sealed
user grant; no files, signed source URLs or account data are written to server
storage. A Worker handles the bytes transiently; Yoto stores the uploaded media.
The client must enable `family:devices:manage` and reconnect for player settings.
Existing `user:content:manage` grants include icon management.

## Audio and artwork

1. `upload_audio({url, filename})` downloads a direct HTTPS audio URL, hashes its
   exact bytes, obtains Yoto's upload ticket and PUTs the bytes to signed storage.
2. `get_audio_upload({uploadId})` checks conversion once. Use the ready track
   reference with a general playlist, or pass the ID to `add_audio_to_card`.
3. `add_audio_to_card({title, tracks: [{uploadId, title}]})` creates a playlist;
   supply `cardId` and `expectedRevision` instead to append chapters to one.

For local files or audio over the server's 20 MiB import limit, a client with
filesystem access can hash the file and call `prepare_audio_upload`. Its hash
must be SHA-256 encoded as unpadded base64url. Upload exactly those bytes directly
to the returned signed URL with the audio MIME type; never include the Yoto
bearer token. If `uploadRequired` is false, skip PUT and check conversion.

`upload_cover_image({imageUrl})` returns a Yoto media URL. Use it as
`metadata.cover.imageL` in a playlist. `set_card_cover` combines upload and update,
requiring the current revision and retaining the existing tracks. Cover type
controls Yoto's crop/resize; the default is `myo`.

Player icons are separate from library cover artwork. `list_icons` lists either
public or personal icons; `upload_icon({imageUrl})` uploads a custom icon and
returns its `yoto:#...` reference for `display.icon16x16` on a chapter or track.

Imports require a correct audio/image Content-Type. Images accept JPEG, PNG, GIF
or WebP, up to 5 MiB. Downloads have a 30-second timeout and enforce limits on
both declared and actual bytes. URLs must use HTTPS, DNS hostnames and default
ports; credentials, local names, IP literals and redirects are rejected. Fetches
use Workers' public network path, not a private service binding. Source and
storage requests never receive Yoto authorization. Errors omit URL queries and
provider bodies. No automatic write retry is performed. A lost upload response
includes its upload ID so it can be checked before retrying.

## General playlist editing

`create_playlist` accepts ordered chapters, each containing ordered tracks.
`audio` tracks reference completed uploads; `stream` tracks reference HTTPS
media. Titles, keys, overlay labels/overrides, media metadata, chapter/track
icons, default display/ambient fields, cover and description are supported.
Chapter keys must be unique, and track keys unique within each chapter.

`get_playlist` returns the full content and a revision. `update_playlist` uses
that revision and preserves omitted fields. A supplied chapter array replaces
the whole list, enabling reorder, removal and replacement; include everything
to retain. Cover-only changes never replace chapters. The revision guard checks
for stale edits before submission; Yoto provides no documented atomic version
precondition, so simultaneous writers must still be avoided.

`config.shuffle` accepts ordered, non-overlapping ranges with inclusive zero-based
start/end indices and a count limit. For example, `[{start: 1, end: 4, limit: 2}]`
keeps chapter 0 as the intro and selects two of chapters 1–4. Tracks inside a
chapter stay ordered. Shuffle is for players, not app playback.

Linking a newly created playlist to a physical MYO card still uses the Yoto app
or player. Purchased content is not made editable by these tools. Experimental
text-to-speech generation is not included; the supported track types are those
on the requested playlist page: uploaded audio and streams.

## Player configuration

Resolve the intended player through `list_players`; do not guess when names are
ambiguous. For Ada's player, after obtaining its ID:

```json
{"deviceId":"<Ada's device ID>","limit":10,"period":"both"}
```

Pass that to `set_volume_limit`. Limits use the app's 0–16 steps, serialized to
native strings. `period` defaults to both; day/night can be updated independently.
This differs from `set_volume`, which changes current playback volume in percent.

`get_player_config` reads stored settings. `update_player_config` supports the
name, day/night schedules and volume limits, headphone limits, Bluetooth,
repeat, locale, clock/display, ambient colours, timeouts and day/night content
shortcuts. Only supplied fields are sent. A read-back reports whether the stored
values match; an offline device can apply them later. Alarms and beta shortcut
objects are not exposed by this typed settings tool.

## Evidence and validation

Primary references:

- [Playlist model](https://yoto.dev/myo/how-playlists-work/) and
  [content creation/update](https://yoto.dev/api/content/createorupdatecontent/).
- [Audio upload](https://yoto.dev/myo/uploading-to-cards/) and
  [upload-ticket API](https://yoto.dev/api/media/getanuploadurl/).
- [Cover API](https://yoto.dev/api/media/uploadcoverimage/),
  [cover metadata](https://yoto.dev/myo/uploading-cover-images/),
  [icon uploads](https://yoto.dev/icons/uploading-icons/) and
  [public icons](https://yoto.dev/api/icons/getpublicicons/).
- [Chapter shuffle](https://yoto.dev/myo/how-shuffle-works/).
- [Read settings](https://yoto.dev/api/devices/getdeviceconfig/) and
  [update settings](https://yoto.dev/api/devices/updatedeviceconfig/).

The previously recorded Android 4.0 APK corroborates these contracts:
`gh/InterfaceC5646a` has upload-ticket, storage PUT, transcode status and content
POST methods; `Sg/d` hashes file bytes using SHA-256 then base64url without padding;
`Gg/a` uploads binary covers; `Gg/c` lists/uploads icons; `tg/c` reads and PUTs
settings. `PlayerStatusConfig` and the settings view model use string maximum
limits. `UploadPlaylistResponse` wraps the saved card. Transcode parsing accepts
the documented `transcodedInfo` and the APK model's `mediaInfo` naming.

`bun run test:yoto:authoring` exercises actual tool schemas and handlers against
mocked HTTP, including exact file bytes, hash/deduplication, credential isolation,
size limits, URL rejection, pending conversion, stale edits, content preservation,
and volume wire format/read-back. `bun run test:yoto` additionally exercises the
real Worker boundary. Physical uploads and device application remain live checks;
no real account content or player settings were changed in development.
