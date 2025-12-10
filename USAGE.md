# Interactive Proxy - Usage Guide

## 📋 Table of Contents

1. [Installation](#installation)
2. [Starting](#starting)
3. [Configuration](#configuration)
4. [Using the Proxy](#using-the-proxy)
5. [Managing Local Resources](#managing-local-resources)
6. [Request Analysis](#request-analysis)
7. [Filter Rules](#filter-rules)
8. [Blocked URLs](#blocked-urls)
9. [Edit Rules](#edit-rules)
10. [Proxy Audit Panel](#proxy-audit-panel-advanced)
11. [Practical Examples](#practical-examples)
12. [Interactive Mode](#interactive-mode)

---

## 🚀 Installation

```bash
# Clone or navigate to project directory
cd interactive-proxy

# Install all dependencies (backend + frontend)
npm run install-all
```

## ▶️ Starting

### Complete Start (Recommended)
```bash
npm run dev
```
This command starts both the proxy server (port 8050) and web interface (port 3050).

### Separate Start

**Proxy Server Only:**
```bash
npm run server
```

**Web Interface Only:**
```bash
npm run client
```

## ⚙️ Configuration

### Configure Browser/Application

To use the proxy, configure your browser or application to forward requests through:

```
http://localhost:8050
```

#### Example with cURL:
```bash
curl -x http://localhost:8050 https://api.example.com/data
```

#### Example with Axios (Node.js):
```javascript
const axios = require('axios');

axios.get('http://localhost:8050/api/data', {
  headers: {
    'X-Target-URL': 'https://api.example.com/api/data'
  }
});
```

### Environment Variables

The proxy server can be configured using environment variables.

| Variable | Default | Description |
|----------|---------|-------------|
| `PROXY_PORT` | `8050` | Port for the proxy server (overrides `backendPort` in ports.config.json) |
| `PROXY_STORAGE_DIR` | `server/storage` | Directory for persistent configuration |
| `PROXY_LOGS_DIR` | `server/logs` | Directory for logs |
| `PROXY_CERTS_DIR` | `server/certs` | Directory for certificates |
| `PROXY_MAX_LOG_ENTRIES` | `5000` | Max number of requests to keep in memory |
| `PROXY_LOG_PREVIEW_MAX_BYTES` | `0` (unlimited) | Max bytes for body previews in UI |
| `PROXY_LOG_DECOMPRESS_MAX_BYTES` | `0` (unlimited) | Max compressed body size to decompress for UI |
| `PROXY_PROTOBUF_MAX_FIELDS` | `0` (unlimited) | Max fields to decode in Protobuf |
| `PROXY_PROTOBUF_MAX_BYTES` | `0` (unlimited) | Max bytes for Protobuf messages |
| `PROXY_CONNECT_MAX_FRAMES` | `0` (unlimited) | Max Connect frames to log |
| `PROXY_CONNECT_MAX_FRAME_BYTES` | `0` (unlimited) | Max bytes per Connect frame to decode and log |
| `PROXY_WS_MAX_TEXT_BYTES` | `0` (unlimited) | Max WebSocket text message size to log |
| `PROXY_WS_LOG_BODY_ENABLED` | `true` | Enable/disable WebSocket body logging |
| `PROXY_UPSTREAM_HEADERS_TIMEOUT_MS` | `0` (default) | Timeout for upstream headers |
| `PROXY_UPSTREAM_BODY_TIMEOUT_MS` | `0` (default) | Timeout for upstream body |
| `PROXY_STREAM_UNINSPECTED_RESPONSES`| `false` | Stream large binaries directly without buffering |
| `PROXY_MITM_BYPASS_REWRITES_ENABLED`| `true` | Apply rewrites even for direct MITM flows |
| `PROXY_DEBUG_LOG` | `false` | Enable debug logging |
| `PROXY_STRICT_TLS` | `false` | Enforce strict TLS for upstream |
| `PROXY_STRICT_TLS_CA_FILE` | `""` | Path to additional CA bundle |
| `PROXY_BODY_LIMIT` | `10mb` | Max request body size |

### Ports Configuration (Single Source of Truth)

Ports for the web UI and proxy server are defined in the root `ports.config.json` file:

```json
{
  "uiPort": 3050,
  "backendPort": 8050,
  "backendHost": "localhost",
  "backendProtocol": "http"
}
```

- The backend (`npm run server`) reads `backendPort` via `server/config.js`.
  - If `PROXY_PORT` is set, it **overrides** `backendPort`.
- The frontend (`npm run client` / `npm run dev`) reads `uiPort` via the `dev-client.js` launcher, which:
  - generates `client/src/config/generatedPorts.js` used by the React app,
  - sets the `PORT` env var for the Create React App dev server.

## 🔧 Using the Proxy

### Operating Modes

The proxy works in three modes:

#### 1. **Local Resource** (Highest Priority)
If a local resource matching the requested URL exists, it is served.

```
Request: GET /api/users
Local resource: /api/users → users.json
Result: ✅ Serves local users.json
```

#### 2. **Remote Proxy**
If there's no local resource but the `X-Target-URL` header is specified, the request is forwarded.

```
Request: GET /api/users
Header: X-Target-URL: https://api.example.com/api/users
Result: ✅ Forwards to https://api.example.com/api/users
```

#### 3. **Direct Request**
If there's neither a local resource nor a target URL, a 404 error is returned.

```
Request: GET /api/users
Result: ❌ 404 - No local resource found
```

## 📁 Managing Local Resources

### Via Web Interface

1. Open `http://localhost:3050`
2. Go to the **Local** tab, open the **Local Resources** panel and click **"Add Resource"**
3. Choose between:
   - **Upload File**: Upload files (JSON, HTML, images, etc.)
   - **Text Content**: Insert content directly

#### Required Fields:

- **URL to intercept**: The URL (full or partial) to intercept
  - Example: `/api/users`
  - Example: `https://api.example.com/data.json`
  
- **Content Type**: The MIME type of the resource
  - `application/json` for JSON
  - `text/html` for HTML
  - `image/png` for PNG images
  - etc.

- **File or Content**: The file to upload or text content

### Via API

```bash
# Upload a file
curl -X POST http://localhost:8050/api/resources \
  -F "url=/api/users" \
  -F "contentType=application/json" \
  -F "file=@users.json"

# Upload text content
curl -X POST http://localhost:8050/api/resources \
  -H "Content-Type: application/json" \
  -d '{
    "url": "/api/data",
    "contentType": "application/json",
    "content": "{\"message\": \"Hello World\"}"
  }'
```

### Delete a Resource

Via web interface:
1. Go to **"Local Resources"** tab
2. Click the **Delete** button (🗑️) next to the resource

Via API:
```bash
curl -X DELETE http://localhost:8050/api/resources/[URL_ENCODED]
```

## 🔍 Request Analysis

### Web Interface

In the **"Request Logs"** tab you can:

#### Filter by Source:
- **HTTP**: Standard HTTP requests
- **HTTPS**: HTTPS requests via MITM
- **WebSocket**: WebSocket connections and messages
- **Local**: Requests served from local resources
- **Blocked**: Blocked requests
- **Error**: Failed requests

#### Filter by HTTP Method:
- GET, POST, PUT, DELETE, PATCH, OPTIONS, HEAD, etc.

#### Filter by File Type:
- JSON, HTML, CSS, JavaScript, Images, Fonts, Media, Other

#### Text Search:
Search supports advanced syntax:
- Use `;` to separate terms (AND logic - all terms must match)
- Use `!` prefix to exclude terms (NOT logic)
- Example: `!facebook; !scontent; api` - excludes facebook and scontent, shows only api

Search in:
- Request URL
- HTTP method
- Target URL (for proxy requests)
- Local resource (for local requests)
- Request and response headers
- Request and response bodies

#### Request Details:
Click on a request to see:
- Complete headers
- Request body
- Response body (with JSON/HTML/Image preview)
- Errors (if any)
- Timestamp
- Status code (for proxy requests)
- WebSocket message direction and content

### Real-time Statistics

The dashboard shows:
- **Total**: All logged traffic while Interactive Mode is ON (including
  proxied/local/blocked/error and any bypassed flows that were logged as
  `direct`/`tunnel`)
- **Served**: Requests served from local resources
- **Proxied**: Requests forwarded to remote servers (HTTP/HTTPS/WebSocket)
- **Blocked**: Requests blocked by blocked URL rules
- **Redirected**: Requests bypassed by filter rules in `Ignore` mode
- **Processed**: Requests fully processed by the proxy internals (excluding
  raw CONNECT tunnels and explicit `direct`/`tunnel` bypass flows)
- **Edited**: Requests/responses modified by edit rules (text or JSONPath)
- **Errors**: Number of failed requests

## 🎛️ Filter Rules

Filter rules control which requests are fully processed by the proxy internals
and shown in the UI. You can switch between two modes:

- **Ignore**: matching URLs are bypassed from the detailed pipeline and
  counted as **Redirected**
- **Focus**: only matching URLs are fully processed; everything else is
  bypassed

In the **"Filters"** tab you can:

- Add rules by URL (full or partial)
- Enable/disable individual rules
- Switch the global mode between Ignore and Focus
- Use automatic suggestions based on recent traffic

The dashboard counters show how many requests were redirected vs processed.

## 🛡️ Blocked URLs

Blocked URL rules are applied early in the pipeline. When a request matches an
enabled blocked rule, the proxy returns an error response instead of
forwarding the request.

In the **"Blocked"** tab you can:

- Add or remove blocked URL rules
- Enable/disable blocking globally
- Quickly block URLs directly from the logs view

## ✏️ Edit Rules

Edit rules let you rewrite traffic in-flight without touching the real backend
services.

In the **"Edit Rules"** tab you can:

- Create **text rules** that search for a portion of the content and replace it with your value
- Provide one or more boundary markers (one per line in the UI); all non-empty lines are treated as alternative patterns (OR semantics), so a single rule can match many similar cases
- Choose between plain text or regular expressions
- Toggle case sensitivity
- Enable/disable the entire edit engine and individual rules

Edit rules are applied to:

- HTTP request and response bodies
- Connect/gRPC envelopes (frames and messages)
- WebSocket messages

Edited requests are counted in the **Edited** counter on the dashboard.

### Edit Rule Usage Report (API)

To identify obsolete or rarely-used edit rules, the proxy exposes a lightweight
usage report endpoint:

```bash
curl http://localhost:8050/api/edit-rules/usage
```

Response shape:

```json
{
  "usage": {
    "rule-id-1": 42,
    "rule-id-2": 0
  },
  "totalRulesWithUsage": 1
}
```

- `usage[ruleId]` is the number of **log entries** in which that rule was
  applied at least once within the current in-memory log window.
- Counters are updated incrementally as new logs are added and decremented when
  old logs are evicted or cleared (e.g. via `DELETE /api/logs`).

This keeps aggregation and payload size minimal while still allowing the
frontend to join usage data with `/api/edit-rules` metadata.

### JSONPath rules for JSON / Protobuf / Connect

In addition to text rules, the proxy supports **JSONPath-based rules** for
structured payloads (JSON and decoded Protobuf messages):

- Each JSONPath rule is scoped by **URL pattern** so you can target specific
  endpoints (e.g. `GetChatMessage`).
- Rules define a **JSON path** (e.g. `root.f2`) and a **value** with a
  `valueType` (string, number, boolean, null).
- For plain JSON/HTTP bodies the rule updates the JSON object directly.
- For Connect/gRPC payloads the proxy:
  - decodes the Protobuf message into a JSON-like structure,
  - applies JSONPath rules,
  - re-encodes the Protobuf message, updating only fields that were
    originally strings to keep the wire format valid.

JSONPath rules are always **scoped by a URL pattern** and an optional
**target phase**:

- The URL pattern is required and is matched against the current request URL
  using the same semantics as text rules:
  - Full URLs like `https://api.example.com/v1/users` match by host and path
    (exact path or prefix, e.g. `/v1/users` or `/v1/users/123`).
  - Pure paths like `/v1/users` match any request whose path is equal to or
    starts with that prefix.
  - Generic strings like `login` or `example.com` use a case-insensitive
    substring check for backwards compatibility.
- The `target` field controls whether the rule applies to the `request`, the
  `response`, or `both` directions.

From the **Request Logs** view, when inspecting Connect/gRPC frames, JSON
keys in the tree are clickable: clicking a key opens the Edit Rules panel
pre-filled with:

- the URL pattern of the current request,
- the JSON path for the clicked key (e.g. `root.f2`),
- the current value at that path as the initial replacement value,
- a suggested rule name (`EndpointName: path`, e.g. `GetChatMessage: root.f2`).

## 📊 Proxy Audit Panel (Advanced)

For performance analysis and debugging, the proxy includes a hidden Audit Panel.

**To access:**
1. Locate the **"Proxy Server"** title and icon in the top-left corner of the web interface.
2. **Triple-click** on the icon/title area.

**Features:**
- **Latency Metrics**: P50, P90, P99, min, max, and average latency.
- **Error Analysis**: Categorized upstream errors.
- **Top Routes**: Most frequent and slowest routes grouped by handling type (Processed, Redirected, Blocked, Served).
- **Top Hosts**: Hosts with the highest average upstream latency.

## 💡 Practical Examples

### Example 1: Override a JSON API

**Scenario**: You want to test your app with mock data instead of calling the real API.

1. Create a `mock-users.json` file:
```json
{
  "users": [
    {"id": 1, "name": "John Doe"},
    {"id": 2, "name": "Jane Smith"}
  ]
}
```

2. Upload via UI:
   - URL: `/api/users`
   - Content Type: `application/json`
   - File: `mock-users.json`

3. Configure your app to use the proxy

4. All requests to `/api/users` will receive the mock data!

### Example 2: Modify an HTML Page

**Scenario**: You want to test changes to a page without modifying the original server.

1. In the UI, go to the **Local** tab and click **"Add Resource"**
2. Select "Text Content"
3. URL: `https://example.com/index.html`
4. Content Type: `text/html`
5. Insert your custom HTML
6. Save

Now when you visit `https://example.com/index.html` through the proxy, you'll see your version!

### Example 3: Test with cURL

Test the proxy with various requests:

```bash
# Test local resource
curl http://localhost:8050/api/test

# Test proxy to external API
curl http://localhost:8050/users/1 \
  -H "X-Target-URL: https://jsonplaceholder.typicode.com/users/1"

# Test POST request
curl -X POST http://localhost:8050/api/data \
  -H "X-Target-URL: https://jsonplaceholder.typicode.com/posts" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","body":"Test body","userId":1}'
```

### Example 4: API Debugging

1. Configure your application to use the proxy
2. Open the web interface at `http://localhost:3050`
3. Go to the "Request Logs" tab
4. Perform operations in your app
5. Analyze in real-time:
   - Which requests are being made
   - Headers sent
   - Request payloads
   - Responses received

## 🎮 Interactive Mode

### What is Interactive Mode?

Interactive Mode is a toggle that controls whether the proxy logs requests and updates the UI.

### When to Use

- **ON** (Green): When actively monitoring and debugging
  - Logs all requests and responses into the in-memory `requestLogs` window
    (up to a configurable maximum)
  - Updates the dashboard in real-time by polling `/api/dashboard` every
    2 seconds
  - Enables detailed logging and Connect/WebSocket inspection

- **OFF** (Gray): When you want the proxy to run without overhead
  - Disables logging to memory (no new entries are added to `requestLogs`)
  - Stops dashboard polling and most logging-related work
  - Saves CPU and memory resources
  - Proxy continues to work normally (local resources, blocking, proxying,
    bypass engine, and edit rules still apply)

### How to Toggle

Click the "Interactive Mode" switch in the header of the web interface.

### Persistence

The Interactive Mode state is saved to disk (`server/storage/config.json`) and restored when the server restarts.

### Use Cases

- Turn OFF when running the proxy in the background for extended periods
- Turn ON only when you need to actively monitor traffic
- Reduces resource usage when you're not debugging

## 🎯 Use Cases

### Frontend Development
- Test with mock data without backend
- Simulate errors and edge cases
- Develop offline

### Testing
- Test specific scenarios with controlled data
- Simulate slow responses or errors
- Isolate components

### Debugging
- Analyze HTTP traffic in detail
- Identify problematic requests
- Monitor headers and payloads
- Inspect WebSocket messages

### Prototyping
- Quickly create mock APIs
- Test integrations without real server
- Validate data flows

## 🔒 Security Notes

⚠️ **This proxy is intended for local development and testing**

- Do not use in production
- Do not expose on the internet
- Do not handle sensitive data
- Use only in controlled development environment

## 🐛 Troubleshooting

### Proxy won't start
```bash
# Check that ports 8050 and 3050 are free
netstat -ano | findstr :8050
netstat -ano | findstr :3050
```

### Local resources not being served
- Verify the URL matches exactly
- Check server console logs
- Verify Content-Type is correct

### Web interface won't connect to server
- Verify proxy server is running
- Check frontend API configuration in `client/src/config/apiConfig.js` and backend port in `server/config.js`
- Verify there are no CORS errors

### WebSocket messages not showing
- Ensure Interactive Mode is ON
- Check that WebSocket source is selected in filters
- Verify the WebSocket connection is established (look for "connected" log)

## 📞 Support

For issues or questions, check:
- Server logs in the console
- Browser logs (F12 → Console)
- Documentation in README.md
- ARCHITECTURE.md for technical details
