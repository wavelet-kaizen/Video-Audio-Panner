# Repository Guidelines

## Project Structure & Module Organization

Video Audio Panner is a Chrome Manifest V3 extension that assigns stereo positions to videos when its toolbar button is clicked. Source files live at the repository root:

- `manifest.json`: extension metadata, permissions, and service-worker entry point.
- `background.js`: toolbar handling, cross-frame counters, and content-script injection.
- `content.js`: video discovery, panning patterns, and Web Audio connections.
- `background.min.js` / `content.min.js`: tracked minified copies; runtime currently loads the readable files.
- `README.md`: Japanese installation and usage documentation; `CLAUDE.md`: additional agent guidance.

There are no dedicated test or asset directories. `crx/` and `env/` are ignored local directories.

## Build, Test, and Development Commands

No dependency installation or build step is required, and no package scripts are configured.

1. Open `chrome://extensions/`, enable **Developer mode**, and choose **Load unpacked** with this repository root.
2. After editing, click the extension's **Reload** button and refresh the target page.
3. Open a page containing videos, start playback, and click the extension's toolbar button.

Use Chrome's **Pack extension** action when preparing a packaged release.

## Coding Style & Naming Conventions

Use two-space indentation, semicolons, and `const` or `let`. Prefer double-quoted strings while preserving surrounding style. Use camelCase identifiers such as `globalCounter` and `panValues`. Keep message names and payloads consistent between scripts, including `getOffset`, `getTotalCount`, `count`, and `totalCount`.

Edit readable JavaScript first. No formatter, linter, or minification command is configured. Preserve UTF-8 Japanese text in documentation and user-facing messages.

## Testing Guidelines

Testing is manual; no automated framework, coverage threshold, or test naming convention exists. Check pages with zero, one, two, three, four, and five or more videos, including videos inside iframes. Compare stereo positions with the patterns documented in `README.md`. Exercise repeated toolbar clicks and page reloads, and inspect the page console and extension service-worker console for errors.

## Commit & Pull Request Guidelines

History contains only `新規作成` (initial creation), so no established commit format exists. Use concise, imperative subjects describing one focused change.

For pull requests, explain the behavior change, link relevant issues, and record the Chrome version and manual checks performed. Include screenshots for visible UI changes. Keep signing keys and packaged artifacts out of commits; use the ignored `crx/` directory for local release files.
