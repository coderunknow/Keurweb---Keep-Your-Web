# Contributing to Keurweb

Thanks for helping keep the web alive! 🫀

## Setup

```bash
git clone https://github.com/coderunknow/Keurweb---Keep-Your-Web.git
cd Keurweb---Keep-Your-Web
npm run verify   # no install step — zero dependencies
```

Load the extension in Brave/Chrome: `brave://extensions` → Developer mode → **Load unpacked** → select `src/`.

## Ground rules

- **Zero runtime dependencies.** Plain modern JavaScript on Manifest V3. If a feature genuinely needs a library, discuss it in an issue first.
- **Keep the core pure.** All decisions live in `src/shared/` (engine, policy, settings) with **no browser APIs** — they must stay unit-testable in Node. The worker only binds `chrome.*` to engine intents.
- **Minimal permissions.** Anything new must justify its permission in the PR description.
- **Privacy first.** No telemetry, no remote code, no network calls except warm-up pings to sites the user enabled.
- **No innerHTML with dynamic content.** Use `textContent`/DOM builders.

## Before opening a PR

```bash
npm run verify   # syntax checks + manifest validation + tests + packaging
```

All four must pass. New behavior needs tests in `tests/` — bug fixes need a test that reproduces the bug.

## Releasing

1. Bump `version` in `src/manifest.json` and `package.json` (semver).
2. Update `CHANGELOG.md`.
3. Run `npm run verify`, then tag `vX.Y.Z` — CI attaches the zip to the release.
