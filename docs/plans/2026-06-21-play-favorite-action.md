# Play Favourite Action

## Overview

Add a new **"Play Favourite"** Stream Deck action to the Sonos plugin. A single key
press plays a pre-configured Sonos favourite (radio station, stream, single track,
playlist, or album) on the configured speaker. Resolves GitHub issue
[#12](https://github.com/pkarpovich/streamdeck-sonos/issues/12).

The action is a **static launcher**: in the Property Inspector the user picks a speaker,
the speaker's favourites list loads, and the user assigns one favourite to the button.
The button shows the favourite's album art. Pressing it replaces the speaker's current
source with that favourite and starts playback.

This plan was produced from a completed brainstorm. The design decisions are settled
(see Solution Overview, Non-Goals, Rejected Alternatives) - execution should implement
them, not re-open them.

### Non-Goals (v1 boundary)

- **No live state** on the button: no 5-second polling, no "currently playing this
  favourite" indicator. The button is static (album art + the user's own title).
- **No cover-art cache**: art is (re)rendered only on `onWillAppear` and on settings
  change - both rare. No per-action URL/base64 caches like play-pause has.
- **No `setTitle`**: the user names the button themselves; the action never overrides it.
- **No favourites management** (add/remove/reorder favourites) - read and play only.
- **No new SonosService device-resolution logic**: reuse `getDeviceByUuid` unchanged.

### Rejected Alternatives (do not re-introduce)

- **`device.AddUriToQueue(uri)` shortcut** - rejected: it internally calls
  `GuessMetaDataAndTrackUri(uri)` and discards the real favourite metadata, breaking
  streaming-service auth. Use the low-level `AVTransportService.AddURIToQueue` with the
  pre-rendered DIDL metadata instead.
- **Append-to-queue + seek** for container favourites - rejected in favour of
  "replace source" (`RemoveAllTracksFromQueue` first) for predictable press-to-play.
- **Shared `property-inspector.html` with a conditional favourites section** - rejected
  in favour of a separate `property-inspector-favorite.html` (per-action
  `PropertyInspectorPath`).
- **Persisting the raw `@svrooij/sonos` `Track`, or carrying `cdUdn`/`protocolInfo`
  fields in the domain type** - rejected in favour of an opaque pre-rendered DIDL
  `metadata` string, keeping the `Track` type confined to `SonosService`.

## Skills to invoke

Load each skill below with the Skill tool and follow its conventions before implementing
any task in this plan.

- No language-specific skill is available for TypeScript in this environment. The
  authoritative conventions for this plan are the project `CLAUDE.md` ("Error Handling
  Pattern", "Action UUIDs", architecture notes) and the user's global code-style rules,
  materialized in the Code-Quality Rules section below. Re-read that section at the start
  of every task.

## Context (from discovery)

- **Stack**: TypeScript ESM, Node 24, `@elgato/streamdeck` v2 SDK, `@svrooij/sonos@2.5.0`,
  Rollup bundle, Vitest, pnpm.
- **Files/areas involved**:
  - `src/services/sonos-service.ts` - singleton service; add `getFavorites` + `playFavorite`.
  - `src/services/sonos-service.test.ts` - existing vitest suite; add a new describe block.
  - `src/types/sonos-settings.ts` - base settings type to extend.
  - `src/actions/sonos-play-pause.ts` - the closest existing action pattern to mirror
    (KeyAction, `onSendToPlugin` discover branch, cover art via `getImageAsBase64`).
  - `src/plugin.ts` - action registration.
  - `src/utils/tryCatch.ts` - `{data,error}` result wrapper used everywhere.
  - `src/utils/image.ts` - `getImageAsBase64(absoluteUrl)`.
  - `com.pavel-karpovich.sonos.sdPlugin/ui/property-inspector.html` - existing PI to clone.
  - `com.pavel-karpovich.sonos.sdPlugin/manifest.json` - action registry; global
    `PropertyInspectorPath` (per-action override allowed).
- **Patterns found**:
  - `SonosService` is stateless per device: every method takes `uuid` and calls
    `getDeviceByUuid(uuid)`; transport operations route through `device.Coordinator`
    (established by the `previousTrack` fix, commit 614cbe0).
  - Actions go through `tryCatch`, log on error, never throw.
  - `onSendToPlugin` already handles `{action:'discover'}` and replies
    `{action:'deviceList', devices, selectedUuid}`.
- **Dependencies identified**:
  - `@svrooij/sonos` `SonosDevice.GetFavorites()` returns a `BrowseResponse` whose
    `Result` is a parsed `Track[]`.
  - `MetadataHelper.TrackToMetaData(track, includeResource, cdudn)` (from
    `@svrooij/sonos/lib/helpers/metadata-helper`) is the library's canonical DIDL
    serializer; `AVTransportService` `CurrentURIMetaData` / `EnqueuedURIMetaData` accept
    a `Track | string`, so a pre-rendered string is a valid metadata value.
  - **Icons already in repo** under `com.pavel-karpovich.sonos.sdPlugin/imgs/actions/favorite/`:
    `favorite_key.png` (72x72), `favorite_key@2x.png` (144x144), `favorite_action.png`
    (20x20), `favorite_action@2x.png` (40x40). No icon work remains.

## Development Approach

- **Testing approach**: Regular (implement, then add/adjust tests within the same task).
  Unit tests live in `src/services/sonos-service.test.ts` and cover the service layer
  (the only layer with non-trivial logic). Actions and PI HTML have no unit tests, matching
  the repository's existing convention (no action/PI tests exist) - they are verified by
  build + manual Stream Deck checks.
- Complete each task fully before the next; keep changes surgical (every changed line
  traces to this feature).
- Run `pnpm test` after each task that touches `src/services`; it must be green before
  moving on.
- Maintain backward compatibility: the five existing actions and the shared PI are
  untouched except for the additive manifest entry.

## Code-Quality Rules (verify before marking each task complete)

Materialized from project `CLAUDE.md` and the user's global code-style rules. A fresh
task session must verify against these before checking any `[x]`:

- **No comments or docstrings** - use clear names. (No code comments in any new file.)
- **Early-return pattern** - guard failure/edge cases first (`if (!device) return ...`),
  main logic flows flat.
- **Imports at the top of the file** - never inside functions/methods.
- **`tryCatch` for all async** - operations return `{data,error}`; log via
  `streamDeck.logger.error` on failure, never throw out of an action handler.
- **ASCII hyphens only** in all code, strings, and docs - no em/en dashes.
- **Surgical changes** - do not refactor or "improve" adjacent code.
- **Per-task gate**: `pnpm test` green (for service-touching tasks) and `pnpm build`
  succeeds before the task is considered done.

## Testing Strategy

- **Unit tests** (`src/services/sonos-service.test.ts`): required for `getFavorites` and
  `playFavorite` (Task 2). Follow the existing suite's mocking style: `vi.mock` for
  `@elgato/streamdeck`, `@svrooij/sonos`, and `./discovery-service`; inject a fake
  `manager.Devices` whose entries expose `Coordinator` and `AVTransportService`. Also
  `vi.mock("@svrooij/sonos/lib/helpers/metadata-helper")` so `TrackToMetaData` returns a
  known sentinel string the assertions can check.
- **No e2e/UI test harness** exists in this project; the action and PI are validated
  manually (see Post-Completion).

## Solution Overview

- **Domain boundary**: a local `SonosFavorite` type carries everything the app needs
  (`uri`, `upnpClass`, `title`, `albumArtUrl?`, `metadata`). The `@svrooij/sonos` `Track`
  type appears only inside `SonosService` (in `getFavorites` and a private `toFavorite`
  mapper). `metadata` is an opaque pre-rendered DIDL string, so playback never needs the
  `Track` shape again.
- **Playback** branches on `favorite.upnpClass`:
  - `object.container.*` (playlist/album/station container) -> replace the queue and play
    from it.
  - otherwise (`object.item.*`: radio/stream/single track) -> set the transport URI
    directly and play.
  All transport calls target `device.Coordinator` so grouped speakers work.
- **Property Inspector**: a dedicated HTML file reuses the existing device-selection block
  and adds a favourites dropdown driven by a new `loadFavorites` round-trip.
- **Action**: a thin static `KeyAction` - render cover on appear/settings-change, play on
  key down, serve `discover` and `loadFavorites` to the PI.

## Technical Details

### Types (contracts to lock)

```
// src/types/sonos-favorite.ts
type SonosFavorite = {
  uri: string;
  upnpClass: string;
  title: string;
  albumArtUrl?: string;
  metadata: string;   // pre-rendered DIDL, opaque to the app
}

// src/types/sonos-settings.ts (added)
type SonosFavoriteSettings = SonosSettings & { favorite?: SonosFavorite }
```

### SonosService additions (signatures)

```
getFavorites(uuid?: string): Promise<SonosFavorite[]>
playFavorite(uuid: string | undefined, favorite: SonosFavorite): Promise<boolean>
private toFavorite(track: Track): SonosFavorite   // Track confined to this file
```

- `toFavorite` maps a `Track`: `uri = TrackUri`, `upnpClass = UpnpClass`,
  `title = Title`, `albumArtUrl = AlbumArtUri` (already absolute), and
  `metadata = MetadataHelper.TrackToMetaData(track, true, track.CdUdn)`.
- `getFavorites` resolves the device via `getDeviceByUuid`, returns `[]` if none, calls
  `device.GetFavorites()`, and maps `Result` (a `Track[]`) through `toFavorite`. Wrap the
  device call in `tryCatch`; on error log and return `[]`.

### playFavorite mechanism (the non-obvious, correctness-critical part)

Resolve `device` via `getDeviceByUuid(uuid)`; if null, return `false`. Operate on
`const coord = device.Coordinator`. Branch on `favorite.upnpClass.startsWith("object.container")`:

- **Container path**, in this exact order (each step wrapped, abort + log + return `false`
  on the first failure):
  1. `coord.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 })`
  2. `coord.AVTransportService.AddURIToQueue({ InstanceID: 0, EnqueuedURI: favorite.uri,
     EnqueuedURIMetaData: favorite.metadata, DesiredFirstTrackNumberEnqueued: 0,
     EnqueueAsNext: false })`
  3. `coord.SwitchToQueue()`  (must be on `coord` - it builds `x-rincon-queue:<this.uuid>#0`)
  4. `coord.Play()`
- **Item path**:
  1. `coord.AVTransportService.SetAVTransportURI({ InstanceID: 0, CurrentURI: favorite.uri,
     CurrentURIMetaData: favorite.metadata })`
  2. `coord.Play()`

Gotchas to respect: do NOT use the `device.AddUriToQueue` shortcut (discards metadata);
metadata is mandatory for streaming services; `SwitchToQueue` and `Play` go through the
coordinator.

### PI <-> plugin message shapes

```
PI  -> plugin: { action: 'discover' }                      // existing
plugin -> PI : { action: 'deviceList', devices, selectedUuid }   // existing
PI  -> plugin: { action: 'loadFavorites' }                 // new
plugin -> PI : { action: 'favoriteList', favorites, selectedUri } // new
```

On favourite selection the PI calls `setSettings({ ...currentSettings, favorite })` with
the whole `SonosFavorite`. Changing the device clears the stored `favorite` and re-requests
`loadFavorites`.

## What Goes Where

- **Implementation Steps** (checkboxes): types, service + tests, action, PI HTML, manifest,
  verification, docs - all achievable in this repo.
- **Post-Completion** (no checkboxes): manual Stream Deck validation with a real speaker.

## Implementation Steps

### Task 1: Add SonosFavorite domain type and SonosFavoriteSettings

**Files:**
- Create: `src/types/sonos-favorite.ts`
- Modify: `src/types/sonos-settings.ts`

- [x] create `src/types/sonos-favorite.ts` exporting the `SonosFavorite` type from
      Technical Details (no library imports - pure domain type).
- [x] in `src/types/sonos-settings.ts` add `SonosFavoriteSettings = SonosSettings &
      { favorite?: SonosFavorite }`, importing `SonosFavorite` (mirrors how the volume
      action extends `SonosSettings`).
- [x] type-only change: no runtime unit tests. Validate via `pnpm build` (tsc) - it must
      compile clean. Behavioural coverage arrives with Task 2.

### Task 2: Add getFavorites + playFavorite to SonosService (with tests)

**Files:**
- Modify: `src/services/sonos-service.ts`
- Modify: `src/services/sonos-service.test.ts`

- [x] import `MetadataHelper` from `@svrooij/sonos/lib/helpers/metadata-helper` and the
      `SonosFavorite` type; add the private `toFavorite(track)` mapper per Technical Details.
- [x] implement `getFavorites(uuid?)`: resolve device, `tryCatch(device.GetFavorites())`,
      map `Result` through `toFavorite`, return `[]` on no-device/error (log on error).
- [x] implement `playFavorite(uuid, favorite)`: coordinator-routed container/item branch
      exactly as specified in Technical Details; each transport step wrapped in `tryCatch`,
      abort + log + return `false` on first failure, return `true` on success.
- [x] add `vi.mock("@svrooij/sonos/lib/helpers/metadata-helper")` returning a
      `TrackToMetaData` that yields a known sentinel string.
- [x] write `playFavorite` CONTAINER test: assert call ORDER
      `RemoveAllTracksFromQueue -> AddURIToQueue -> SwitchToQueue -> Play` on the
      coordinator, and that `AddURIToQueue` received `EnqueuedURIMetaData === favorite.metadata`.
- [x] write `playFavorite` ITEM test: `SetAVTransportURI` (with
      `CurrentURIMetaData === favorite.metadata`) then `Play`; assert no queue calls.
- [x] write `playFavorite` error test: a throwing transport call -> returns `false` and
      `streamDeck.logger.error` was called.
- [x] write `getFavorites` test: a fake `GetFavorites` returning a `Track[]` maps to
      `SonosFavorite[]` with the correct shape (`uri/upnpClass/title/albumArtUrl/metadata`).
- [x] run `pnpm test` - must pass before Task 3.

### Task 3: Add SonosPlayFavoriteAction and register it

**Files:**
- Create: `src/actions/sonos-play-favorite.ts`
- Modify: `src/plugin.ts`

- [x] create `SonosPlayFavoriteAction extends SingletonAction<SonosFavoriteSettings>` with
      `@action({ UUID: "com.pavel-karpovich.sonos.favorite" })`, holding
      `SonosService.getInstance()`.
- [x] `onWillAppear` / `onDidReceiveSettings`: `rememberDevice(deviceUuid, ipAddress)` then
      `renderCover(action, settings.favorite)`. No intervals, no caches.
- [x] `onSendToPlugin`: handle `discover` (return device list, same as existing actions) and
      `loadFavorites` (`getFavorites(uuid)` -> `sendToPropertyInspector({ action:'favoriteList',
      favorites, selectedUri: settings.favorite?.uri })`).
- [x] `onKeyDown`: if no `settings.favorite` -> `showAlert()`; else `playFavorite` and
      `showOk()`/`showAlert()` on the boolean result.
- [x] private `renderCover(action, favorite)`: return early if no `albumArtUrl`; else
      `action.setImage(await getImageAsBase64(favorite.albumArtUrl))`. Never call `setTitle`.
- [x] register `new SonosPlayFavoriteAction()` in `src/plugin.ts`.
- [x] no unit tests for the action (consistent with the repo - no action tests exist);
      covered by `pnpm build` + manual validation. Run `pnpm build` - must succeed.

### Task 4: Add the dedicated Property Inspector

**Files:**
- Create: `com.pavel-karpovich.sonos.sdPlugin/ui/property-inspector-favorite.html`

- [x] clone the device-selection block (paired/discovery views, discover round-trip,
      `deviceList` handling) from `ui/property-inspector.html`.
- [x] add a favourites `<sdpi-item>` with a `<select>`; after a device is present, send
      `{ action:'loadFavorites' }` and populate the dropdown from the `favoriteList` reply
      (option label = `favorite.title`, pre-select `selectedUri`).
- [x] on favourite change, `setSettings({ ...currentSettings, favorite })`; on device change,
      clear the stored `favorite` and re-request `loadFavorites`.
- [x] no unit tests (PI HTML, matching repo convention); validated manually in Stream Deck.

### Task 5: Register the action in the manifest

**Files:**
- Modify: `com.pavel-karpovich.sonos.sdPlugin/manifest.json`

- [x] add an `Actions` entry: `Name "Play Favourite"`, `UUID
      "com.pavel-karpovich.sonos.favorite"`, `Icon "imgs/actions/favorite/favorite_key"`,
      `Tooltip "Play a Sonos favourite"`, per-action `PropertyInspectorPath
      "ui/property-inspector-favorite.html"`, `Controllers ["Keypad"]`, a single `States`
      entry with `Image "imgs/actions/favorite/favorite_key"` and `TitleAlignment "middle"`.
- [x] confirm the decorator UUID equals the manifest UUID; do not bump manifest `Version`
      (handled at release).
- [x] run `pnpm validate` - manifest must pass.

### Task 6: Verify acceptance criteria

- [ ] verify all Overview requirements: a favourite can be assigned per button and played;
      container and item favourites both handled; cover art renders; no polling/indicator.
- [ ] verify edge cases: button with no favourite configured shows an alert on press;
      missing album art leaves the default icon.
- [ ] run full suite: `pnpm test` (green).
- [ ] run `pnpm build` (succeeds) and `pnpm validate` (manifest valid).

### Task 7: Update documentation and close the plan

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

- [ ] add "Play Favourite Button" to README's **Available Actions** section.
- [ ] add `com.pavel-karpovich.sonos.favorite` to the **Action UUIDs** list in `CLAUDE.md`.
- [ ] move this plan to `docs/plans/completed/`.

## Post-Completion

*Items requiring manual intervention or external systems - informational only.*

**Manual verification** (real speaker + Stream Deck required):
- `pnpm build`, then load/restart the plugin in Stream Deck.
- Drag "Play Favourite" onto a key; in the PI pick a speaker, confirm the favourites list
  loads, assign one; confirm the album art appears on the key.
- Press the key with a **radio/stream** favourite - confirm it starts.
- Press the key with a **playlist/album** favourite - confirm the queue is replaced and it
  starts.
- Verify behaviour on a **grouped** speaker (favourite plays via the group coordinator).
- Optionally reply on issue #12 once shipped.
