# Changelog

All notable changes to Keurweb are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

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
