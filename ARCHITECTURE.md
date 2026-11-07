# Architecture

The server is a Node.js program split into modules under `server/src/`, each a plain CommonJS file with JSDoc types checked by `tsc`. Nothing under `src/` keeps module-level mutable state: components are created by factories that receive their dependencies, and `server/index.js` creates them in dependency order. The client is a React application under `client/` that talks to the management API.

## Wiring

`server/index.js` reads the configuration, derives the file paths under the storage directory and creates, in this order:

1. `upstream` (`proxy/upstream`): the undici agents for `http://` and `https://` targets.
2. `ruleStore` (`rules/store`), then `textRules` and `jsonPathRules` (`rules/text-rules`, `rules/jsonpath`), the two engines bound to it.
3. `configStore` (`state/config-store`): the persisted flags; the edit-rules flag is read through the rule store.
4. `router` (`proxy/router`): blocked and filter rules plus every routing decision; it notifies the log store when blocked patterns change.
5. `resourceStore` (`resources/store`).
6. The rewrite orchestrators (`rewrite/http-json`, `rewrite/connect`, `rewrite/body`, `rewrite/websocket`), bound to the rule store, the engines and the interactive-mode getter.
7. `stats` (`logs/stats`), `suggestions` (`logs/suggestions`) and `logStore` (`logs/store`), whose add/remove hooks feed the first two.
8. `entries` (`logs/entries`): the log-entry factory bound to the log store.
9. `httpFlow` (`proxy/http-flow`), the API router (`api`), the Express app (`app`), `webSocketProxy` (`proxy/websocket`) and `mitm` (`proxy/mitm`).
10. `createProxyServer` (`server`): the listening `http.Server` with its `request`, `upgrade` and `connect` handlers.

`index.js` starts the server when run directly (`require.main === module`) and exports `app`, `server`, `start()`, `stop()`, the configuration and an `internals` object with the module functions, which the tests use.

## Request flows

### Plain HTTP

```
client ──► http.Server request
             ├─ tryHandleHttpBypass (proxy/http-flow)
             │    ├─ blocked rule matches ──► 204, logged as blocked
             │    └─ filter rules say direct ──► forwardDirectHttp: streamed, no inspection
             └─ Express app (app.js)
                  ├─ proxy-targeted request (absolute URL, X-Target-URL, foreign Host)
                  │    └─ handleProxiedHttpRequest
                  │         ├─ local resource matches ──► served from disk
                  │         └─ forward: header rewrites ──► upstream ──► stream or buffer+rewrite ──► log
                  ├─ /api ──► management API (cross-site guard first)
                  ├─ client/dist ──► static UI, when built
                  └─ anything else ──► handleProxiedHttpRequest ──► 404 without a target
```

The proxy-targeted guard runs before the API router, so a proxied request whose path starts with `/api` is forwarded, not answered by the API. Request bodies are captured raw by the body parsers (`app.js`) for every content type; multipart bodies addressed to the API are left to `multer`.

### HTTPS (CONNECT)

`proxy/mitm` handles the `connect` event. A tunnel that the filter rules mark as direct is piped byte for byte (`proxy/tunnel`). Every other tunnel is terminated: the handler keeps one `https.Server`, created on the first CONNECT, whose SNI callback issues the certificate of the name the client asks for (secure contexts cached, 500 entries); clients without SNI get the certificate of the CONNECT host, set as the server's default context right before the socket is handed over. The target host and port travel with the socket, so the decrypted requests know where to go even on a non-443 port. Decrypted requests then follow the same local-resource / rewrite / forward / log pipeline as plain HTTP; a decrypted WebSocket upgrade goes to the WebSocket relay; any other `Upgrade:` request is forwarded as a plain request.

The certificate authority (`tls/ca`) is created on first use: `ca-key.pem` and `ca-cert.pem` (`CN=Cascade Proxy CA`, ten years), one shared leaf key pair `leaf-key.pem`, and one certificate per host under `hosts/<host>.pem` (subject and `*.host` alternative name, one year, random serial), written atomically and reloaded on a cache miss when still valid and bound to the leaf key. Keys come from Node's `crypto`; node-forge builds and signs the X.509 structures. Issuing a certificate for a new host costs the signature alone (about 19 ms measured); a reload from disk about 4 ms; the in-memory cache (500 entries) nothing.

### WebSocket

`proxy/websocket` handles the `upgrade` event of the HTTP server and the decrypted upgrades of the MITM server. After the blocked / direct / proxy decision, the relay opens the target with the `ws` client (the client's subprotocol offers are passed through) and, once the target is open, accepts the client with a `ws` server in `noServer` mode announcing the subprotocol the target selected. Messages are relayed through the rewrite engine and the log; pings, pongs and close frames (code and reason) are mirrored; an abnormal closure on one side terminates the other. Compression is never negotiated so that every frame can be read.

### Streaming

`proxy/streaming` decides, per response, whether anything needs the whole body: a response is piped to the client when no text or JSONPath rule can apply to its URL and phase and either Interactive mode is off, the content type is binary, the response is an event stream, or its `content-length` exceeds `PROXY_STREAM_THRESHOLD_BYTES` (1 MiB by default). Streamed entries are logged first and get their size when the transfer ends; a client that disconnects aborts the upstream request. Everything else is buffered, decoded, rewritten and previewed by `rewrite/body`. `HEAD` responses are never streamed.

## Rule engine

`rules/schema` defines the rule shapes and the pure helpers: normalisation of API payloads and on-disk records, serialisation, JSONPath parsing (`root.a.b[0]`, `root.items[?(@.id=='x')]`), the compilation of a text rule into a matcher (`between`, `prefix`, `suffix`, literal or regular expression) and the literal replacement primitive.

`rules/store` owns the rules and presets, their files, the global enabled flag and the usage counters. `rebuildCache()` compiles the enabled rules: every combination of a text rule's start and end variants becomes one compiled matcher sharing the rule's id; JSONPath rules are parsed into segments and require a URL pattern. A variant whose regular expression does not compile is skipped with a warning.

`rules/url-match` gives every rule kind, the filter rules and the router the same URL semantics: a pattern that is a full URL matches candidates with the same host and an equal or prefixed path; a pattern starting with `/` matches by path prefix; anything else is a case-insensitive substring of the URL. The request URL and the full target URL are both candidates, but a pattern with a host is satisfied only by a candidate that carries that host.

`rules/text-rules` applies compiled text rules to strings, header maps and UTF-8 buffers, filtered by phase and URL when a context is given. `rules/jsonpath` applies JSONPath rules to objects and to single Protobuf messages (decoded to the `f1`, `f2`, ... view by `codecs/protobuf`, rewritten, re-encoded). `rules/metadata` records on a log entry which rules applied and increments their usage.

The orchestrators under `rewrite/` connect the engines to the flows: `http-json` (JSON bodies with transparent content-encoding, header rewrites), `connect` (Connect/gRPC envelopes frame by frame, unary Protobuf bodies, the before/after views), `body` (request and buffered response bodies, the logging view) and `websocket` (text frames and the JSON part of frames, Socket.IO prefixes preserved). A JSONPath rule works on the body as parsed: a string field that contains JSON is not re-serialised as an object.

## Codecs

- `codecs/compression`: gzip, deflate, Brotli and Zstandard through the built-in `zlib`, content-type classification (textual, binary, Protobuf), case-insensitive header lookup with a per-object cache that is invalidated when keys change.
- `codecs/protobuf`: schema-less wire-format parsing and encoding, 64-bit varints (exact up to 2^53), printable-text rewriting inside nested messages, the JSON view.
- `codecs/connect`: the 5-byte frame prefix (flags, big-endian length), per-frame decompression when a Connect encoding header names the codec (a compressed frame without one is left encoded and annotated), previews and JSON views, envelope rebuilding.

## Logs

`logs/store` keeps the newest `PROXY_MAX_LOG_ENTRIES` entries in a ring buffer with a `Map` by id: adding, evicting the oldest and looking an entry up are constant-time, and both iteration orders need no copy. On insertion an entry is enriched (blocked-rule visibility, lower-cased search text, file type, search snapshots, metrics); the `onAdd` / `onRemove` hooks keep the statistics and the suggestion tracker aligned with the window, and an evicted entry releases the usage counters of the rules it recorded.

`logs/search` holds the filter behind `/api/logs` (oldest first, the query parameters described in [docs/API.md](docs/API.md#get-apilogs)); `logs/views` builds the summary and full views and paginates; `logs/stats` derives the dashboard counters, the latency and payload aggregates and the per-route statistics incrementally, plus the audit snapshot; `logs/suggestions` ranks hosts for the filter-rule suggestions; `logs/entries` builds the entries for HTTP flows, WebSocket connections, messages and summaries; `logs/preview` produces the size-bounded UTF-8 previews (accented and other non-ASCII letters kept; control characters and invalid UTF-8 count as non-printable) and the tolerant JSON parsing used by previews and WebSocket frames.

## Management API and UI

`app.js` builds the Express application: CORS restricted to the UI origins, `trust proxy`, the body parsers (Protobuf raw, JSON, URL-encoded, then a raw catch-all for every other type), the proxy-targeted guard, the `/api` router, the static UI from `client/dist` when it exists, and the catch-all proxy handler. `api/index` mounts the route groups behind the cross-site guard; `api/events` keeps the Server-Sent Events clients and publishes the changes the stores report through their `onChange` / `onEntryAdded` listeners. The endpoints and the event contract are in [docs/API.md](docs/API.md).

The client is a React application built by Vite: `client/index.html` loads `src/main.jsx`, `vite.config.js` reads `ports.config.json` and injects the backend address as the `__PROXY_PORTS__` constant (`src/config/apiConfig.js`), `@tailwindcss/vite` compiles the styles from the single `@import "tailwindcss"` in `src/index.css`.

Server data goes through TanStack Query. `src/lib/api.js` wraps `fetch` for the management API (JSON in and out, an `ApiError` carrying the status and the parsed body on failure); `src/lib/queries.js` defines one query key per endpoint (`config`, `dashboard`, `edit-rules`, `edit-rule-presets`, `edit-rules-usage`, `blocked`, `['filters', mode]`, `filter-suggestions`, `filter-metrics`, `resources`, `audit`), the hooks that read them and the mutations that invalidate what they change and resolve once the refetch is done; `src/lib/queryClient.js` holds the cache (data always stale, no refetch on window focus, one retry). `src/store/useProxyStore.js` is a zustand store for the state shared across tabs: the five flags and the filter mode mirrored from `GET /api/config` and from the `config` events, whether the event stream is open, the active tab, the audit panel and the JSONPath seed handed from the log view to the edit-rules form; the flag toggles are store actions that POST and mirror the server's answer. `App.jsx` holds the header and the tabs; `components/` holds one component per tab plus the modal and the audit panel; each tab reads its own queries and flags, so the only props left are the modal helpers.

`hooks/useProxyEvents.js` subscribes to `GET /api/events` and `App.jsx` applies the events to the cache: `stats` replaces the dashboard payload (keeping the cached `resources` and `blocked` lists), `config` updates the config payload and the store, `rules` invalidates the rule, resource and dashboard queries, `log` bumps the version `RequestLogs` refetches its window on (debounced, so the server-side filters keep applying) and, after 500 ms without further entries, invalidates the suggestions, the audit and the edit-rule usage, `logs-cleared` resets the log list and invalidates the dashboard, the audit and the usage. `RequestLogs.jsx` still fetches its window itself (pagination, filters, the details of an entry) through `src/lib/api.js`. Polling runs only while the stream is not open (no `EventSource`, or a connection being retried): `refetchInterval` on the dashboard (2 s), the filter suggestions (1 s, Redirect mode only) and the audit (5 s) queries, plus the first-page poll of `/api/logs`; the dashboard is refetched whenever the stream opens, because it has no replay.

## Persistence

All files live under the storage directory (`server/storage` by default) and are read at startup.

| File | Format |
|---|---|
| `config.json` | `{"interactiveModeEnabled", "editRulesEnabled", "localResourcesEnabled", "filterRulesEnabled", "blockedRulesEnabled", "filterMode"}` |
| `blocked-urls.json` | Array of `{"id", "enabled", "name", "url"}` |
| `filter-urls.json` | Array of `{"id", "enabled", "name", "url", "mode"}`; `bypass-urls.json` is the pre-2.0 name and is still read |
| `edit-rules.json` | Array of rules in the shapes shown in [docs/API.md](docs/API.md#edit-rules); long `replacement` and `value` strings may be stored as arrays of segments and are joined on load; records with a single `start` / `end` pair (the pre-2.0 format) are folded into `startVariants` / `endVariants` |
| `edit-rule-presets.json` | Array of `{"id", "name", "kind", "rule", "createdAt"}` |
| `resources.json` | Object keyed by resource URL: `{"type", "filename", "originalName", "contentType", "size", "createdAt", "enabled"}`; the payloads are files next to it |

Writes happen after the in-memory state is updated, so a change is active before its file is written; blocked rules and edit rules await the write before answering the API.

## Logging

`util/logger` wraps `pino`. Every line has a `scope` and a message; errors go in `err`. `PROXY_LOG_FORMAT=json` writes one object per line; `pretty` writes `[proxy][scope] message` through the console (the default on a terminal and in the tests, where warnings are captured by replacing `console.warn`). `npm run dev` runs the server with the JSON format and renders it through `pino-pretty` (`scripts/devServer.js`).

## Type checking

`server/jsconfig.json` runs `tsc` in `checkJs` and `strict` mode over `index.js` and `src/**`; types are expressed as JSDoc (`@param`, `@returns`, `@typedef`, casts). The `paths` entries map `events`, `punycode` and `string_decoder` to `@types/node`, because the browser polyfill packages installed with the client would otherwise be picked up and checked. `npm run typecheck` is part of CI.

## Tests

`npm test` runs `node --test` in `server/`: 305 tests in 18 files, each file in its own process.

- `server/test/helpers/load-server.js` requires `server/index.js` after pointing the storage, certificate and log directories to a temporary directory and choosing a free port, without listening; integration tests call `start()` in `before` and `stop()` in `after`.
- `server/test/*.test.js` are unit tests of the module functions through `internals`: Protobuf and Connect codecs, text and JSONPath rules, URL matching, compression and content types, routing, log search, streaming decisions, the certificate authority, WebSocket helpers.
- `server/test/integration/*.test.js` run the proxy against local upstreams: HTTP forwarding and bypass, the management API and the cross-site guard, HTTPS through CONNECT (self-signed upstream, SNI, no-SNI clients, large bodies, event streams), WebSocket relays (plain and through a tunnel), the event stream, hop-by-hop headers and HTTP/2 upstreams.

CI (`.github/workflows/ci.yml`) runs lint, the format check, the type check, the tests and the client build on Node 22, 24 and 26.
