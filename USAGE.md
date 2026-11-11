# Using Interactive Proxy

This document covers how clients reach the proxy, what the UI shows, how the rules behave, and how the server is configured. Installation and the commands are in the [README](README.md); the management API is in [docs/API.md](docs/API.md).

## Sending traffic through the proxy

The proxy listens on `http://127.0.0.1:8050` by default. A request reaches it in one of these ways:

| Method | Example | Notes |
|---|---|---|
| HTTP proxy setting | `curl -x http://127.0.0.1:8050 https://example.com/` or the system proxy set to `127.0.0.1:8050` | Plain HTTP requests arrive with an absolute request line; HTTPS requests arrive as `CONNECT` tunnels that the proxy terminates with its own certificates |
| `X-Target-URL` header | `curl -H "X-Target-URL: https://api.example.com/users" http://127.0.0.1:8050/users` | The header names the real destination; `http://`, `https://`, `ws://` and `wss://` are accepted |
| Absolute request target | `curl --request-target http://example.com/ http://127.0.0.1:8050/` | What an HTTP proxy client sends on the request line; a path such as `/http://example.com/` is not accepted |
| WebSocket | `new WebSocket('ws://127.0.0.1:8050/socket', { headers: { 'x-target-url': 'wss://chat.example.com/socket' } })` | Upgrades through the proxy setting work the same way; the relay runs on `ws` on both sides |

Request bodies of any content type are forwarded byte for byte. Requests addressed to the proxy itself without a target answer `404` with a hint; they are not logged.

### What happens to a request

1. Blocked rules: a request whose URL matches an enabled blocked rule gets `204 No Content` and is logged with source `blocked`.
2. Filter rules: in `ignore` mode, matching requests are forwarded without inspection ("direct", counted as redirected); in `focus` mode, only matching requests are inspected and everything else is forwarded directly.
3. Local resources: a request whose URL contains the URL of an enabled local resource receives that resource.
4. Forwarding: the request goes to the resolved target. Edit rules rewrite headers and bodies on the way out and on the way back; the response is either streamed or buffered (see [Streaming](#streaming)).

## The UI

The header shows the dashboard counters (total, blocked, redirected, processed, edited, served), the Interactive mode switch, the theme switch, the audit panel button, the keyboard shortcuts button, an export button for the current log view and a button that clears the logs. Below it, six tabs.

The layout adapts to the window: from 1280 px wide the header is one row; below that the counters move to a second row under the title and the actions, and below 768 px the theme, audit and shortcuts buttons are hidden (the `?` key still opens the shortcuts panel) and the tab bar scrolls sideways. The dark theme is the default when the operating system prefers it; the Sun/Moon button in the header switches theme and the choice is kept in the browser's `localStorage` under `proxy.theme`. Without a stored choice the UI follows the system preference, also when it changes.

Keyboard shortcuts, listed in the panel the `?` key or the keyboard button opens:

| Key | Action |
|---|---|
| `/` | Switch to the Requests tab and focus the URL search |
| `e` | Export the current log view (the same as the export button) |
| `c` | Clear the logs, after confirmation |
| `1` – `6` | Switch tab: Requests, Blocked, Redirected/Processed, Edited, Local, Breakpoints |
| `?` | Show or hide the shortcuts panel |
| `Esc` | Close the shortcuts panel or the audit panel; in a text field, leave the field |

Shortcuts are ignored while a text field has the focus (except `Esc`), while a dialog is open, and when a modifier key is held. The tab bar also follows the keyboard: with a tab focused, the arrow keys, Home and End move between tabs.

### Requests

The list is chronological: the oldest entry of the in-memory window is first and new traffic is appended at the end. Each entry shows method, source (`proxied`, `mitm`, `websocket`, `local`, `blocked`, `error`, `direct`, `tunnel`), status, file type and URL; expanding it loads headers, bodies, Connect frames and WebSocket messages, with before/after views when a rule rewrote something. The buttons on an entry replay it, copy it as a curl command, mark it for export, create a local resource from its response, or add its URL to the blocked rules.

Replay opens a form with the method, the URL, the headers (one per line) and the body of the request, as the client sent them; Send puts the edited request through the proxy again, so the rules apply and the response is logged as a new entry marked REPLAY. The body is kept for this purpose up to `PROXY_REPLAY_BODY_LIMIT_BYTES` per request (256 KiB by default); a larger body, or the body of a request forwarded without inspection by a filter rule, is not available and the form says so. A binary body is sent as captured unless a text body is typed in its place. "Copy as cURL" puts on the clipboard a command for a POSIX shell (Git Bash, WSL, macOS, Linux) with the same method, URL, headers and body; when the clipboard is not available, the command is shown for a manual copy.

Search fields:

- URL search: terms separated by `;` must all match (AND); a term starting with `!` must not match (NOT); groups separated by `||` are alternatives (OR). It looks at the URL, the method, the target URL and the local resource name. Example: `!facebook; !scontent; api`.
- Request search and response search look inside the headers and bodies captured for each entry.
- Filters by source, method and file type; the WebSocket connection and summary entries are hidden unless the corresponding option is on.

Entries whose URL matches a blocked rule are hidden from this list whether the rule is enabled or not; remove the rule to see that traffic again.

### Blocked

The blocked URL rules: add, rename, enable, disable and remove. The global switch disables blocking without deleting the rules. Rule changes made through the API are active as soon as the response arrives.

### Redirected / Processed

The tab is named after the current filter mode. A rule is a pattern: one that looks like a host name (contains a dot and neither `/` nor `:`, or starts with `.`) is matched against the request host, including its subdomains; any other pattern is matched as a case-insensitive substring of the request URL. Rules belong to the mode they were created in, and the mode decides what a match means:

- `ignore`: matching traffic is forwarded directly, without logging or rewriting, and counted as redirected.
- `focus`: only matching traffic is processed; everything else is forwarded directly.

The tab also lists suggestions computed from the current log window: the hosts with the most requests that no rule covers yet, with their most frequent paths.

### Edited

Edit rules rewrite traffic in flight. Two kinds exist:

- Text rules replace a portion of textual content. A rule carries one or more start markers and one or more end markers (one per line in the form; every non-empty line is an alternative), a replacement, and flags for regular expressions and case sensitivity. A rule may be scoped to a URL pattern and to a phase (`request`, `response`, `both`).
- JSONPath rules set a value at a path of a JSON body (`root.items[0].name`), or of a Protobuf message decoded to its JSON view (`root.f2`). They always carry a URL pattern and a phase; the value has a type (`string`, `number`, `boolean`, `null`, `json`) or comes from an uploaded file.

URL patterns use the same semantics for every rule kind: a full URL matches by host plus path (exact or prefix), a pure path matches by path prefix, any other string matches as a case-insensitive substring of the URL. A pattern with a host never matches another host.

Rules apply in file order and each rule sees the output of the previous one. A rule whose regular expression does not compile is skipped with a warning. Text rules apply to HTTP bodies with a textual content type, to headers, to each frame of a Connect envelope (including printable strings inside Protobuf messages) and to WebSocket text frames. JSONPath rules apply to `application/json` bodies, to decoded Protobuf messages (re-encoded afterwards) and to the JSON part of WebSocket frames, Socket.IO prefixes preserved. A field that contains JSON as a string stays a string.

The tab also manages presets (saved rule templates), shows how many logged entries each rule touched, and receives rules created from the Requests tab: clicking a key in a Connect frame opens the form pre-filled with the URL pattern, the JSON path and the current value.

### Local

Local resources are files or inline text served instead of the upstream response when a request URL contains the resource URL. Each resource has a content type and can be enabled or disabled; the global switch disables all of them.

### Breakpoints

A breakpoint rule names a substring of the URL and the phase it pauses: the request, before it is forwarded, the response, before it goes back to the client, or both. When a request matches, the proxy holds it and an editor opens in the UI (a strip above the tabs lists the paused flows when the editor is closed): the method, the URL, the headers and the body of the request, or the status, the headers and the body of the response, as they would go on after the edit rules. Send passes the flow on with the edits, Abort answers the client with an error, and closing the editor leaves the flow paused. A flow nobody resumes continues unchanged after `PROXY_BREAKPOINT_TIMEOUT_MS` (two minutes by default). Flows are held only while the UI is open, because only the UI can resume them; requests forwarded without inspection by a filter rule are never held. The tab manages the rules and shows the paused flows; its switch turns every rule off at once. Entries that went through a breakpoint carry a BREAKPOINT badge.

### Audit panel

The chart button in the header (or a triple click on the title in the top-left corner) opens the audit panel: upstream latency percentiles, upstream errors by category, the slowest routes grouped by handling (processed, redirected, blocked, served) and the hosts with the highest average latency. The data comes from `GET /api/audit` and `GET /api/dashboard`. `Esc` or the close button closes it.

### Interactive mode

With the switch on, the proxy records every request it processes into the in-memory log window (`PROXY_MAX_LOG_ENTRIES` entries, oldest evicted first) and decodes bodies for the UI. With the switch off, nothing is logged and responses that no rule can rewrite are streamed untouched; blocked rules, filter rules, local resources and edit rules keep working. The state is persisted in `server/storage/config.json`.

## Streaming

A response is piped to the client as it arrives, instead of being buffered and decoded, when no edit rule can apply to it and nothing needs the body for logging: Interactive mode is off, or the content type is binary (images, fonts, audio, video, `application/octet-stream`), or the response is a `text/event-stream`, or its declared `content-length` exceeds `PROXY_STREAM_THRESHOLD_BYTES`. Streamed entries are logged with the body replaced by `[streamed response]` and their size filled in at the end of the transfer. `PROXY_STREAM_UNINSPECTED_RESPONSES=false` restores full buffering.

## Configuration

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `PROXY_PORT` | `backendPort` of `ports.config.json`, else `8050` | Listening port |
| `PROXY_HOST` | `127.0.0.1` | Listening interface; `0.0.0.0` exposes the proxy on the network |
| `PROXY_UI_ORIGINS` | empty | Comma-separated browser origins allowed to call the management API, in addition to the UI and proxy origins on `localhost` and `127.0.0.1` |
| `PROXY_STORAGE_DIR` | `server/storage` | Rules, resources, flags and uploaded files |
| `PROXY_LOGS_DIR` | `server/logs` | Reserved directory, created at startup |
| `PROXY_CERTS_DIR` | `server/certs` | CA, leaf key and host certificates |
| `PROXY_MAX_LOG_ENTRIES` | `5000` | Size of the in-memory log window |
| `PROXY_LOG_PREVIEW_MAX_BYTES` | `0` (no limit) | Maximum size of the text previews kept per entry |
| `PROXY_LOG_DECOMPRESS_MAX_BYTES` | `0` (no limit) | Compressed bodies larger than this are not decompressed for previews |
| `PROXY_PROTOBUF_MAX_FIELDS` | `0` (no limit) | Maximum fields decoded per Protobuf message |
| `PROXY_PROTOBUF_MAX_BYTES` | `0` (no limit) | Maximum Protobuf message size decoded |
| `PROXY_CONNECT_MAX_FRAMES` | `0` (no limit) | Maximum Connect frames decoded per body |
| `PROXY_CONNECT_MAX_FRAME_BYTES` | `0` (no limit) | Maximum Connect frame size decoded |
| `PROXY_WS_MAX_TEXT_BYTES` | `0` (no limit) | Maximum WebSocket text message size logged |
| `PROXY_WS_LOG_BODY_ENABLED` | `true` | `false` logs WebSocket connections and metadata only, without message bodies or rewrites |
| `PROXY_UPSTREAM_HEADERS_TIMEOUT_MS` | `0` (undici default) | Time allowed for the upstream response headers |
| `PROXY_UPSTREAM_BODY_TIMEOUT_MS` | `0` (undici default) | Time allowed between upstream body chunks |
| `PROXY_UPSTREAM_H2` | `false` | Negotiate HTTP/2 with TLS upstreams that offer it (ALPN). Off by default because HTTP/2 changes what the upstream receives: `Host` becomes `:authority`, header names are lower-cased and connection-specific headers disappear, so the upstream no longer sees the request as the client sent it. The client side of the proxy is always HTTP/1.1 |
| `PROXY_STREAM_UNINSPECTED_RESPONSES` | `true` | Enable [streaming](#streaming); `false` buffers every response |
| `PROXY_STREAM_THRESHOLD_BYTES` | `1048576` | With Interactive mode on, responses declaring a larger `content-length` are streamed; `0` never streams by size alone |
| `PROXY_REPLAY_BODY_LIMIT_BYTES` | `262144` | Request bodies up to this size are kept on their log entry for replay and "Copy as cURL" |
| `PROXY_BREAKPOINT_TIMEOUT_MS` | `120000` | A flow held at a breakpoint continues unchanged after this time |
| `PROXY_MITM_BYPASS_REWRITES_ENABLED` | `true` | Apply edit rules to HTTPS traffic that filter rules mark as direct; `false` forwards it untouched |
| `PROXY_STRICT_TLS` | `false` | Verify upstream TLS certificates |
| `PROXY_STRICT_TLS_CA_FILE` | empty | Additional PEM bundle trusted when `PROXY_STRICT_TLS` is on |
| `PROXY_BODY_LIMIT` | `10mb` | Maximum request body accepted |
| `PROXY_LOG_LEVEL` | `info` | Logger level: `trace`, `debug`, `info`, `warn`, `error`, `fatal`, `silent` |
| `PROXY_DEBUG_LOG` | `false` | `true` is the same as `PROXY_LOG_LEVEL=debug` |
| `PROXY_LOG_FORMAT` | `pretty` on a terminal, `json` when piped | `json` writes one JSON object per line (for `pino-pretty` or a collector); `pretty` writes `[proxy][scope] message` lines through the console |

Booleans accept `1`, `true` and `yes`.

### Ports

`ports.config.json` is the single place where the two ports are defined:

```json
{
  "uiPort": 3050,
  "backendPort": 8050,
  "backendHost": "localhost",
  "backendProtocol": "http"
}
```

The server reads `backendPort` (overridden by `PROXY_PORT`). `client/vite.config.js` reads the same file: it runs the development server on `uiPort` (`http://localhost:3050` by default, failing instead of moving to another port when it is taken) and injects the backend host, port and protocol into the app as a compile-time constant. When the UI is served by the proxy itself, API calls stay on the proxy's origin.

### Persistent files

Everything the proxy persists lives under the storage and certificate directories; the formats are described in [ARCHITECTURE.md](ARCHITECTURE.md#persistence).

| File | Content |
|---|---|
| `storage/config.json` | Interactive mode, the four feature switches, the filter mode |
| `storage/edit-rules.json`, `storage/edit-rule-presets.json` | Edit rules and presets |
| `storage/blocked-urls.json`, `storage/filter-urls.json` | Blocked and filter rules |
| `storage/resources.json` plus the uploaded files | Local resources |
| `certs/ca-key.pem`, `certs/ca-cert.pem`, `certs/leaf-key.pem`, `certs/hosts/` | Certificate authority, shared leaf key, one certificate per host |

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `listen EADDRINUSE` at startup | Another process holds the port. `netstat -ano \| findstr :8050` (Windows) shows its PID; stop it or set `PROXY_PORT` |
| The UI shows no traffic | Interactive mode is off, or the traffic matches a filter rule in `ignore` mode (counted as redirected), or its URL matches a blocked rule pattern (hidden from the list) |
| HTTPS sites fail in the browser with a certificate error | The CA is not trusted by that browser; see [INSTALL-CERTIFICATE.md](INSTALL-CERTIFICATE.md). Firefox keeps its own store |
| `curl: (60) schannel: the revocation status is unknown` | curl on Windows uses Schannel, which requires revocation information the proxy's certificates do not carry; add `--ssl-no-revoke` |
| A local resource is not served | The resource is disabled, the global switch is off, or its URL is not contained in the request URL |
| A rule does not apply | Its URL pattern names a host that differs from the request's, its phase does not match, the global edit switch is off, or the response was streamed (binary, event stream or above the size threshold) before any rule could apply; a regular expression that does not compile is reported in the server log |
| `npm run dev` fails to start `vite` | Run `npm install` at the repository root; the client's dependencies are hoisted into the root `node_modules` |
| The UI development server reports port 3050 in use | `strictPort` is on so the app always runs on `uiPort`; stop the other process or change `uiPort` in `ports.config.json` |
