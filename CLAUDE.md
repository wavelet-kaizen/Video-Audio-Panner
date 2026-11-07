# CLAUDE.md
必ず日本語で回答してください。
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This Chrome / Edge Manifest V3 extension pans video audio. On `https://holodex.net/multiview` (including nested paths and query strings), it automatically follows video additions, removals and layout changes, including in PWA windows. Other sites retain manual toolbar activation. No completion dialogs are shown.

## Architecture

The extension follows the standard Chrome Extension Manifest V3 structure:

- **manifest.json**: Extension configuration with permissions for scripting and activeTab
- **background.js**: Service worker that manages global state and handles extension button clicks
- **content.js**: Content script that processes video elements and applies audio panning

### Key Components

1. **Tab-scoped snapshots**: The background script serializes updates per tab, collects all frames before assigning pans, and targets document IDs to avoid stale messages after iframe navigation. No global video counter is shared between tabs.
2. **Screen coordinates**: Each frame reports its video rectangles, viewport and child iframe rectangles. The background composes parent coordinates/scaling without accessing cross-origin documents directly. Frame paths give stable fallback ordering.
3. **Audio reuse**: Each document has at most one AudioContext. WeakMap records preserve media sources/panners across updates and temporary removal. Never recreate a source for the same video or store audio objects in `dataset`. Do not reroute video audio while the context is suspended; retry on playback/interaction.
4. **Automatic layout**: One video is centered; two use -0.8/+0.8 in screen order. For three/four, left/right columns use -/+0.8 at the top and -/+0.65 below; center-positioned videos stay centered. This overrides count order in Holodex. Five or more retain [-1, 1, 0].
5. **Manual/fallback patterns**: One [0], two [-0.8, 0.8], three [-0.8, 0, 0.8], four [-0.8, -0.65, 0.8, 0.65], five+ [-1, 1, 0] repeated.

### Flow

1. The manifest injects content.js into the Holodex top frame. It requests automatic updates on multiview entry/pageshow; tabs.onUpdated covers SPA route changes. Toolbar clicks request manual updates.
2. The background injects the idempotent content script into all frames and collects snapshots. It computes pans and sends `applyPanning` assignments.
3. Only automatic mode enables media child-list, layout-ancestor attribute and resize observers, plus iframe-load/resize/transition events. Debounced `videosChanged` messages wake the background worker, even after idle shutdown. No interval polling.
4. Leaving multiview sends `setAutomatic` to disconnect observers and center existing panners. Removing videos disconnects their nodes; reinsertion reuses them.

## Development Commands

This is a pure JavaScript Chrome extension with no build system. Files are served directly:

- **Development**: No build step required - edit JS files directly
- **Regression tests**: `node --test tests/extension.test.cjs` (Node 22+, built-in runner, no dependencies)
- **Syntax**: `node --check background.js` and `node --check content.js`
- **Browser smoke**: `node tests/edge-smoke.cjs` (Windows Edge, optional `EDGE_PATH` for Canary). Dedicated ignored env/ profile; all fixture HTTPS requests intercepted locally. Plays generated WAV media with normal autoplay policy, checking running audio contexts and panning after playback and layout changes. Does not test live Holodex or listening in a PWA.
- **Manual testing**: Load unpacked in Chrome/Edge developer mode; reload both extension and page/PWA after edits. Check 0–5+ videos, iframe loading, removal/reinsertion, layout swaps, resizing, SPA entry/exit and actual stereo audio.
- **Packaging**: Double-click `pack-crx.cmd`, or run `powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\scripts\pack-extension.ps1`. The script reuses env/Video Audio Panner.pem, detects Edge Canary/stable (optional -KeyPath/-BrowserPath or EDGE_PATH), stages only the three runtime files, validates CRX3/ZIP contents against staged sources, and publishes `crx/Video Audio Panner-<version>.crx`. Existing output is replaced only after successful validation. Missing keys never cause new keys to be generated. Temporary work uses ignored env/pack-<GUID> directories; failed work is retained for troubleshooting. No Node dependency. Never pack the repository root: .gitignore does not exclude keys or browser profiles from browser packaging.

## File Structure

- `background.js`: Service worker; `content.js`: content script
- Existing `.min.js` copies are not loaded by the manifest/injection and have no configured generation command.
- `tests/extension.test.cjs`: VM fixtures for Chrome APIs, DOM observers and audio graph behavior
- `tests/edge-smoke.cjs`: actual Edge extension and cross-origin iframe smoke test
- `pack-crx.cmd`: interactive Windows packaging launcher; `scripts/pack-extension.ps1`: packaging and validation
- `manifest.json`: Extension manifest
- `crx/`: ignored local signing keys and packaged release files; never commit private keys
- `env/`: ignored local environments and test browser profiles
