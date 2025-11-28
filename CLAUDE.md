# CLAUDE.md
必ず日本語で回答してください。
This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Chrome extension that pans video audio to different stereo positions (left, right, center) in a rotating pattern across all videos on a page. The extension only activates when the toolbar button is clicked.

## Architecture

The extension follows the standard Chrome Extension Manifest V3 structure:

- **manifest.json**: Extension configuration with permissions for scripting and activeTab
- **background.js**: Service worker that manages global state and handles extension button clicks
- **content.js**: Content script that processes video elements and applies audio panning

### Key Components

1. **Global Counter System**: The background script maintains a global counter across all frames (including iframes) to ensure consistent panning order
2. **Total Video Count Management**: Tracks the total number of VIDEO elements across all frames to determine the panning pattern
3. **Audio Processing**: Uses Web Audio API's `createStereoPanner()` to apply stereo positioning
4. **Dynamic Pan Patterns**: Selects panning values based on total VIDEO element count:
   - 1 video: Center (0)
   - 2 videos: Left 80% (-0.8), Right 80% (0.8)
   - 3 videos: Left 80% (-0.8), Right 80% (0.8), Center (0)
   - 4 videos: Left 100% (-1), Right 100% (1), Left 65% (-0.65), Right 65% (0.65)
   - 5+ videos: Cycles through Left 100% (-1), Right 100% (1), Center (0)

### Flow

1. User clicks extension button → background.js resets counters and injects content.js into all frames
2. Each content.js queries background for offset and total VIDEO count
3. Panning pattern is selected based on total count across all frames
4. Each VIDEO element gets assigned position based on global offset
5. All existing audio contexts are closed and recreated to ensure fresh panning assignment

## Development Commands

This is a pure JavaScript Chrome extension with no build system. Files are served directly:

- **Development**: No build step required - edit JS files directly
- **Testing**: Load extension in Chrome developer mode
- **Packaging**: Use Chrome's "Pack extension" feature to generate .crx file

## File Structure

- `background.js` / `background.min.js`: Service worker (main/minified)
- `content.js` / `content.min.js`: Content script (main/minified) 
- `manifest.json`: Extension manifest
- `Video Audio Panner.pem`: Private key for extension signing
- `Video Audio Panner.crx`: Packaged extension file