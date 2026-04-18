# Refactor SonosService to per-call UUID (stateless device resolution)

## Overview

Fixes issue #7 ("Selected device not applied — plugin ignores device selection") and the broader multi-device bug it uncovers. Today `SonosService` is a process-wide singleton that caches one `SonosDevice` in `this.device`. The Property Inspector saves `deviceUuid` per action, but every action shares the same service state, so:

- Changing a device in PI does not switch the active device until the plugin restarts (the reported symptom — no `onDidReceiveSettings` handler).
- Even with that handler, two buttons configured for two different Sonos devices race each other — whichever action most recently called `initialize`/`onWillAppear` wins, and the per-button polling reads state from the wrong device.
- `ensureInitialized` only checks `isInitialized && device`, never compares against the button's configured UUID.

The root cause is architectural: per-action settings vs per-process device state. This plan removes `this.device` from the service entirely and resolves the device by UUID on every call, so each action always operates on its own configured device.

## Context (from discovery)

- **Files involved**:
  - `src/services/sonos-service.ts` — remove stateful `this.device`, `isInitialized`, `initialize`, `ensureInitialized`, `selectDeviceByUuid`; add `getDeviceByUuid`; make all operational methods take `uuid`.
  - `src/services/discovery-service.ts` — no changes expected (already stateless).
  - `src/actions/sonos-play-pause.ts`, `sonos-volume-dial.ts`, `sonos-next-track.ts`, `sonos-prev-track.ts`, `sonos-toggle-shuffle.ts` — thread `settings.deviceUuid` through every service call; add `onDidReceiveSettings` for UI refresh.
  - `src/types/sonos-settings.ts` — unchanged (shape already has `deviceUuid`).
  - `package.json` — add `vitest` + test script.
  - `com.pavel-karpovich.sonos.sdPlugin/ui/property-inspector.html` — unchanged (already emits `deviceUuid` in settings).
- **Related patterns found**:
  - `tryCatch` utility (`src/utils/tryCatch.ts`) wraps every async operation — continue using it.
  - Actions log errors via `streamDeck.logger.error` — keep that pattern.
  - `@svrooij/sonos` `SonosManager.InitializeFromDevice(ip)` populates `manager.Devices` via Sonos topology; one init is usually enough to see all devices in the same household.
- **Dependencies identified**:
  - `@svrooij/sonos` v2.5.0 — `SonosManager`, `SonosDevice`, `PlayMode`.
  - `bonjour-service` for mDNS — reused for the "device not in manager" fallback.
- **Resolver strategy chosen**: lazy init of `SonosManager` on first call; if UUID is not in `manager.Devices`, run mDNS discovery and call `InitializeFromDevice` on the matching IP; cache results in the manager (no extra cache layer).
- **Tests**: project currently has none. Adding `vitest` and covering only the new `getDeviceByUuid` resolver (the riskiest piece). Actions are SDK-bound and verified manually.

## Development Approach

- **Testing approach**: Regular (code first, then tests). Unit tests are scoped to the `getDeviceByUuid` resolver — it is the only piece where logic is non-trivial and easy to mock. Actions and service operational methods that are thin wrappers around `@svrooij/sonos` calls are verified via manual smoke.
- Complete each task fully before moving to the next.
- Make small, focused changes. Every changed line traces directly to the refactor goal.
- **CRITICAL: every task with new resolver logic MUST include tests in the same task.**
- **CRITICAL: all tests must pass before starting the next task — no exceptions.**
- **CRITICAL: update this plan file when scope changes during implementation** (`➕` for new tasks, `⚠️` for blockers).
- Run `pnpm build` after each task that touches TS sources to catch type errors early.
- No backwards-compatibility shims — remove old `initialize`/`selectDeviceByUuid`/`getDevice` cleanly. If a caller still references them after the refactor, update the caller, don't re-export.

## Testing Strategy

- **Unit tests**: required for `getDeviceByUuid` (success path, fallback path, uuid-missing path, no-uuid default path).
- **E2E tests**: project has none, and Stream Deck UI is hardware-dependent. Manual smoke checklist lives in Post-Completion.
- **Build as a type check**: `pnpm build` (rollup + tsc) is the effective lint/type-check for every task.

## Progress Tracking

- Mark completed items with `[x]` immediately when done.
- Add newly discovered tasks with `➕` prefix.
- Document issues/blockers with `⚠️` prefix.
- Update plan if implementation deviates from original scope.

## What Goes Where

- **Implementation Steps** (`[ ]`): code, unit tests, build/validate runs — automatable.
- **Post-Completion** (no checkboxes): manual Stream Deck smoke, PR/issue actions.

## Implementation Steps

### Task 1: Add vitest test runner

- [x] add `vitest` to `devDependencies` in `package.json`
- [x] add `"test": "vitest run"` and `"test:watch": "vitest"` scripts (replacing the current placeholder `"test": "streamdeck -v"`)
- [x] create `vitest.config.ts` at repo root with node environment, `include: ["src/**/*.test.ts"]`
- [x] add a trivial `src/utils/tryCatch.test.ts` to verify the runner actually executes (success + thrown-error cases)
- [x] run `pnpm install` then `pnpm test` — must pass before Task 2

### Task 2: Add `getDeviceByUuid` resolver in SonosService

- [x] add private field `manager?: SonosManager` (kept), remove unused state fields later in Task 4
- [x] add private async method `ensureManager(seedIp?: string): Promise<SonosManager | null>`:
  - if `this.manager` already has devices, return it
  - if `seedIp` provided, `new SonosManager()` + `InitializeFromDevice(seedIp)`; assign to `this.manager`; return
  - otherwise run `discoverSonosDevices()`, pick the first result's `ip` as seed, and init as above
  - return `null` on failure, log via `streamDeck.logger.error`
- [x] add public async method `getDeviceByUuid(uuid?: string): Promise<SonosDevice | null>`:
  - if `uuid` is empty: call `ensureManager()`; return `manager.Devices[0] ?? null` (preserves today's "no settings -> first device" behavior)
  - call `ensureManager()`; look for `manager.Devices.find(d => d.Uuid === uuid)`; return if found
  - if not found: run fresh mDNS discovery, find entry with matching uuid, call `InitializeFromDevice(entry.ip)`, then re-scan `manager.Devices`; return match or `null`
  - wrap every async boundary in `tryCatch`; log and return `null` on any failure
- [x] create `src/services/sonos-service.test.ts` covering `getDeviceByUuid` only, with mocks for `SonosManager` and `discoverSonosDevices`:
  - device present in manager -> returns it without re-discovery
  - uuid not in manager, present in mDNS -> triggers `InitializeFromDevice` with matching IP and resolves
  - uuid missing everywhere -> returns `null`, logs error
  - no uuid provided -> returns `manager.Devices[0]`
  - no uuid AND manager has zero devices -> returns `null`
- [x] run `pnpm test` — must pass before Task 3

### Task 3: Refactor SonosService operational methods to per-call UUID

- [x] change signatures to accept `uuid?: string`:
  - `togglePlayPause(uuid)`, `nextTrack(uuid)`, `previousTrack(uuid)`
  - `getPlayState(uuid)`, `getCurrentTrack(uuid)`
  - `getVolume(uuid)`, `setVolume(uuid, volume)`, `adjustVolume(uuid, adjustment)`
  - `toggleMute(uuid)`, `getMute(uuid)`
  - `getShuffleMode(uuid)`, `toggleShuffle(uuid)`
- [x] each method replaces `this.device!` with `const device = await this.getDeviceByUuid(uuid)` and returns a safe default (false / 0 / null / "STOPPED") if device is `null`
- [x] keep `discoverDevices()` as-is (used by PI "Discover" button; device-agnostic)
- [x] delete now-unused members: `device`, `isInitialized`, `initialize`, `ensureInitialized`, `selectDeviceByUuid`, `getDevice`, `getDevices`
- [x] run `pnpm build` — must succeed (TS will flag any caller left behind)
- [x] run `pnpm test` — must pass before Task 4

### Task 4: Update 5 actions to thread `settings.deviceUuid`

- [x] in `onWillAppear` of each action: replace `sonosService.initialize(ip, uuid)` with a simple first-render call (e.g. `updateButtonState(ev.action, settings.deviceUuid)`), since there is nothing to "initialize" anymore
- [x] in every handler (`onKeyDown`, `onDialRotate`, `onDialDown`, `onTouchTap`, `onTriggerDescription`, timer callbacks): pass `settings.deviceUuid` (read via `ev.action.getSettings()` where needed) into the service call
- [x] adjust `updateButtonState` / `updateDialDisplay` helpers to accept a `uuid` parameter and pass it through
- [x] replace the `sonosService.getDevice()` usage in `sonos-volume-dial.ts:199` with `await sonosService.getDeviceByUuid(uuid)` for the `setTriggerDescription` path
- [x] for `src/actions/sonos-volume-dial.ts` the `setInterval` polling callback must read the latest `settings` via `ev.action.getSettings()` so device change via PI is picked up on the next tick
- [x] run `pnpm build` — must succeed
- [x] run `pnpm test` — must pass before Task 5

### Task 5: Add `onDidReceiveSettings` for live device switch

- [ ] add `override async onDidReceiveSettings(ev: DidReceiveSettingsEvent<SonosSettings>)` to all 5 actions
- [ ] implementation: call the action's existing `updateButtonState` / `updateDialDisplay` helper with the new `settings.deviceUuid` so the button image/state immediately reflects the newly selected device (play state, volume, shuffle icon, cover art)
- [ ] for `sonos-play-pause.ts`: reset `currentTrackUri`/`cachedCoverUrl`/`cachedCoverBase64` when uuid changes, to force cover reload
- [ ] run `pnpm build` — must succeed
- [ ] run `pnpm test` — must pass before Task 6

### Task 6: Verify acceptance criteria

- [ ] verify `getDeviceByUuid` is the single resolution path — `grep` confirms no remaining `this.device`, `initialize(`, `selectDeviceByUuid`, `ensureInitialized`, `sonosService.getDevice` references
- [ ] verify every action passes `settings.deviceUuid` into every `sonosService.*` call (no zero-arg calls to operational methods)
- [ ] run `pnpm build` — must succeed
- [ ] run `pnpm validate` — manifest must still validate
- [ ] run `pnpm test` — all unit tests green

### Task 7: Documentation touch-up

- [ ] update `CLAUDE.md` "Services" paragraph: SonosService is now stateless w.r.t. current device; per-action device resolution is by UUID on each call
- [ ] README needs no user-facing changes (behavior matches what it already promises); add one sentence to the Troubleshooting section noting that changing the device in PI now takes effect immediately

## Technical Details

### New `SonosService` surface

```ts
class SonosService {
  private manager?: SonosManager;
  // no this.device, no isInitialized

  static getInstance(): SonosService;

  // Device-agnostic (unchanged):
  discoverDevices(): Promise<DiscoveredDevice[]>;

  // New core resolver:
  getDeviceByUuid(uuid?: string): Promise<SonosDevice | null>;

  // Per-call UUID (all methods):
  togglePlayPause(uuid?: string): Promise<boolean>;
  nextTrack(uuid?: string): Promise<boolean>;
  previousTrack(uuid?: string): Promise<boolean>;
  getPlayState(uuid?: string): Promise<string>;
  getVolume(uuid?: string): Promise<number>;
  setVolume(uuid: string | undefined, volume: number): Promise<boolean>;
  adjustVolume(uuid: string | undefined, adjustment: number): Promise<number>;
  toggleMute(uuid?: string): Promise<boolean>;
  getMute(uuid?: string): Promise<boolean>;
  getCurrentTrack(uuid?: string): Promise<CurrentTrack | null>;
  getShuffleMode(uuid?: string): Promise<boolean>;
  toggleShuffle(uuid?: string): Promise<boolean>;
}
```

### Resolver flow

1. `ensureManager()` lazily initializes `SonosManager` the first time any operation runs (seed: mDNS first device).
2. `getDeviceByUuid(uuid)`:
   - uuid empty -> `manager.Devices[0]` (fresh-install default behavior).
   - uuid in `manager.Devices` -> return it.
   - uuid missing but found in fresh mDNS -> `InitializeFromDevice(matchingIp)` and return from the rescanned `manager.Devices`.
   - otherwise -> `null` + logged error.
3. Every operational method short-circuits on `null` device with a safe default.

### Handler wiring in actions

- `onWillAppear` -> render initial state using `settings.deviceUuid`.
- `onDidReceiveSettings` -> re-render state with new `settings.deviceUuid` (and invalidate cover cache for play/pause).
- All user-triggered handlers call `sonosService.<op>(settings.deviceUuid, …)`.
- Polling timers (5s in play/pause and volume dial) fetch latest settings each tick via `ev.action.getSettings()`.

## Post-Completion

*Items requiring manual intervention or external systems - no checkboxes, informational only*

**Manual smoke test on Stream Deck hardware**:
- Fresh install, one Sonos -> configure via PI, all 5 actions work.
- Two Sonos devices, two buttons each pointing to a different device -> each button controls its own device; play state / volume indicators don't cross-talk.
- Change a button's device via PI (click Change -> Discover -> pick another) -> the button immediately begins controlling the new device (no plugin restart).
- Restart computer -> buttons still point to their configured devices (no auto-snap to a wrong device).
- Stream Deck+ Encoder: rotate / push / tap / long-touch on volume dial all route to the correct device after a PI change.

**External system updates**:
- Close issue #7 with PR reference + short note that the singleton device state was replaced with per-call UUID resolution.
- Reply to author (jamesbull) confirming their report was correct and their quick fix works for single-device setups; the refactor also covers multi-device.
- Consider cutting v1.2.1 patch release once merged (plugin is versioned independently in `manifest.json`).
