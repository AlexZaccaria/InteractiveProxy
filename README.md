# Interactive Proxy

Interactive Proxy is a development proxy that runs on the developer's machine. It forwards HTTP requests, terminates HTTPS with a certificate authority it generates itself, relays WebSocket connections, serves uploaded files in place of upstream responses, blocks or bypasses URLs by rule, and rewrites request and response bodies in flight with text and JSONPath rules, including Connect/gRPC envelopes and Protobuf messages decoded without a schema. A web UI shows the captured traffic and edits the rules; a management API and a Server-Sent Events stream expose the same data to scripts.

## Requirements

- Node.js 22.15 or later (Zstandard support comes from the built-in `zlib`)
- npm 10 or later

## Install and run

```bash
npm install
npm run dev
```

`npm run dev` starts the proxy on `http://127.0.0.1:8050` and the UI development server on `http://localhost:3050`. The two ports are defined in `ports.config.json` (see [USAGE.md](USAGE.md#ports)).

To run everything in one process, build the UI once and start the proxy alone; it then serves the built UI on its own port:

```bash
npm run build
npm start
```

The UI is at `http://127.0.0.1:8050/`.

## First use

1. Send a request through the proxy. Either use it as an HTTP proxy, or address the proxy directly and name the target in a header:

   ```bash
   curl -x http://127.0.0.1:8050 http://example.com/
   curl -H "X-Target-URL: http://example.com/" http://127.0.0.1:8050/
   ```

2. Open the UI. The Requests tab lists the two requests; expanding one shows headers and bodies.
3. For HTTPS, the first request through the proxy creates the certificate authority under `server/certs/`. Install `ca-cert.pem` in the client's trust store (see [INSTALL-CERTIFICATE.md](INSTALL-CERTIFICATE.md)) or pass it to curl:

   ```bash
   curl --ssl-no-revoke --cacert server/certs/ca-cert.pem -x http://127.0.0.1:8050 https://example.com/
   ```

[USAGE.md](USAGE.md) describes the UI, the rules and every configuration variable.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Proxy with readable log output plus the UI development server, side by side |
| `npm run server` | Proxy alone; log lines are readable on a terminal and JSON when piped (`PROXY_LOG_FORMAT`) |
| `npm run client` | UI development server alone |
| `npm run build` | Production build of the UI into `client/dist` (Vite) |
| `npm start` | Same as `npm run server`; serves `client/dist` when it exists |
| `npm test` | Server test suite (`node --test`) |
| `npm run test:client` | Client test suite (Vitest, jsdom) |
| `npm run lint` | ESLint on server, scripts and client |
| `npm run typecheck` | `tsc` over the server's JSDoc types |
| `npm run format` / `npm run format:check` | Prettier on server, tests and tooling (the client is excluded until its migration) |

## Project layout

```
InteractiveProxy
  ├─ server/
  │    ├─ index.js            creates every component in dependency order and starts the server
  │    ├─ config.js           environment variables and ports.config.json
  │    ├─ src/
  │    │    ├─ api/           management API routers, cross-site guard, event stream
  │    │    ├─ codecs/        compression, Protobuf and Connect codecs
  │    │    ├─ logs/          log store (ring buffer), search, views, statistics
  │    │    ├─ proxy/         routing decisions, HTTP flow, MITM, WebSocket relay, streaming
  │    │    ├─ resources/     local resources served instead of the upstream
  │    │    ├─ rewrite/       rule application on HTTP, Connect and WebSocket bodies
  │    │    ├─ rules/         edit-rule schema, store, text and JSONPath engines
  │    │    ├─ state/         persisted flags (config.json)
  │    │    ├─ system/        native file picker (Windows)
  │    │    ├─ tls/           certificate authority and host certificates
  │    │    └─ util/          strings, logger, LRU cache
  │    ├─ test/               unit and integration tests
  │    ├─ storage/            persisted rules, resources and flags (created at runtime)
  │    └─ certs/              CA, leaf key and host certificates (created at runtime)
  ├─ client/                  React UI built by Vite (index.html, vite.config.js, src/)
  ├─ scripts/                 port tooling and the development launcher
  ├─ docs/API.md              management API reference
  ├─ ports.config.json        UI and proxy ports
  └─ .github/workflows/ci.yml lint, format check, typecheck, tests and build on push
```

## Documentation

- [USAGE.md](USAGE.md): clients, UI, rules, configuration, troubleshooting
- [docs/API.md](docs/API.md): management API and event stream
- [ARCHITECTURE.md](ARCHITECTURE.md): modules, request flows, persistence, tests
- [INSTALL-CERTIFICATE.md](INSTALL-CERTIFICATE.md): trusting the proxy's CA
- [CHANGELOG.md](CHANGELOG.md)
- [FUTURE-DEVELOPMENT.md](FUTURE-DEVELOPMENT.md): features not yet built, with the design of the transparent mode

## Scope and security

The proxy is a development tool for one machine. It binds to `127.0.0.1` unless `PROXY_HOST` says otherwise, has no authentication, and its management API accepts browser requests only from the UI's origins. Everything it captures stays in memory and on the local disk under `server/storage` and `server/certs`.

Terminating HTTPS means that whoever holds `server/certs/ca-key.pem` can impersonate any site to a client that trusts `ca-cert.pem`. Install the CA only on machines you control, and remove it when the proxy is no longer needed. Upstream certificates are not verified unless `PROXY_STRICT_TLS` is set.

## License

MIT. See [LICENSE](LICENSE).
