# Management API

The proxy exposes its state under `/api` on its own origin (`http://127.0.0.1:8050` by default). Every response is JSON unless stated otherwise. The routes are implemented in `server/src/api/`; the integration tests under `server/test/integration/` exercise each of them.

## Access rules

- Requests addressed to another host (an absolute request line, an `X-Target-URL` header or a `Host` header that is not the proxy's own) never reach the API, even when their path starts with `/api`: they are proxied.
- CORS: the `Access-Control-Allow-Origin` header is set only for the UI origins (`http://localhost` and `http://127.0.0.1` on the UI port and on the proxy port, the `PROXY_HOST` address, and the origins listed in `PROXY_UI_ORIGINS`).
- Cross-site guard: a request with a method other than `GET`, `HEAD` or `OPTIONS` is refused with `403 {"error":"Cross-site requests to the proxy API are not allowed"}` when its `Origin` header is present and not allowed, or when `Sec-Fetch-Site` is `cross-site`. Clients that send neither header (curl, scripts) are not affected.
- Boolean query parameters accept `true`/`1`; list parameters are comma-separated.

## Endpoints

| Method and path | Purpose |
|---|---|
| `GET /api/config` | Flags and filter mode |
| `POST /api/interactive-mode`, `/api/edit-rules-mode`, `/api/local-resources-mode`, `/api/filter-rules-mode`, `/api/blocked-rules-mode` | Set one flag |
| `GET /api/filter-mode`, `POST /api/filter-mode` | Read or set `ignore` / `focus` |
| `GET /api/logs` | Page of log entries |
| `GET /api/logs/export` | Raw entries of the current filter, or a HAR archive with `format=har` |
| `POST /api/logs/import` | Add the entries of a HAR archive to the window |
| `GET /api/rules/export`, `POST /api/rules/import` | Every rule kind in one file |
| `GET /api/throttle`, `POST /api/throttle` | Network-condition rules (latency, bandwidth cap) |
| `GET /api/passthrough`, `POST /api/passthrough` | TLS passthrough hosts |
| `GET /api/logs/:id` | One entry with bodies |
| `GET /api/logs/:id/replay`, `POST /api/logs/:id/replay` | The replay form of an entry, and the replay itself |
| `GET /api/logs/:id/curl` | The entry as a curl command |
| `GET /api/breakpoints`, `POST /api/breakpoints` | Breakpoint rules |
| `GET /api/breakpoints/pending`, `POST /api/breakpoints/pending/:id/resume`, `POST /api/breakpoints/pending/:id/abort` | Flows held at a breakpoint |
| `DELETE /api/logs` | Clear the log window and the derived counters |
| `GET /api/dashboard` | Counters, performance aggregates, routes |
| `GET /api/audit` | Upstream errors by category and per-host latency |
| `GET /api/events` | Server-Sent Events stream |
| `GET /api/resources`, `POST /api/resources`, `POST /api/resources/toggle`, `DELETE /api/resources/:encodedUrl` | Local resources |
| `GET /api/edit-rules`, `POST /api/edit-rules`, `PUT /api/edit-rules/:id`, `DELETE /api/edit-rules/:id`, `GET /api/edit-rules/usage`, `POST /api/edit-rules/value-file` | Edit rules |
| `GET /api/edit-rule-presets`, `POST /api/edit-rule-presets`, `DELETE /api/edit-rule-presets/:id` | Rule presets |
| `GET /api/blocked`, `POST /api/blocked` | Blocked rules |
| `GET /api/filters`, `POST /api/filters`, `GET /api/filters/suggestions`, `GET /api/filters/metrics` | Filter rules |
| `POST /api/system/file-picker` | Native file dialog (Windows) |

## Configuration

### `GET /api/config`

```json
{
  "interactiveModeEnabled": true,
  "editRulesEnabled": true,
  "localResourcesEnabled": true,
  "filterRulesEnabled": true,
  "blockedRulesEnabled": true,
  "breakpointsEnabled": true,
  "throttlingEnabled": true,
  "filterMode": "ignore",
  "filteredRequestCount": 0
}
```

`filteredRequestCount` is the number of requests forwarded directly by the filter rules since the last clear.

### `POST /api/<flag>-mode`

Body `{"enabled": true}`; `enabled` must be a boolean, otherwise `400 {"error": "Missing \"enabled\" flag: expected a boolean."}` (or `Invalid "enabled" flag`). Response `{"success": true, "<field>": true}` where `<field>` is the flag name of `GET /api/config`. The value is persisted.

### `GET /api/filter-mode`, `POST /api/filter-mode`

`GET` answers `{"filterMode": "ignore"}`. `POST` takes `{"mode": "ignore" | "focus"}` (`400` otherwise), rebuilds the active filter list and answers `{"success": true, "filterMode": "focus"}`.

## Logs

### `GET /api/logs`

| Query parameter | Default | Meaning |
|---|---|---|
| `offset` | `0` | Index of the first entry (oldest first) |
| `limit` | `50` | Page size, clamped between 1 and the window size |
| `view` | full | `summary` omits bodies and decoded payloads |
| `search` | empty | URL search: `;` separates terms that must all match, a leading `!` negates a term, `\|\|` separates alternative groups |
| `requestSearch`, `responseSearch` | empty | Substring searched in the request (or response) headers and body snapshots |
| `sources` | `proxied,mitm,websocket,imported` | Sources to include; `local`, `blocked` and `error` entries are always included |
| `methods` | `GET,POST,PUT,DELETE,PATCH` | Methods to include; WebSocket entries (`WS`) ignore this filter |
| `fileTypes` | `json,html,css,js,image,video,audio,font,other` | File types to include |
| `showWsConnections` | `false` | Include WebSocket connection and summary entries |
| `requestRewrittenOnly`, `responseRewrittenOnly` | `false` | Only entries with a rewrite in that phase |

Entries whose URL matches a blocked rule pattern are never returned.

```json
{ "items": [ ... ], "total": 12, "hasMore": false, "offset": 0, "limit": 50 }
```

An item carries `id`, `timestamp`, `method`, `url`, `fullUrl`, `source`, `statusCode`, `responseSize`, `fileType`, `targetUrl`, `localResource`, `error`, `direction`, the timings (`upstreamDurationMs`, `totalDurationMs`, `proxyOverheadMs`, `requestStartTs`), the sizes (`requestBytes`, `responseBytes`), `headers`, `responseHeaders`, `requestBodySummary`, `responseBodySummary`, `rewrites` (the rules that applied, with `id`, `name`, `kind`, `target`, `phase`), `replayOf` (the id of the entry a replay repeated), `connectSummary`, `wsSummary` and the WebSocket fields (`connectionId`, `direction`, `isConnectionLog`, `isWebSocketSummary`). The full view adds `body`, `responseBody`, the JSON views before and after rewriting (`requestBodyJson`, `requestBodyJsonBefore`, `responseBodyJson`, `responseBodyJsonBefore`, `wsBodyJsonBefore`, `wsBodyJsonAfter`), the text views (`requestBodyTextBefore` / `After`, `responseBodyTextBefore` / `After`), `originalBody`, the raw previews and the decoded Connect frames (`connectRequest`, `connectResponse`).

### `GET /api/logs/export`

Same filters as `GET /api/logs`, no pagination; `ids=a,b,c` restricts the export to those entries. Answers `{"items": [...], "total": n}` with the raw entries. With `format=har` the answer is an HTTP Archive 1.2 (`{"log": {"version": "1.2", "creator": {...}, "entries": [...]}}`) of the HTTP entries: WebSocket connections, messages and summaries have no HAR form and are left out. Each entry carries the request (method, URL, headers, cookies, query string, `postData` when the body is held, as text or as base64 with `"comment": "base64"`), the response (status, headers, `content` with the text when the log holds it, `redirectURL`), the timings (`wait` is the upstream time) and a `comment` with the source, `replayOf`, `breakpoint` and `error` when present.

### `POST /api/logs/import`

Body: a HAR document. Its entries with a method and an absolute `http(s)` URL enter the log window with `source: "imported"`, oldest first, with the request body kept for replay (up to `PROXY_REPLAY_BODY_LIMIT_BYTES`) and the JSON bodies parsed for the views; the window's capacity caps the number. Answers `{"success": true, "imported": n, "skipped": n}`; `400 {"error": "Not a HAR document: ..."}` when `log.entries` is missing. The body size limit of the proxy (`PROXY_BODY_LIMIT`, 10 MB by default) applies.

### `GET /api/logs/:id`

The full view of one entry; `404 {"error": "Log not found"}` when the id is not in the window.

### `GET /api/logs/:id/replay`

The request an entry would send again:

```json
{
  "method": "POST", "url": "https://api.example.com/items",
  "headers": { "content-type": "application/json", "x-custom": "a" },
  "body": "{\"name\":\"one\"}", "bodyBase64": null, "bodyIsText": true, "bodySize": 14,
  "bodyCaptured": true, "bodyExpected": true, "bodyNotKeptBytes": 0
}
```

`headers` are the request headers of the entry without the ones a client must not repeat (`host`, `content-length`, `transfer-encoding`, `expect`, the hop-by-hop ones, `proxy-authorization`, `x-target-url`). The body is the one the client sent, before any rule: `body` as text when it is text, `bodyBase64` otherwise. Bodies are kept up to `PROXY_REPLAY_BODY_LIMIT_BYTES` (256 KiB by default); a larger body has `bodyCaptured: false` and its size in `bodyNotKeptBytes`, and so has a request forwarded without inspection by a filter rule (`bodyNotKeptBytes: 0`). `404` when the id is not in the window, `400 {"error": "This entry cannot be replayed"}` for WebSocket connections, messages and summaries.

### `POST /api/logs/:id/replay`

Sends the entry again through the proxy, with the edits of the JSON body: `method` (one of GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS), `url` (`http` or `https`), `headers` (replaces the whole set; the headers listed above are dropped again), `body` (a text body; `null` sends none) or `bodyBase64` (a binary body). Fields that are absent keep the values of the entry. The request takes the same path as the original one: blocked and filter rules, local resources, rewrites and logging, so with Interactive mode on the response is a new entry whose `replayOf` is the id of the replayed one. Answers:

```json
{ "success": true, "statusCode": 200, "responseBytes": 1297, "durationMs": 312, "logId": "1762860123456.7" }
```

`logId` is `null` when logging is off. `400` for an invalid edit, `502 {"error": "Replay failed: …"}` when the request could not be completed.

### `GET /api/logs/:id/curl`

The entry as a curl command, one option per line: `-X` for methods other than GET (`-I` for HEAD), one `-H` per header, the body as `--data-raw` when it is text and, when it is binary, piped from base64 into `--data-binary @-`. Quoting is for a POSIX shell (Git Bash, WSL, macOS, Linux). `viaProxy=1` adds `-x` with the proxy's address.

```json
{ "command": "curl -X POST 'https://api.example.com/items' \\\n  -H 'content-type: application/json' \\\n  --data-raw '{\"name\":\"one\"}'", "bodyIncluded": true, "bodyEncoding": "text" }
```

### `DELETE /api/logs`

Empties the window, resets the dashboard counters, the filter metrics, the suggestions and the rule usage counters. Answers `{"success": true, "message": "Logs cleared"}`.

## Dashboard and audit

### `GET /api/dashboard`

```json
{
  "stats": { "total": 0, "served": 0, "proxied": 0, "blocked": 0, "processed": 0, "errors": 0 },
  "performance": {
    "upstreamMs": { "avg": 0, "max": 0 },
    "totalMs": { "avg": 0, "max": 0 },
    "proxyOverheadMs": { "avg": 0, "max": 0 }
  },
  "payloads": {
    "requestBytes": { "avg": 0, "max": 0 },
    "responseBytes": { "avg": 0, "max": 0 }
  },
  "routes": {
    "slowest": [ { "host": "", "path": "/", "avgMs": 0, "maxMs": 0, "count": 0, "avgBytes": 0, "kbPerSecond": 0, "handling": "processed" } ],
    "byHandling": { "processed": [], "redirected": [], "blocked": [], "served": [] }
  },
  "resources": [],
  "blocked": [],
  "filterMetrics": { "totalFiltered": 0, "activeRules": 0 },
  "editedRequests": 0
}
```

`routes.*` lists are limited to ten entries each. `blocked` holds the URLs of the enabled blocked rules. Streamed responses contribute their size to `payloads` and `routes` once the transfer ends.

### `GET /api/audit`

```json
{
  "errorBuckets": { "timeout": 1, "connection": 2 },
  "totalErrors": 3,
  "hostStats": [ { "host": "api.example.com", "count": 12, "avgDuration": 83.5 } ]
}
```

Error categories are `timeout`, `aborted`, `connection`, `protocol`, `upstream` and `unknown`; `hostStats` holds the 20 hosts with the highest average upstream duration.

## Event stream

### `GET /api/events`

A `text/event-stream` response (`Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`). The first event is `hello`; afterwards every connected client receives the same events with the same monotonic `id`. A `: ping` comment line is written every 15 seconds. There is no replay: a client that connects reads the current state from the other endpoints, then follows the stream. A client that stops reading is disconnected when about 1 MiB of events is queued for it.

| Event | When | `data` |
|---|---|---|
| `hello` | On connection (no `id`) | `{"interactiveModeEnabled": true, "serverTime": "<ISO date>"}` |
| `log` | An entry was added to the log window | The summary view of the entry (as in `GET /api/logs?view=summary`) |
| `stats` | The dashboard counters changed; at most one event per 250 ms while traffic flows, and one right after the logs are cleared | `{"stats", "performance", "payloads", "routes", "editedRequests", "filterMetrics"}` as in `GET /api/dashboard` |
| `logs-cleared` | After `DELETE /api/logs` | `{}` |
| `config` | A flag or the filter mode changed | The flags of `GET /api/config` |
| `rules` | Edit rules or presets, blocked rules, filter rules, local resources, breakpoint rules, network-condition rules or passthrough hosts changed | `{"kind": "edit" \| "blocked" \| "filter" \| "resources" \| "breakpoints" \| "throttle" \| "passthrough"}` |
| `breakpoint` | A flow was held at a breakpoint, or a held flow went on | `{"action": "paused", "item": {...}}` with the item of `GET /api/breakpoints/pending`, or `{"action": "resumed", "id": "…", "reason": "resume" \| "abort" \| "timeout"}` |

```bash
curl -N http://127.0.0.1:8050/api/events
```

## Local resources

A resource is `{"url", "type": "file" | "text" | "folder", "filename", "originalName", "contentType", "size", "createdAt", "enabled"}`; `url` is the fragment matched against request URLs. A folder mapping (`type: "folder"`) adds `path`, a directory of the proxy's machine, and `fallthrough`: the part of the URL path after the matched fragment is looked up inside the directory (never outside it; an empty remainder or one ending in `/` means `index.html`), the content type follows the extension, and a missing file is answered with `404 {"error": "Not found in the mapped folder"}` unless `fallthrough` is true, in which case the request goes to the upstream.

| Request | Response |
|---|---|
| `GET /api/resources` | Array of resources |
| `POST /api/resources` as `multipart/form-data` with fields `url`, `contentType` (optional, defaults to the file's type) and `file` | `{"success": true, "message": "Resource added successfully", "resource": {...}}`; `400` without `url` or without file/content |
| `POST /api/resources` as JSON `{"url", "contentType", "content"}` | Same; `content` is stored as a text file, `contentType` defaults to `text/plain` |
| `POST /api/resources` as JSON `{"url", "folderPath", "fallthrough"}` | Same, with a folder mapping; `400 {"error": "The folder does not exist"}` when `folderPath` is not a directory |
| `POST /api/resources/toggle` with `{"url", "enabled"}` | `{"success": true, "resource": {...}}`; `404` for an unknown URL, `400` for a non-boolean `enabled` |
| `DELETE /api/resources/:encodedUrl` (URL-encoded resource URL) | `{"success": true, "message": "Resource deleted successfully"}`; `404` when unknown |

## Edit rules

Rule shapes (see [ARCHITECTURE.md](../ARCHITECTURE.md#persistence) for the on-disk format):

```json
{
  "id": "…", "enabled": true, "kind": "text", "name": "Mask key",
  "startVariants": ["api_key=", "apiKey="], "endVariants": [],
  "replacement": "api_key=***", "useRegex": false, "caseSensitive": false,
  "url": "", "target": "both"
}
```

```json
{
  "id": "…", "enabled": true, "kind": "jsonPath", "name": "GetChatMessage: root.f2",
  "url": "https://api.example.com/chat.v1.ChatService/GetChatMessage",
  "path": "root.f2", "value": "replaced", "valueType": "string",
  "valueSource": null, "target": "response"
}
```

`valueType` is one of `string`, `number`, `boolean`, `null`, `json`; `valueSource` is `{"type": "file", "filename"}` for a value read from an uploaded file. Payloads are normalised: missing fields get defaults, `start`/`end` are folded into the variant lists, an unknown `target` becomes `both` for text rules and `request` for JSONPath rules.

| Request | Response |
|---|---|
| `GET /api/edit-rules` | `{"rules": [...]}` |
| `POST /api/edit-rules` with a rule object | `201 {"rule": {...}}` (an `id` is generated); `400` for a non-object body |
| `PUT /api/edit-rules/:id` with the fields to change | `{"rule": {...}}`; `404` when unknown |
| `DELETE /api/edit-rules/:id` | `204`; `404` when unknown |
| `GET /api/edit-rules/usage` | `{"usage": {"<ruleId>": n}, "totalRulesWithUsage": m}`: number of logged entries each rule touched within the current window |
| `POST /api/edit-rules/value-file` as `multipart/form-data` with `file` | `{"filename", "originalName", "valueType"}`; the file becomes a rule value through `valueSource` |
| `GET /api/edit-rule-presets` | `{"presets": [{"id", "name", "kind", "rule", "createdAt"}]}` |
| `POST /api/edit-rule-presets` with `{"name", "kind", "rule"}` | `201 {"preset": {...}}` |
| `DELETE /api/edit-rule-presets/:id` | `204`; `404` when unknown |

## Blocked rules

A rule is `{"id", "enabled", "name", "url"}`.

| Request | Response |
|---|---|
| `GET /api/blocked` | Array of rules |
| `POST /api/blocked` with `{"action": "add", "url", "name", "enabled"}` | `{"success": true, "blockedRules": [...]}`; `400` without `url` |
| `POST /api/blocked` with `{"action": "update", "id", "url", "name", "enabled"}` (fields optional) | Same; `404` when the id is unknown |
| `POST /api/blocked` with `{"action": "remove", "id"}` | Same |

The rule is active, and the matching log entries hidden, before the response is sent.

## Filter rules

A rule is `{"id", "enabled", "name", "url", "mode": "ignore" | "focus"}`; rules belong to one mode and only the rules of the current mode are active.

| Request | Response |
|---|---|
| `GET /api/filters?mode=ignore` (`mode` optional, defaults to the current one) | Array of the rules of that mode |
| `POST /api/filters` with `{"action": "add" \| "update" \| "remove", "id", "url", "name", "enabled", "mode"}` | `{"success": true, "bypassRules": [...]}` (all rules, both modes); `400` / `404` as for blocked rules |
| `GET /api/filters/suggestions?limit=10` (`limit` clamped between 1 and 50) | `{"suggestions": [{"pattern": "<host>", "count", "lastSeen", "paths": [{"path", "count"}]}]}`: hosts of the current log window not covered by a rule, ordered by request count then recency, with up to three paths each |
| `GET /api/filters/metrics` | `{"totalFiltered": n, "activeRules": m}` |

## Rules export and import

### `GET /api/rules/export`

Every rule kind in one document:

```json
{
  "format": "interactive-proxy-rules", "version": 1, "exportedAt": "2026-11-11T10:00:00.000Z",
  "editRules": [...], "presets": [...], "blockedRules": [...], "filterRules": [...], "breakpointRules": [...],
  "throttleRules": [...], "passthroughRules": [...]
}
```

The lists are the ones the respective endpoints answer; edit rules whose value comes from an uploaded file keep their `valueSource`, the file itself is not included.

### `POST /api/rules/import`

Body: a document of the form above (`format` must be `interactive-proxy-rules`; a `version` above 1 is rejected with `400`), plus `mode`: `merge` (default) keeps the existing rules and, for every list present, replaces the records whose id already exists and adds the others; `replace` keeps only the file's records, also for the lists it leaves empty. Lists that are absent are left alone in `merge` mode. Each list is saved and announced on the event stream as it is today. Answers `{"success": true, "mode": "merge", "counts": {"editRules": n, "presets": n, "blockedRules": n, "filterRules": n, "breakpointRules": n, "throttleRules": n, "passthroughRules": n}}`.

## TLS passthrough

A rule is `{"id", "enabled", "name", "host"}`: `host` is a host name or an IP, stored in lower case without scheme, path or port (a leading `*.` or `.` is dropped), and covers the host and its subdomains. A `CONNECT` tunnel to a covered host is relayed as raw bytes, without TLS termination: the client sees the server's own certificate, so applications that pin their certificates keep working, and nothing of that traffic is logged or rewritten beyond the tunnel entry itself (source `tunnel`, method `CONNECT`, with `passthrough: {"ruleId", "ruleName"}`; the log filter shows such entries with `sources=tunnel&methods=CONNECT`). Tunnels the filter rules already forward directly are unaffected.

| Request | Answer |
|---|---|
| `GET /api/passthrough` | The rules, as an array |
| `POST /api/passthrough` with `{"action": "add", "host", "name", "enabled"}` | `{"success": true, "passthroughRules": [...]}`; `400` without `host` or with one that is not a host name or an IP |
| `POST /api/passthrough` with `{"action": "update", "id", "host", "name", "enabled"}` (fields optional) | Same; `404` when the id is unknown |
| `POST /api/passthrough` with `{"action": "remove", "id"}` | Same |

## Network conditions

A rule is `{"id", "enabled", "name", "url", "delayMs", "throttleKbps"}`: `url` is a substring matched against the request URL and the full target URL, `delayMs` a latency added before the request is forwarded (0 to 600000) and `throttleKbps` a bandwidth cap on the response body in kilobits per second (0 for none); a rule needs at least one of the two. The first enabled rule that matches applies, to the plain HTTP and the HTTPS MITM flows alike (requests forwarded without inspection by a filter rule are not affected); the cap paces both buffered and streamed responses. The `throttlingEnabled` flag (`POST /api/throttling-mode`) turns every rule off at once. The log entry of an affected request carries `network: {"ruleId", "ruleName", "delayMs", "throttleKbps"}`.

| Request | Answer |
|---|---|
| `GET /api/throttle` | The rules, as an array |
| `POST /api/throttle` with `{"action": "add", "url", "name", "enabled", "delayMs", "throttleKbps"}` | `{"success": true, "throttleRules": [...]}`; `400` without `url`, with a negative or non-numeric value, or when both numbers are 0 |
| `POST /api/throttle` with `{"action": "update", "id", ...}` (fields optional) | Same; `404` when the id is unknown |
| `POST /api/throttle` with `{"action": "remove", "id"}` | Same |

## Breakpoints

A breakpoint rule is `{"id", "enabled", "name", "url", "phase": "request" | "response" | "both"}`; `url` is a substring matched against the request URL and the full target URL. A request that matches an enabled rule is held before it is forwarded (`request` phase) or before its response goes back to the client (`response` phase, the response is buffered as for a rule) until the flow is resumed or aborted through the API, or until `PROXY_BREAKPOINT_TIMEOUT_MS` passes (two minutes by default), after which it continues unchanged. Flows are held only while at least one event stream is open, and only with the `breakpointsEnabled` flag on (`POST /api/breakpoints-mode`). Requests forwarded without inspection by a filter rule are not held.

| Request | Answer |
|---|---|
| `GET /api/breakpoints` | The rules, as an array |
| `POST /api/breakpoints` with `{"action": "add", "url", "name", "enabled", "phase"}` | `{"success": true, "breakpointRules": [...]}`; `400` without `url`, with a non-boolean `enabled` or an unknown `phase` |
| `POST /api/breakpoints` with `{"action": "update", "id", "url", "name", "enabled", "phase"}` (fields optional) | Same; `404` when the id is unknown |
| `POST /api/breakpoints` with `{"action": "remove", "id"}` | Same |
| `GET /api/breakpoints/pending` | `{"items": [...]}`, the flows held right now |
| `POST /api/breakpoints/pending/:id/resume` with the edits | `{"success": true}`; `404` when nothing is held with that id, `400` for an invalid edit |
| `POST /api/breakpoints/pending/:id/abort` | `{"success": true}`; the client gets `502 {"error": "Aborted at a breakpoint"}`; `404` when nothing is held with that id |

A held flow is described as:

```json
{
  "id": "…", "phase": "request", "rule": {"id": "…", "name": "Orders", "url": "/orders"},
  "createdAt": "2026-11-11T10:00:00.000Z",
  "method": "POST", "url": "https://api.example.com/orders",
  "headers": {"content-type": "application/json"},
  "body": "{\"qty\":1}", "bodyBase64": null, "bodyIsText": true, "bodySize": 9,
  "response": null
}
```

In the `response` phase, `response` is `{"statusCode", "headers", "body", "bodyBase64", "bodyIsText", "bodySize", "bodyDecoded"}`: the response after the edit rules, with the body decompressed for display when `bodyDecoded` is true. The request fields show what was forwarded.

The edits of `resume` are, for the request phase, `method`, `url`, `headers` (the whole set, as for a replay) and `body` or `bodyBase64` (`null` for no body); for the response phase, `statusCode` (100–599), `headers` (the whole set; `content-length`, `transfer-encoding`, `connection` and `keep-alive` are dropped) and `body` or `bodyBase64`. An edited body is sent as given, so `content-encoding` is dropped with it; an unchanged body goes out as received. Absent fields keep their values, and a resume whose fields equal the held ones counts as unchanged. The log entry of the flow carries `breakpoint: {"request": …, "response": …}` with `edited`, `continued` or `aborted` per phase; after an edit the entry shows what was sent.

## System

### `POST /api/system/file-picker`

Opens the Windows file dialog on the machine running the proxy; body `{"title", "filter", "kind"}` (all optional, `filter` in the WinForms `Description|*.ext` form, `kind: "folder"` for the folder browser). Answers `{"path": "C:\\…", "canceled": false}` or `{"path": null, "canceled": true}`; `501` on other platforms.
