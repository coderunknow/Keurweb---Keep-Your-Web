# Security Policy

## Design guarantees

- **No data collection.** Keurweb has no servers, no analytics, no telemetry. All settings stay in `chrome.storage.local` on your device.
- **No remote code.** The extension ships no eval, no remote scripts, no dynamic code loading (enforced by the default MV3 CSP).
- **No page data access.** The injected helper only dispatches benign synthetic DOM events and network-status signals. It never reads page content, forms, or cookies.
- **Minimal network surface.** The only outbound requests are warm-up pings (`HEAD`/`GET`, `no-cors`, credentials included) to sites **you explicitly enabled** — they carry no Keurweb payload.
- **Validated settings.** Imported settings are strictly normalized; corrupt or hostile files are rejected, never partially applied.

## Reporting a vulnerability

Please open a [GitHub security advisory](https://github.com/coderunknow/Keurweb---Keep-Your-Web/security/advisories/new) rather than a public issue. You'll get credit in the release notes unless you prefer otherwise.
