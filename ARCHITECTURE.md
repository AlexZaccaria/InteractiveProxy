# 🏗️ Interactive Proxy - Architecture

## 📊 Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT REQUEST                          │
│                    (Browser, App, cURL, etc.)                   │
└────────────────────────────┬────────────────────────────────────┘
                             │
                             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PROXY SERVER :8050                         │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  1. Receive Request                                      │  │
│  │     - URL, Method, Headers, Body                         │  │
│  │     - Timestamp and unique ID                            │  │
│  └──────────────────────────────────────────────────────────┘  │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  2. Check if URL is Blocked                              │  │
│  │     - Check blocked-urls.json                            │  │
│  │     - If blocked → return 204 (no content, no edits)     │  │
│  └──────────────────────────────────────────────────────────┘  │
│                             │                                   │
│                             ▼                                   │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  3. Search Local Resource                                │  │
│  │     - Check Map<URL, Resource>                           │  │
│  │     - Exact or partial match                             │  │
│  └──────────────────────────────────────────────────────────┘  │
│                             │                                   │
│              ┌──────────────┴──────────────┐                    │
│              │                             │                    │
│         MATCH FOUND                   NO MATCH                  │
│              │                             │                    │
│              ▼                             ▼                    │
│  ┌─────────────────────┐      ┌─────────────────────────────┐  │
│  │ 4a. Serve Local     │      │ 4b. Check X-Target-URL      │  │
│  │  - Read file        │      │   - Header present?         │  │
│  │  - Set headers      │      └──────────┬──────────────────┘  │
│  │  - Log: source=local│                 │                     │
│  └─────────────────────┘          ┌──────┴──────┐              │
│              │                    │             │              │
│              │                  FOUND        NOT FOUND         │
│              │                    │             │              │
│              │                    ▼             ▼              │
│              │         ┌────────────────┐  ┌─────────────┐    │
│              │         │ Proxy Request  │  │ Return 404  │    │
│              │         │ - Forward to   │  │ - Hint msg  │    │
│              │         │   target URL   │  │ - Log error │    │
│              │         │ - Log: proxied │  └─────────────┘    │
│              │         └────────────────┘                      │
│              │                    │                            │
│              └────────────────────┴────────────────────────┐   │
│                                                             │   │
│  ┌──────────────────────────────────────────────────────┐  │   │
│  │  5. Log Request (if Interactive Mode is ON)          │  │   │
│  │     - Add to requestLogs array                       │  │   │
│  │     - Limit to MAX_LOG_ENTRIES entries               │  │   │
│  │       (default 1000, configurable via env)           │  │   │
│  │     - Include: method, URL, headers, body, response  │  │   │
│  └──────────────────────────────────────────────────────┘  │   │
│                             │                               │   │
│                             ▼                               │   │
│  ┌──────────────────────────────────────────────────────┐  │   │
│  │  6. Return Response                                  │  │   │
│  │     - Status code                                    │  │   │
│  │     - Headers                                        │  │   │
│  │     - Body                                           │  │   │
│  └──────────────────────────────────────────────────────┘  │   │
└─────────────────────────────────────────────────────────────┘   │
                             │                                    │
                             ▼                                    │
┌─────────────────────────────────────────────────────────────────┘
│                      WEB UI :3050                               │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Polls /api/dashboard every 2s (if Interactive Mode is   │  │
│  │  ON) to refresh counters, performance and audit data.    │  │
│  │  - The Request Logs view fetches /api/logs on demand     │  │
│  │    when filters change or the user scrolls, and only     │  │
│  │    performs a lightweight 2s poll while the first page   │  │
│  │    is not yet full.                                      │  │
│  │  - Filters by source, method, file type and rewrite      │  │
│  │    metadata                                              │  │
│  │  - Search with advanced syntax                           │  │
│  │  - Expandable details with JSON/HTML/Image/Connect views │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 🧩 Components

### Backend (server/)

#### Main Server (index.js)
- **Express HTTP Server** on port 8050 (configurable)
- **HTTP Proxy** for standard requests
- **MITM HTTPS Proxy** with self-signed CA certificate
- **WebSocket Proxy** with message interception
- **Resource Management** API endpoints
- **Logging System** with in-memory log window and console output
- **Configuration**: Loaded via `config.js` from environment variables

#### Key Features:
- **Local Resource Matching**: Checks if URL matches any uploaded resource
- **Blocked URL Filtering**: Prevents loading of blocked URLs
- **Request Logging**: Stores request/response data in memory (when Interactive Mode is ON)
- **File Persistence**: Saves resources and config to disk
- **Decompression**: Handles gzip, deflate, br and zstd encoded responses (zstd rewrites use an optional WebAssembly codec when available)
- **WebSocket Handling**: Intercepts and logs WebSocket messages (Socket.IO compatible)

#### Data Structures:
```javascript
// In-memory storage
// Sliding log window used for the UI; capped by MAX_LOG_ENTRIES
// (default 1000, configurable via PROXY_MAX_LOG_ENTRIES).
let requestLogs = []
let dashboardStats = {            // Incrementally updated dashboard metrics
  total: 0,
  served: 0,
  proxied: 0,
  blocked: 0,
  processed: 0,
  errors: 0,
  editedRequests: 0
}
let localResources = new Map()    // URL → Resource mapping
let bypassMode = 'ignore'         // 'ignore' or 'focus'
let blockedRules = []             // Blocked URL rules
let bypassRules = []              // Filter rules for current mode
let editRules = []                // Live edit rules

// Persistent storage (files under server/storage/)
- config.json         // Global modes (interactive, filters, edit, blocked, local) and filterMode
- resources.json      // Local resources metadata
- blocked-urls.json   // Blocked URL rules
- filter-urls.json    // Filter rules definitions
- edit-rules.json     // Live edit rules
```

### Frontend (client/)

#### React Application
- **Modern UI** with TailwindCSS
- **Component-based** architecture
- **Real-time dashboard updates** via polling `/api/dashboard` every 2s when
  Interactive Mode is ON
- **Request Logs** fetched on demand from `/api/logs` (filters, scroll, and a
  lightweight 2s poll only while the first page is not yet full)
- **Advanced filtering** and search

#### Components:
- **App.js**: Main component with tabs and state management
- **RequestLogs.js**: Log viewer with filters and search
- **LocalResources.js**: View and manage uploaded resources
- **BlockedResources.js**: View and manage blocked URLs
- **FilterRules.js**: Manage filter rules and Ignore/Focus modes
- **EditRules.js**: Manage live edit rules
- **AuditPanel.js**: Detailed performance and error metrics (hidden)

#### Key Features:
- **Interactive Mode Toggle**: Control logging without stopping proxy
- **Advanced Search**: Supports `;` (AND) and `!` (NOT) operators
- **File Type Detection**: Automatic detection of JSON, images, fonts, etc.
- **Content Preview**: JSON viewer, image display, HTML rendering
- **WebSocket Message Display**: Shows direction and parsed content
- **Filter Persistence**: Saves filters to localStorage
- **Responsive Design**: Works on desktop and mobile

## 🔄 Request Flow Details

### 1. Standard HTTP Request

```javascript
Client → Proxy Server
         ↓
    Check if blocked → Yes → Return 204 (blocked - no content, no edits)
         ↓ No
    Check local resource → Found → Serve local file
         ↓ Not found
    Check X-Target-URL header → Present → Forward request
         ↓ Not present
    Return 404
```

### 1.1 Filter Rules (Bypass Engine)

After the basic routing (local resource / proxy / 404), the proxy applies the
filter rules engine when the **Filter Rules** feature is enabled:

- In **Ignore** mode, matching URLs are considered "noise" and are counted as
  **Redirected** without going through the full decoding/metadata/editing
  pipeline.
- In **Focus** mode, only matching URLs go through the full pipeline; all other
  requests are bypassed.

This engine controls which requests populate `requestLogs` and appear in the
UI, and it feeds the metrics shown in the dashboard.

### 2. HTTPS Request (MITM)

```javascript
Client → Proxy Server (CONNECT method)
         ↓
    Establish TLS tunnel with client
         ↓
    Generate fake certificate for target domain
         ↓
    Decrypt client request
         ↓
    Process as standard HTTP (see above)
         ↓
    Encrypt response
         ↓
    Send to client
```

### 3. WebSocket Connection

```javascript
Client → Proxy Server (Upgrade: websocket)
         ↓
    Establish WebSocket with client
         ↓
    Establish WebSocket with target server
         ↓
    Log connection (if Interactive Mode ON)
         ↓
    Bidirectional message relay:
      - Client → Server: Log with direction "client→domain.com"
      - Server → Client: Log with direction "domain.com→client"
      - Parse Socket.IO format (strip numeric/channel prefixes)
      - Detect and display JSON content
```

### 4. Edit Rules Pipeline

When edit rules are enabled, the proxy rewrites traffic bodies at different
layers:

- HTTP request and response bodies
- Connect/gRPC envelopes (frames and Protobuf messages)
- WebSocket messages

There are two kinds of edit rules:

- **Text rules**: plain text or regex replacements applied to string payloads
  (including Protobuf fields that look like UTF-8 text).
- **JSONPath rules**: URL-scoped rules that operate on a JSON view of the
  payload (including decoded Protobuf messages) and then update the underlying
  buffer for safe string fields (for Connect/gRPC).

Both rule types support **optional URL patterns** and **phase targeting**
(`request`, `response` or `both`):

- When the URL pattern is a full HTTP URL (e.g. `https://api.example.com/v1/users`)
  or a pure path (e.g. `/v1/users`), matching is host+path-based:
  - the host must match (for absolute URLs), and
  - the path must either be exactly equal or a prefix of the observed path
    (e.g. `/v1/users/123`).
- When the pattern is a generic string (e.g. `login`, `example.com`), a
  case-insensitive substring check is used for backwards compatibility.

This ensures that rules written with concrete URLs or paths only affect the
intended endpoints, while still allowing flexible substring patterns when
needed.

For Connect/gRPC messages, the proxy keeps both `originalFrames` (decoded from
the original payload) and `frames` (after applying any text/JSONPath rewrites)
so the UI can display both views without losing the original data.

Edited requests are tracked and exposed in the dashboard.

## 📊 Data Flow

### Resource Upload
```
UI Form → POST /api/resources
         ↓
    Multer file upload
         ↓
    Save file to server/storage/
         ↓
    Update localResources Map
         ↓
    Save resources.json metadata file
         ↓
    Return success
```

### Request Logging (when Interactive Mode is ON)
```
Incoming Request → addLog(logEntry)
                   ↓
    Check interactiveModeEnabled → No → Skip logging
                   ↓ Yes
    requestLogs.unshift(logEntry)
                   ↓
    Limit to MAX_LOG_ENTRIES entries (default 1000)
                   ↓
    Available via GET /api/logs
```

### Interactive Mode Toggle
```
UI Toggle → POST /api/interactive-mode
            ↓
    Update interactiveModeEnabled flag
            ↓
    Save to storage/config.json
            ↓
    If OFF: Stop console logging
            ↓
    Return new state
```

## 🔐 Security Considerations

### Development Only
- Self-signed CA certificate (not trusted by default)
- No authentication or authorization
- Stores all traffic in memory
- Logs may contain sensitive data

### Best Practices
- Use only on local development machine
- Do not expose proxy to network
- Remove CA certificate when not in use
- Clear logs regularly
- Use Interactive Mode OFF when not monitoring

## 🚀 Performance

### Optimizations
- **In-memory storage** for fast resource lookup
- **Streaming responses** for large files
- **Compression support** (gzip, deflate, br, zstd — with optional WebAssembly acceleration for zstd)
- **Connection pooling** for proxy requests
- **Interactive Mode** to disable logging overhead

### Limits
- **Log window size**: requestLogs is capped by MAX_LOG_ENTRIES
  (default 1000, configurable via the `PROXY_MAX_LOG_ENTRIES` env var). Oldest
  entries are removed when the cap is exceeded.
- **Dashboard polling**: the UI polls `/api/dashboard` every 2 seconds when
  Interactive Mode is ON. The Request Logs view fetches `/api/logs` on demand
  (filter changes, infinite scroll) and only performs a lightweight 2s poll
  while the first page is still incomplete.
- **Body size limits**: request body parsing is limited by `PROXY_BODY_LIMIT`
  (default `10mb`).

## 🧪 Testing

### Unit Tests
Currently no automated tests. Manual testing via:
- Web UI - Manual testing of all features

### Test Scenarios
1. Local resource serving
2. Proxy to external API
3. HTTPS interception
4. WebSocket message relay
5. Blocked URL filtering
6. Interactive Mode toggle
7. Resource upload/delete
8. Filter and search functionality

## 📈 Future Improvements

Potential enhancements:
- Custom response delays
- Request replay functionality
- Automated tests
- Request throttling
- Custom middleware support

## 🛠️ Technology Stack

### Backend
- **Node.js** - JavaScript runtime
- **Express** - Web framework
- **undici** - HTTP client for upstream proxying
- **node-forge** - Certificate generation for MITM
- **ws** - WebSocket support
- **multer** - File upload handling
- **fzstd** - Zstandard decompression (via WebAssembly bindings)

### Frontend
-- **React** - UI library
-- **TailwindCSS** - Utility-first CSS
-- **Lucide React** - Icon library
-- **react-json-tree** - JSON viewer
-- **axios** - HTTP client

## 📝 Configuration Files

### server/storage/config.json
```json
{
  "interactiveModeEnabled": true,
  "editRulesEnabled": true,
  "localResourcesEnabled": true,
  "filterRulesEnabled": true,
  "blockedRulesEnabled": true,
  "filterMode": "focus"
}
```

### server/storage/resources.json
```json
{
  "/api/users": {
    "contentType": "application/json",
    "filePath": "server/storage/1234567890.json",
    "uploadDate": "2025-01-11T19:00:00.000Z"
  }
}
```

### server/storage/blocked-urls.json
```json
[
  {
    "id": "block-1",
    "enabled": true,
    "name": "Ads",
    "url": "https://ads.example.com"
  },
  {
    "id": "block-2",
    "enabled": true,
    "name": "Tracking",
    "url": "https://tracking.example.com"
  }
]
```

### server/storage/filter-urls.json
```json
[
  {
    "id": "filter-1",
    "enabled": true,
    "name": "Focus example API",
    "url": "https://api.example.com/",
    "mode": "focus"
  }
]
```

### server/storage/edit-rules.json
```json
[
  {
    "id": "edit-1",
    "enabled": true,
    "kind": "text",
    "name": "Mask API keys",
    "start": "api_key=",
    "end": "",
    "replacement": "api_key=***",
    "useRegex": false,
    "caseSensitive": false
  },
  {
    "id": "edit-2",
    "enabled": true,
    "kind": "jsonPath",
    "name": "GetChatMessage: root.f2",
    "url": "YourApiService/YourMethod",
    "path": "root.f2",
    "value": "Custom prompt text",
    "valueType": "string"
  }
]
```

---

**For more information, see [USAGE.md](USAGE.md) and [README.md](README.md)**
