# Changelog

All notable changes to Keurweb are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [1.2.0] — 2026-09-20

### Added

- **Quiet hours** — pause all protection on a daily schedule. Configure a start/end time (HH:MM local, overnight windows valid) in the General settings. While quiet, the engine emits no heartbeat, activity, sweep, or reload intents; disconnect stats are still recorded but no reload is scheduled; manual "Refresh now" from the popup still fires (explicit user action beats schedule). Badges are not repainted en masse during quiet hours. Pure `isQuietHours` helper in `policy.js` with tests for midnight wrap-around, disabled, and boundary minutes.
- **Per-site heartbeat method** — the existing `heartbeatMethod` behavior key (HEAD/GET) is now editable per site in the options detail panel, not just as a global default.
- **Standby badge state** — on recovery-budget surrender the worker now shows an amber "STBY" badge (instead of grey "OFF") to make clear the site is still enabled; recovery is just cooling down for 5 minutes. Cleared on recovery or cooldown expiry.

### Changed

- **Heartbeat interval bounds** — all UI sliders (popup, options General, options per-site) now match `LIMITS.heartbeatIntervalSec` (15–3600s) instead of the previous drift (popup capped at 600, options at 1800). A UI-consistency test reads the HTML/JS sources and asserts the bounds equal `LIMITS` so drift fails CI forever.
- **Activity quiet-gate constant** — replaced the unused `LIMITS.activityIntervalSec` entry with an honestly-named `ACTIVITY_QUIET_MS = 10_000` constant used by the engine. The underlying behavior (simulate only when the page has been quiet for 10s) is unchanged.

### Fixed

- **No version-sync test** — added a `node:test` asserting `package.json` version === `manifest.json` version === `APP_VERSION` === the newest `## [X.Y.Z]` heading in `CHANGELOG.md`. This test is the release companion.
- **README roadmap** — updated to reflect shipped features (wildcards shipped in v1.1.0 removed from roadmap; quiet hours, per-site method, and standby badge marked as shipped in v1.2.0).

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
- Chrome error pages (`chrome-error://`) never triggered auto-reconnect: the worker untracked the tab before the error-page handler ran, and even a queued reload refused non-http URLs. Failed loads now schedule a retry and persist the disconnect.
- Heartbeat-failure reconnects did not persist `lastDisconnectAt` (the tick wrote stats, then the async fetch failure mutated a different in-memory copy). All disconnect paths now share one persist helper.
- Importing or resetting settings re-bound every General-form listener, so later changes double-fired. Bindings are one-shot.
- Deep-linking from the popup to a site card (Advanced) never scrolled to it (`getElementById` was used with a CSS selector).

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
