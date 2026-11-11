# Changelog

## Unreleased

### Added

- Replay of a logged request from the Requests tab: a form with the method, URL, headers and body, sent again through the proxy; the new entry carries `replayOf` and a REPLAY badge. API: `GET /api/logs/:id/replay` describes the request, `POST /api/logs/:id/replay` sends it with the edits. Request bodies are kept for it up to `PROXY_REPLAY_BODY_LIMIT_BYTES` (256 KiB by default).
- "Copy as cURL" on every HTTP entry, from `GET /api/logs/:id/curl` (`viaProxy=1` for a command through the proxy).
- Breakpoints: rules (URL substring, request or response phase) that hold a matching flow until it is sent on, edited by hand or aborted from the UI. A Breakpoints tab (shortcut `6`) manages the rules and the paused flows, an editor opens when a flow pauses, and the entries carry a BREAKPOINT badge. API: `/api/breakpoints`, `/api/breakpoints/pending` with `resume` and `abort`, the `breakpoints-mode` flag, `breakpoint` events on the stream. Flows are held only while a UI is connected and continue unchanged after `PROXY_BREAKPOINT_TIMEOUT_MS` (two minutes by default).

### Internal

- `npm run lint:server` no longer fails on the empty root pattern.

## 2.0.0 (2026-11-08)

### Fixed

- Turning Interactive mode off made every proxied HTTP and HTTPS request fail with 502.
- Proxied requests whose path started with `/api` were answered by the management API instead of being forwarded.
- HTTPS targets on a port other than 443 were unreachable through the MITM tunnel.
- `ws://` and `wss://` targets in `X-Target-URL` and in absolute request URLs were rejected.
- Request bodies that were neither JSON, form-encoded nor Protobuf were forwarded empty on the plain HTTP path.
- `Keep-Alive`, `Upgrade` and `HTTP2-Settings` request headers made the upstream request fail.
- The `content-length` of a rewritten response was not recomputed when the rewrite changed the body length.
- Edit rules with a host in their URL pattern applied to every host with the same path prefix, and text rules applied to textual bodies without their URL and phase scope.
- A JSONPath rewrite re-serialised string fields that contained JSON as objects.
- A rule with an invalid regular expression blocked the loading of every rule.
- Rules saved in the pre-2.0 `start` / `end` format were ignored.
- Protobuf varints wider than 32 bits (int64 timestamps and ids) were truncated.
- Text previews dropped accented and other non-ASCII characters.
- WebSocket close frames and pings from the client were relayed as text messages, large messages were lost, and the upstream connection stayed open after the client left.
- A blocked rule became active only after its file was written; the log entry of a proxy-style blocked request had a doubled URL.
- Header lookups cached by object missed headers added after the first lookup.
- Compressed Connect frames without an encoding header were previewed as garbage.
- IPv6 hosts in brackets were not recognised as the proxy's own address.
- `stop()` never resolved after a MITM tunnel whose client had disconnected.
- Requests from the UI itself to unknown paths were logged as WebSocket entries.

### Changed

- The license is the Interactive Proxy Noncommercial No-Redistribution License 1.0, source-available and noncommercial, in place of MIT. Copies of 1.0.0 obtained under MIT keep that license.
- The server binds to `127.0.0.1` by default (`PROXY_HOST`), browser access to the management API is limited to the UI origins (`PROXY_UI_ORIGINS`), and mutations from other sites are refused.
- Upstream responses that no rule can rewrite and that need no inspection are streamed to the client (`PROXY_STREAM_UNINSPECTED_RESPONSES`, now on by default; `PROXY_STREAM_THRESHOLD_BYTES`).
- One certificate authority key pair and one shared leaf key are generated with Node's `crypto`; host certificates are persisted under `server/certs/hosts/` and reused across restarts.
- All HTTPS tunnels are served by one TLS server with SNI instead of one server per connection.
- The WebSocket relay runs on `ws` on both sides: fragmentation, control frames, close codes and subprotocol negotiation follow the library.
- Zstandard bodies are handled by the built-in `zlib`; the `fzstd` dependency is gone.
- Toggle endpoints require an explicit `enabled` boolean; an empty payload answers 400.
- `image/svg+xml` responses are treated as text; file types are also derived from the URL extension when the response has no content type.
- Logging goes through `pino` with a level (`PROXY_LOG_LEVEL`) and a format (`PROXY_LOG_FORMAT`); `npm run dev` renders it through `pino-pretty`.
- The JSON trees in the request details open to depth 2, with an "Expand all" switch on each tree; before, every node of every tree was expanded, whatever the size of the payload.
- The UI no longer forces a 1024 px minimum width: the header is one row from 1280 px and puts the counters on a second row below that; below 768 px the view buttons of the header are hidden, the tab bar scrolls sideways and the forms stack in one column.
- The audit panel has a button in the header (the triple click on the title still works) and closes with Escape.
- Every form field has an id and a label, every icon-only button an accessible name, the tab bar follows the WAI-ARIA tabs pattern (arrow keys move between tabs), and the dialogs keep the focus inside, close with Escape and give the focus back when they close.
- Node.js 22.15 and npm 10 are required.

### Added

- `GET /api/events`: a Server-Sent Events stream of new log entries, counter changes, configuration and rule changes; the UI follows it and polls only while the stream is unavailable.
- `PROXY_UPSTREAM_H2`: HTTP/2 towards TLS upstreams that offer it (off by default).
- Non-WebSocket `Upgrade` requests inside a MITM tunnel are forwarded as plain requests.
- The proxy serves the built UI from its own port (`npm run build && npm start`).
- Streamed responses contribute their size to the dashboard statistics.
- A light theme next to the dark one: the header button switches, the choice is stored under `proxy.theme`, and without a choice the UI follows the operating system.
- Keyboard shortcuts: `/` focuses the URL search, `e` exports, `c` clears the logs, `1`–`5` switch tab, `?` opens the list, `Esc` closes panels and leaves text fields.
- `docs/API.md`, this changelog, and a rewrite of the other documents.

### Internal

- The server was split from one 10,340-line file into modules under `server/src/` with factories instead of module-level state; `server/index.js` only wires them.
- JSDoc types checked by `tsc` (`npm run typecheck`), ESLint 9, Prettier on server and tooling, GitHub Actions on Node 22, 24 and 26.
- npm workspaces for the server and the client with a single lockfile.
- The client is built by Vite 7 with `@vitejs/plugin-react` and Tailwind 4 (`@tailwindcss/vite`) instead of Create React App; JSX files use the `.jsx` extension, the ports come from `ports.config.json` through `vite.config.js`, the build goes to `client/dist`, and new client modules are type-checked from JSDoc (`client/jsconfig.json`).
- The client's server data goes through TanStack Query (`client/src/lib/api.js`, `queries.js`, `queryClient.js`): one query per endpoint, mutations that invalidate what they change, the event stream applied to the cache from `App.jsx`, polling as `refetchInterval` only while the stream is not open; the flags, the filter mode and the UI state shared across tabs live in a zustand store (`client/src/store/useProxyStore.js`). `axios` is gone.
- The Requests tab is a feature folder (`client/src/features/logs/`): a hook for the filters, a hook that reads the pages of `GET /api/logs` as a TanStack infinite query (one request refreshes the whole window the client holds when a `log` event arrives), a list virtualised with `@tanstack/react-virtual`, one memoised component per card, and the details of an entry in a chunk loaded on first use; the body sections share one `GET /api/logs/:id` per entry. It replaces one 3,149-line component whose sub-components were created inside the render.
- The Edited tab is a feature folder (`client/src/features/rules/`): a hook for the create/edit form (mode, fields, the preset chosen from the dropdown, the JSONPath seed from the log view) with pure builders and validation, one component each for the explanatory box, the form, the text and JSONPath fields, the preset dropdown, the list and the memoised rule card, and the pure preset helpers in their own module; the native file picker is a mutation of `queries.js`, next to the value-file upload. Each rule card shows how many logged entries the rule modified. It replaces one 2,146-line component.
- The colours of the client are semantic tokens (`client/src/index.css`: surfaces, borders, text levels and a neutral accent as CSS variables per theme, exposed to Tailwind through `@theme inline`); the components no longer carry hard-coded hex values. The unused `AddResource` component is gone.
- Client tests with Vitest, jsdom and Testing Library (`npm run test:client`, also in CI): the JSONPath helpers, the filter query strings and the storage migration, the filter and list hooks, the filter bar and the log card; the preset helpers, the rule form hook and the rule card; the theme helpers and store, the keyboard shortcuts hook and the modal.
- 305 tests with `node:test`: unit tests of the codecs, rules, routing and logs, and integration tests against local HTTP, HTTPS, HTTP/2 and WebSocket upstreams.
- The log window is a ring buffer with an index by id.

## 1.0.0

Initial release: HTTP forward proxy, HTTPS interception with a generated CA, WebSocket relay, local resources, blocked and filter rules, text and JSONPath edit rules for HTTP, Connect/gRPC and WebSocket traffic, React UI.
