# Keurweb — Keep Your Web

**A Brave / Chrome extension that keeps your websites working for a long time — no idle disconnects, no session timeouts, no frozen or discarded tabs.**

Keurweb is 100% local: no accounts, no analytics, no data collection. Everything stays in your browser.

---

## Why

Long-running web apps — dashboards, ERP/CRM systems, webmail, trading or monitoring tools — tend to fall apart when left open:

| Problem | What you see | Keurweb's fix |
| --- | --- | --- |
| Server-side session expiry | "Session expired, please log in again" | **Session heartbeat** — a lightweight background request keeps the session warm on an interval you control |
| App idle timers | "Are you still there?" / auto-logout | **Anti-idle activity** — benign simulated user events tell the page someone is "active" |
| Brave Memory Saver | Tab freezes/discards, app state breaks | **Anti-discard sweep** — periodic recency refresh discourages freezing of protected tabs |
| Dropped connections | Dead tab, error page, spinning logo | **Auto-reconnect** — the tab is reloaded automatically with exponential backoff, capped attempts and a recovery budget |

## Install (from source, 1 minute)

1. Download this repository (or `git clone https://github.com/coderunknow/Keurweb---Keep-Your-Web.git`).
2. Open **brave://extensions** (or `chrome://extensions` in Chrome).
3. Enable **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the repository's `src/` folder.
5. Pin **Keurweb** to the toolbar.

Or use the packaged build: `npm run package` → load `dist/keurweb-v1.1.0.zip` unpacked after extracting.

> **Note on the popup:** Keurweb only touches http(s) pages you explicitly enable. Open any site, click the Keurweb icon, and press **“Keep this site alive.”**

## Use

### Popup (per-site quick control)

- **Master switch** (top-right) — turn Keurweb on/off everywhere at once.
- **Keep this site alive** — enable/disable protection for the current site.
- When a site is protected you get: live status (*Protected / Reconnecting… / Not protected*), a countdown to the next heartbeat, an interval slider, auto-reconnect toggles, and a **⟳ Refresh now** button that pings immediately.
- **Stats line** — heartbeats sent, reconnects performed, and when the last ping went out.
- **Site settings →** jumps to the full dashboard, pre-selected on that site (including wildcard rules).

### Options dashboard (toolbar icon → Settings)

- **General** — global defaults: heartbeat (interval 15s–1h, HEAD/GET), activity simulation (events/focus/both), anti-discard sweep, auto-reconnect (attempts, backoff, budget, notifications), plus **Export / Import / Reset**.
- **Sites** — your allowlist. Add `example.com` (exact) or `*.example.com` (whole family: apex + every subdomain), toggle per site, and **Customize** any site to override every default — including live stats (heartbeats, reconnects, last disconnect/recovery). An exact rule always beats a wildcard, so you can pause a single site under an enabled wildcard without touching the rest. Remove anytime.
- **Activity log** — a live, local diagnostics feed (keeps 500 entries), with **Export (JSON)**.
- **About** — version, features, shortcut help, available languages.

### Languages

The UI is available in **English** and **Tiếng Việt** and follows your browser language automatically (`chrome.i18n`).

### Keyboard shortcut

`Alt+Shift+K` toggles keep-alive for the active tab's site. Change it at `brave://settings/commands`.

### How it works (under the hood)

```
┌────────────┐  1-min alarm tick  ┌─────────────────────┐
│ MV3 worker │──────────────────▶│ KeepAliveEngine      │   pure, unit-tested logic
│ (binds     │◀── intents ───────|  - heartbeat due?    |
│ chrome.*)  │                    |  - page quiet?       |
└─────┬──────┘                    |  - sweep due?        |
      │                           |  - reload due?       |
      ▼                           └─────────────────────┘
 fetch() warm-up ping (credentials included, no-cors)
 chrome.scripting → content script (activity simulation, offline detection)
 chrome.tabs.reload with exponential backoff
```

- **Heartbeats** use `fetch(url, {method:'HEAD' or 'GET', credentials:'include', mode:'no-cors'})` from the worker (method configurable per site) — cookies flow, your session stays warm, and no page data is read.
- **Activity simulation** dispatches untrusted, benign DOM events (`mousemove`, `keydown`, `focus`, …) inside the page. It never reads or modifies page content.
- **Recovery** reloads a dead tab after 5s, 10s, 20s… (doubling, capped at 5 min), up to N attempts within a rolling budget — then gives up cleanly and tells you in the log.

## Configuration model

Keurweb is **off by default**. Nothing happens until you enable a site (popup, dashboard, or shortcut). Effective behavior per site = global defaults **merged with** per-site overrides.

Settings can be exported to / imported from a JSON file (fully offline, validated on import — a corrupt file is rejected, never half-applied).

## Privacy

- No network requests are made except HEAD/GET warm-up pings **to sites you enabled**.
- No remote code, no analytics, no telemetry, no accounts.
- Storage is `chrome.storage.local` (settings) + `chrome.storage.session` (tracked-tab cache).

## Development

Zero runtime dependencies. Node ≥ 18 for the tooling.

```bash
npm run check      # syntax + MV3 hygiene checks on all shipping JS
npm run validate   # manifest.json validation
npm test           # unit tests for the core engine (node:test)
npm run package    # build dist/keurweb-v<version>.zip
npm run verify     # all of the above — the pre-release gate
```

```
src/
├── manifest.json            MV3 manifest
├── background/
│   └── serviceWorker.js     orchestrator: alarms, tabs, messages, recovery
├── content/
│   └── contentScript.js     injected only into enabled sites (self-contained)
├── popup/                   quick per-site control
├── options/                 full dashboard
├── shared/                  pure logic: engine, policy, settings, constants
└── assets/                  icons + design system (base.css)
```

The core (`shared/keepAliveEngine.js`, `shared/policy.js`, `shared/settings.js`) is intentionally free of browser APIs and covered by tests in `tests/`.

## Roadmap ideas

- Wildcard / subdomain matching for site rules
- WebSocket liveness probes
- Optional "pause when on battery" mode

## License

[MIT](LICENSE) © coderunknow
