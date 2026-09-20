# Changelog

All notable changes to Keurweb are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-09-20

### Added

- **Wildcard (subdomain) site rules** — add `*.example.com` to protect the apex domain and every subdomain at once. Exact rules always win over wildcards, and several wildcards nest (the most specific wins). Toggling a site from the popup under an enabled wildcard creates a per-host override, so one site can be paused without touching the rest of the family. Existing exact entries migrate with zero changes.
- **Vietnamese UI** — full `chrome.i18n` support with English + Tiếng Việt; the UI follows your browser language. All user-facing strings (popup, options, tooltips, notifications, activity log, badge titles, manifest text) are localized.
- **Per-site stats** — heartbeats sent, reconnects performed, and last heartbeat / disconnect / recovery time, shown in the popup and in each site's detail panel (with a reset button). Stats persist, export, and import with your settings.
- **Activity log export** — download the diagnostics feed as a versioned JSON file.
- **Popup wildcard note** — protected-via-wildcard sites show “via *.example.com (includes subdomains)”.

### Changed

- Activity log entries are now structured (`i18n key + substitutions`) so they render in the UI language; legacy v1.0 entries keep displaying as-is.
- CI now gates on locale consistency (`scripts/check-i18n.mjs`): key parity between locales, placeholder parity, and every referenced key must exist.

### Fixed

- “Notify when reconnecting” never showed a notification — the worker called a `notify` function that was never defined. Implemented with `chrome.notifications` (no new permission).
- Per-site customization in the options dashboard was broken (the detail panel builder was missing, so “Customize” threw). Fixed and covered by tests.
- The heartbeat **Request method** setting (HEAD/GET) was ignored — the worker always sent HEAD. Ping intents now carry the configured method.
- The General form did not re-sync after import/reset (`syncBehaviorControls` was never called).

## [1.0.0] — 2026-09-20

First stable release. 🎉

### Added

- **Session heartbeat** — configurable warm-up pings (15s–1h, HEAD/GET) that keep server sessions alive without touching page data.
- **Anti-idle activity simulation** — benign synthetic user events (pointer/key or focus-only) defeat "are you still there?" idle timers.
- **Anti-discard sweep** — periodic recency refresh discourages Brave Memory Saver from freezing protected tabs.
- **Auto-reconnect** — dead tabs (error pages, network drops) reload automatically with exponential backoff, per-tab attempt caps, a rolling recovery budget and optional desktop notification.
- **Per-site configuration** — allowlist model (off by default everywhere), per-site overrides for every knob, managed from the popup or the options dashboard.
- **Global defaults + master switch** — configure once, override anywhere, pause everything instantly.
- **Friendly popup UI** — live protection status, heartbeat countdown, quick toggles, instant "Refresh now".
- **Options dashboard** — General / Sites / Activity log / About views with light & dark themes.
- **Activity log** — local diagnostics feed (last 500 events).
- **Settings export/import** with strict validation on import.
- **Keyboard shortcut** `Alt+Shift+K` to toggle the active site.
- **Zero dependencies** — plain modern JavaScript on Manifest V3; loads directly in Brave/Chrome.
- **Developer tooling** — `npm run verify` (syntax checks, manifest validation, unit tests, packaging).
