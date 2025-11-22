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
│                      PROXY SERVER :8080                         │
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
│  │     - Limit to 5000 entries                          │  │   │
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
│                      WEB UI :3000                               │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐  │
│  │  Polls /api/logs every 2s (if Interactive Mode is ON)    │  │
│  │  - Displays requests in real-time                        │  │
│  │  - Filters by source, method, file type                  │  │
│  │  - Search with advanced syntax                           │  │
│  │  - Expandable details with JSON/HTML/Image preview       │  │
│  └──────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

## 🧩 Components

### Backend (server/)

#### Main Server (index.js)
- **Express HTTP Server** on port 8080
- **HTTP Proxy** for standard requests
- **MITM HTTPS Proxy** with self-signed CA certificate
- **WebSocket Proxy** with message interception
- **Resource Management** API endpoints
- **Logging System** with file and console output

#### Key Features:
- **Local Resource Matching**: Checks if URL matches any uploaded resource
- **Blocked URL Filtering**: Prevents loading of blocked URLs
- **Request Logging**: Stores request/response data in memory (when Interactive Mode is ON)
- **File Persistence**: Saves resources and config to disk
- **Decompression**: Handles gzip, deflate, br encoded responses
- **WebSocket Handling**: Intercepts and logs WebSocket messages (Socket.IO compatible)

#### Data Structures:
```javascript
// In-memory storage
let requestLogs = []              // Max 5000 entries, used for UI log view
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
- **Real-time updates** via polling (2s interval when Interactive Mode is ON)
- **Advanced filtering** and search

#### Components:
- **App.js**: Main component with tabs and state management
- **RequestLogs.js**: Log viewer with filters and search
- **LocalResources.js**: View and manage uploaded resources
- **BlockedResources.js**: View and manage blocked URLs
- **FilterRules.js**: Manage filter rules and Ignore/Focus modes
- **EditRules.js**: Manage live edit rules

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
    Limit to 5000 entries
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
- **Compression support** (gzip, deflate, br)
- **Connection pooling** for proxy requests
- **Interactive Mode** to disable logging overhead

### Limits
- **5000 log entries** maximum (oldest are removed)
- **2s polling interval** for UI updates (only when Interactive Mode is ON)
- **No request size limits** (be careful with large uploads)

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
- Performance metrics
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
- **React** - UI library
- **TailwindCSS** - Utility-first CSS
- **Lucide React** - Icon library
- **@microlink/react-json-view** - JSON viewer
- **axios** - HTTP client

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
