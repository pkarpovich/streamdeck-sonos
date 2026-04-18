# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
pnpm install       # Install dependencies
pnpm build         # Build plugin (rollup bundles to com.pavel-karpovich.sonos.sdPlugin/bin/plugin.js)
pnpm watch         # Dev mode with hot-reload (auto-restarts Stream Deck plugin)
pnpm validate      # Validate plugin manifest
pnpm pack          # Create .streamDeckPlugin distribution file
pnpm test          # Run unit tests once (vitest)
pnpm test:watch    # Run unit tests in watch mode
```

## Architecture

This is an Elgato Stream Deck plugin for controlling Sonos speakers. It uses:
- `@elgato/streamdeck` SDK with Node.js runtime
- `@svrooij/sonos` library for Sonos device communication
- Rollup for bundling TypeScript to a single plugin.js

### Key Structure

**Entry Point**: `src/plugin.ts` - registers all actions with the Stream Deck SDK and calls `streamDeck.connect()`

**Actions** (`src/actions/`): Each action extends `SingletonAction<Settings>` and uses the `@action` decorator with a UUID matching `manifest.json`. Actions handle Stream Deck events:
- `onWillAppear` - initialize Sonos connection and start polling
- `onKeyDown`/`onDialRotate`/`onTouchTap` - user interactions
- `onWillDisappear` - cleanup intervals

**Services** (`src/services/sonos-service.ts`): Singleton `SonosService` is stateless with respect to the current device - it holds only a lazily initialized `SonosManager`. Every operational method accepts a per-call `uuid` and resolves the target device via `getDeviceByUuid(uuid)` on each invocation. If the UUID is not in the manager, the resolver falls back to fresh mDNS discovery and `InitializeFromDevice(ip)`. An empty UUID defaults to `manager.Devices[0]`. This lets two actions target two different Sonos devices without cross-talk, and changing a device in the Property Inspector takes effect immediately.

**Tests** (`src/**/*.test.ts`): Unit tests colocated with sources, run via vitest. Config at `vitest.config.ts`.

**Plugin Bundle** (`com.pavel-karpovich.sonos.sdPlugin/`): Stream Deck plugin directory containing:
- `manifest.json` - action definitions, UUIDs, icons, supported controllers
- `imgs/` - button states and icons
- `bin/plugin.js` - built output (generated)

### Action UUIDs

UUIDs must match between `@action` decorator and `manifest.json`:
- `com.pavel-karpovich.sonos.playpause`
- `com.pavel-karpovich.sonos.volume`
- `com.pavel-karpovich.sonos.next-track`
- `com.pavel-karpovich.sonos.previous-track`
- `com.pavel-karpovich.sonos.shuffle`

### Error Handling Pattern

Use `tryCatch` utility for async operations - returns `{ data, error }` result type instead of throwing.
