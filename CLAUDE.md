# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build Commands

```bash
pnpm install       # Install dependencies
pnpm build         # Build plugin (rollup bundles to com.pavel-karpovich.sonos.sdPlugin/bin/plugin.js)
pnpm watch         # Dev mode with hot-reload (auto-restarts Stream Deck plugin)
pnpm validate      # Validate plugin manifest
pnpm pack          # Create .streamDeckPlugin distribution file
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

**Services** (`src/services/sonos-service.ts`): Singleton `SonosService` manages Sonos device discovery and all playback/volume operations. Auto-discovers devices or connects by IP. Preferentially selects "Arc" devices when multiple found.

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
