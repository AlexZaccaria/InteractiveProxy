# Changelog

## 2.0.0 (unreleased)

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

- The server binds to `127.0.0.1` by default (`PROXY_HOST`), browser access to the management API is limited to the UI origins (`PROXY_UI_ORIGINS`), and mutations from other sites are refused.
- Upstream responses that no rule can rewrite and that need no inspection are streamed to the client (`PROXY_STREAM_UNINSPECTED_RESPONSES`, now on by default; `PROXY_STREAM_THRESHOLD_BYTES`).
- One certificate authority key pair and one shared leaf key are generated with Node's `crypto`; host certificates are persisted under `server/certs/hosts/` and reused across restarts.
- All HTTPS tunnels are served by one TLS server with SNI instead of one server per connection.
- The WebSocket relay runs on `ws` on both sides: fragmentation, control frames, close codes and subprotocol negotiation follow the library.
- Zstandard bodies are handled by the built-in `zlib`; the `fzstd` dependency is gone.
- Toggle endpoints require an explicit `enabled` boolean; an empty payload answers 400.
- `image/svg+xml` responses are treated as text; file types are also derived from the URL extension when the response has no content type.
- Logging goes through `pino` with a level (`PROXY_LOG_LEVEL`) and a format (`PROXY_LOG_FORMAT`); `npm run dev` renders it through `pino-pretty`.
- Node.js 22.15 and npm 10 are required.

### Added

- `GET /api/events`: a Server-Sent Events stream of new log entries, counter changes, configuration and rule changes; the UI follows it and polls only while the stream is unavailable.
- `PROXY_UPSTREAM_H2`: HTTP/2 towards TLS upstreams that offer it (off by default).
- Non-WebSocket `Upgrade` requests inside a MITM tunnel are forwarded as plain requests.
- The proxy serves the built UI from its own port (`npm run build && npm start`).
- Streamed responses contribute their size to the dashboard statistics.
- `docs/API.md`, this changelog, and a rewrite of the other documents.

### Internal

- The server was split from one 10,340-line file into modules under `server/src/` with factories instead of module-level state; `server/index.js` only wires them.
- JSDoc types checked by `tsc` (`npm run typecheck`), ESLint 9, Prettier on server and tooling, GitHub Actions on Node 22, 24 and 26.
- npm workspaces for the server and the client with a single lockfile.
- The client is built by Vite 7 with `@vitejs/plugin-react` and Tailwind 4 (`@tailwindcss/vite`) instead of Create React App; JSX files use the `.jsx` extension, the ports come from `ports.config.json` through `vite.config.js`, the build goes to `client/dist`, and new client modules are type-checked from JSDoc (`client/jsconfig.json`).
- 305 tests with `node:test`: unit tests of the codecs, rules, routing and logs, and integration tests against local HTTP, HTTPS, HTTP/2 and WebSocket upstreams.
- The log window is a ring buffer with an index by id.

## 1.0.0

Initial release: HTTP forward proxy, HTTPS interception with a generated CA, WebSocket relay, local resources, blocked and filter rules, text and JSONPath edit rules for HTTP, Connect/gRPC and WebSocket traffic, React UI.
