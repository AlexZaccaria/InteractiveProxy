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
│  │     - If blocked → return 403                            │  │
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
let requestLogs = [];              // Max 5000 entries
let localResources = new Map();    // URL → Resource mapping
let interactiveModeEnabled = true; // Interactive mode flag

// Persistent storage (files)
- storage/resources.json           // Local resources
- storage/config.json              // Configuration (interactive mode)
- blocked-urls.json                // Blocked URLs list
- logs/proxy-YYYY-MM-DD.log        // Daily log files
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
- **AddResource.js**: Upload new local resources

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
    Check if blocked → Yes → Return 403
         ↓ No
    Check local resource → Found → Serve local file
         ↓ Not found
    Check X-Target-URL header → Present → Forward request
         ↓ Not present
    Return 404
```

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

## 📊 Data Flow

### Resource Upload
```
UI Form → POST /api/resources
         ↓
    Multer file upload
         ↓
    Save to storage/resources/
         ↓
    Update localResources Map
         ↓
    Save resources.json
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
- `examples/test-proxy.js` - Basic proxy functionality
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
- Request/response modification rules
- Custom response delays
- Request replay functionality
- Export logs to file
- Automated tests
- Performance metrics
- Request throttling
- Custom middleware support

## 🛠️ Technology Stack

### Backend
- **Node.js** - JavaScript runtime
- **Express** - Web framework
- **http-proxy** - HTTP proxy functionality
- **node-forge** - Certificate generation for MITM
- **ws** - WebSocket support
- **multer** - File upload handling
- **axios** - HTTP client

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
  "interactiveModeEnabled": true
}
```

### server/storage/resources.json
```json
{
  "/api/users": {
    "contentType": "application/json",
    "filePath": "storage/resources/1234567890.json",
    "uploadDate": "2025-01-11T19:00:00.000Z"
  }
}
```

### server/blocked-urls.json
```json
[
  "https://ads.example.com",
  "https://tracking.example.com"
]
```

---

**For more information, see [USAGE.md](USAGE.md) and [README.md](README.md)**
