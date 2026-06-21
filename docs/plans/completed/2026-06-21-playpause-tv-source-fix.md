# Play/Pause Resumes Music From a Non-Queue Source

## Overview

Fix the play/pause key doing nothing when the speaker's active source is not the
music queue (typically a Sonos Arc on TV input). Resolves GitHub issue
[#13](https://github.com/pkarpovich/streamdeck-sonos/issues/13).

Today `togglePlayPause` delegates to `SonosDevice.TogglePlayback()`, which only
plays/pauses the *current* source. When the source is the TV input
(`x-sonos-htastream:<uuid>:spdif`) the device reports state `PLAYING`, so
`TogglePlayback()` sends `Pause`; the TV line-in stream cannot be paused and the
speaker returns `UPnPError 701 (Transition not available)`. The toggle fails, the key
flashes an alert, and nothing happens. The logs show 18 such `701` errors, all in the
evening (TV time).

The fix: when `TogglePlayback()` fails specifically with `701`, fall back to switching
the speaker to its queue and playing - so the play key means "resume my Sonos music"
when the current source can't be toggled.

### Non-Goals (boundary)

- **Only react to `701`** (`Transition not available`). Other failures (network errors,
  other UPnP codes) keep the current behavior: log + return `false`. No broad
  "retry on any error".
- **No empty-queue recovery**: if the queue has never had music, `SwitchToQueue` + `Play`
  cannot start anything. That stays a failed press (alert). Not handled in this change.
- **No new action, no UI/manifest/PI changes**: the existing Play/Pause action is
  untouched; only `SonosService.togglePlayPause` changes.
- **No change to `next/previous/shuffle`**: issue #13 is about play/pause. The one `Next`
  `701` in the logs is out of scope here.

### Rejected Alternatives (do not re-introduce)

- **Proactive "current URI is not `x-rincon-queue:` -> SwitchToQueue+Play" check** -
  rejected: a currently-playing radio/stream favourite also has a non-queue
  `CurrentURI`, so a proactive switch would yank the user off a working radio instead of
  pausing/stopping it. Reacting only to an actual `701` avoids regressing the
  radio/stream and normal-queue cases.
- **Falling back on ANY `TogglePlayback` error** - rejected: a transient network failure
  during a normal pause would then attempt a source switch. Gate strictly on
  `UpnpErrorCode === 701`.
- **String-matching the error message for "701"** - rejected: `SonosError` exposes a
  structured `UpnpErrorCode: number`; match on that.

## Skills to invoke

Load each skill below with the Skill tool and follow its conventions before implementing
any task in this plan.

- No language-specific skill is available for TypeScript in this environment. The
  authoritative conventions are the project `CLAUDE.md` ("Error Handling Pattern",
  architecture notes) and the user's global code-style rules, materialized in the
  Code-Quality Rules section below. Re-read that section at the start of every task.

## Context (from discovery)

- **Stack**: TypeScript ESM, Node 24, `@elgato/streamdeck` v2 SDK, `@svrooij/sonos@2.5.0`,
  Vitest, pnpm.
- **Files/components involved**:
  - `src/services/sonos-service.ts` - `togglePlayPause` (lines 162-168) is the only code
    that changes.
  - `src/services/sonos-service.test.ts` - existing vitest suite; add a `togglePlayPause`
    describe block.
- **Related patterns found**:
  - All transport operations route through `device.Coordinator` (the `previousTrack` fix,
    commit 614cbe0). `SonosDevice.Play()` is already coordinator-routed.
  - Service methods take a `uuid`, resolve via `getDeviceByUuid`, wrap calls in `tryCatch`,
    log on error, return a boolean. `togglePlayPause` follows this exactly.
- **Dependencies identified**:
  - `SonosError` (`@svrooij/sonos/lib/models/sonos-error`) carries a structured
    `UpnpErrorCode?: number`; `701` is "Transition not available".
  - `SonosDevice.SwitchToQueue()` (`sonos-device.js:574`) sets
    `x-rincon-queue:<this.uuid>#0` and does NOT auto-play, so an explicit `Play()` is
    required. It uses `this.uuid`, so it must be called on `device.Coordinator` for
    grouped speakers.

## Development Approach

- **Testing approach**: Regular (implement the fix, then add the unit tests in the same
  task). Tests live in `src/services/sonos-service.test.ts` and follow the existing
  mocking style (fake `manager.Devices` with injected fakes).
- Single focused behavioral change; keep it surgical - no edits outside `togglePlayPause`
  and its tests (plus a docs note).
- `pnpm test` must be green before the verification task.

## Code-Quality Rules (verify before marking each task complete)

Materialized from project `CLAUDE.md` and the user's global code-style rules:

- **No comments or docstrings** - clear names instead.
- **Early-return pattern** - guard edge cases first; main path flows flat.
- **Imports at the top of the file** - never inside functions.
- **`tryCatch` for all async** - return `{data,error}`; log via `streamDeck.logger.error`;
  never throw out of the service.
- **ASCII hyphens only** - no em/en dashes anywhere.
- **Surgical changes** - do not refactor adjacent code.
- **Per-task gate**: `pnpm test` green and `pnpm build` succeeds before checking `[x]`.

## Testing Strategy

- **Unit tests** (`src/services/sonos-service.test.ts`): the only required tests. Inject a
  fake device exposing `TogglePlayback` and `Coordinator: { SwitchToQueue, Play }`. Model
  a `701` failure as a rejection carrying `{ UpnpErrorCode: 701 }` (the code duck-types the
  field, so no `SonosError` import is needed in tests).
- No e2e/UI harness exists; real-speaker behaviour is verified manually (Post-Completion).

## Solution Overview

`togglePlayPause(uuid)` keeps its current happy path (resolve device, `TogglePlayback()`,
return `true` on success). The change is the error branch: if the failure is a `701`,
treat the press as "resume music" - operate on `device.Coordinator`, call
`SwitchToQueue()` then `Play()`, and return `true` only if both succeed. Any non-`701`
error keeps the existing behaviour (log + `false`). This makes a play press after TV start
the music queue, without regressing normal queue toggling or currently-playing
radio/streams (which never reach the `701` branch on a normal play press).

## Technical Details

### Signature (unchanged)

```
togglePlayPause(uuid?: string): Promise<boolean>
```

### Control flow (the only change)

1. `device = getDeviceByUuid(uuid)`; if null, return `false` (unchanged).
2. `tryCatch(device.TogglePlayback())`; on no error, return `true` (unchanged).
3. On error, detect a `701`: read `UpnpErrorCode` off the error (`error?.UpnpErrorCode ===
   701`). If it is NOT `701`, log the error and return `false` (existing behaviour).
4. If it IS `701`: `coord = device.Coordinator`. `tryCatch(coord.SwitchToQueue())` then
   `tryCatch(coord.Play())`; if either errors, log and return `false`; otherwise return
   `true`.

701 detection is by the structured `UpnpErrorCode` number, not by string-matching the
message. `SwitchToQueue` and `Play` both go through `coord` (coordinator) so grouped
speakers resume on the correct queue.

## What Goes Where

- **Implementation Steps** (checkboxes): the service change + unit tests + a short docs
  note - all in this repo.
- **Post-Completion** (no checkboxes): manual verification with the Arc on TV input.

## Implementation Steps

### Task 1: Add 701 fallback to togglePlayPause (with tests)

**Files:**
- Modify: `src/services/sonos-service.ts`
- Modify: `src/services/sonos-service.test.ts`

- [x] in `togglePlayPause`, keep the happy path; on a `TogglePlayback` error, branch on
      `UpnpErrorCode === 701` per Technical Details (non-701 -> existing log + `false`).
- [x] on `701`, run `device.Coordinator.SwitchToQueue()` then `device.Coordinator.Play()`,
      each via `tryCatch`; return `false` (with log) if either fails, else `true`.
- [x] write test: `TogglePlayback` succeeds -> returns `true`, and neither `SwitchToQueue`
      nor `Play` is called.
- [x] write test: `TogglePlayback` rejects with `{ UpnpErrorCode: 701 }` -> calls
      `Coordinator.SwitchToQueue` then `Coordinator.Play`, returns `true`.
- [x] write test: `701` then `SwitchToQueue` (or `Play`) fails -> returns `false`, logs.
- [x] write test: `TogglePlayback` rejects with a non-701 error (e.g. a network error) ->
      returns `false`, logs, and does NOT call `SwitchToQueue` (no regression).
- [x] run `pnpm test` - must pass before Task 2.

### Task 2: Verify acceptance criteria and document

**Files:**
- Modify: `README.md`

- [x] verify the Overview behaviour: a `701` on play/pause now resumes the queue; normal
      queue toggling and non-701 failures are unchanged.
- [x] run `pnpm test` (green) and `pnpm build` (succeeds).
- [x] add a short line to README's **Troubleshooting**: pressing Play after watching TV
      switches the speaker back to your music queue.
- [x] move this plan to `docs/plans/completed/`.

## Post-Completion

*Manual verification - real speaker required, no checkboxes.*

- `pnpm build`, reload the plugin in Stream Deck.
- Play TV audio through the Arc, then press the Play/Pause key: the music queue should
  start on the first press (no alert).
- With music already on the queue: Play/Pause still toggles play/pause as before.
- Note the known limitation: if the queue is empty, the press cannot start anything.
- Optionally close issue #13 referencing the implementing PR/commit.
