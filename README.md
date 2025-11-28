# Interactive Proxy

A modern interactive development proxy with a sleek web interface for intercepting, analyzing, and managing HTTP/HTTPS/WebSocket traffic – with live editing, smart filtering and deep Connect/gRPC and Protobuf inspection and rewrite capabilities.

## ✨ Main Features

### 🎯 Smart Interception
- **Local Resources**: Automatically serves manually uploaded resources
- **Transparent Proxy**: Forwards unmatched requests to original source (HTTP/HTTPS)
- **Flexible Matching**: Full or partial URLs for maximum flexibility
- **HTTPS MITM**: Optional man-in-the-middle mode with a local CA certificate for decrypting HTTPS traffic (see INSTALL-CERTIFICATE.md)
- **WebSocket Support**: Interception and logging of WebSocket messages

### 📊 Advanced Traffic Analysis
- **Real-time Monitoring**: View all requests in real-time
- **Multiple Filters**: By HTTP method, source, file type, origin (local/proxied/MITM/WebSocket/blocked)
- **Rich Search**: Text search with advanced operators and field-aware search (URL, headers, bodies, Connect frames)
- **Complete Details**: Headers, body, timestamp, status code, Connect/gRPC frames
- **Live Statistics**: Dashboard with aggregated metrics (total, blocked, redirected, processed, edited, served)

### 🎨 Modern and Intuitive UI
- **Modern Design**: React interface with TailwindCSS
- **Responsive**: Works on desktop and mobile
- **Dark Theme**: Dark theme to reduce eye strain
- **Optimized UX**: Intuitive and fast navigation

### 🔧 Resource Management
- **File Upload**: Upload any file type (JSON, HTML, images, etc.)
- **Text Content**: Insert JSON, HTML, CSS content directly
- **Persistence**: Resources are saved to disk
- **Simple Management**: Add and delete resources with one click

### 🎮 Interactive Mode
- **Toggle ON/OFF**: Enable/disable logging without stopping the proxy
- **Resource Saving**: When OFF, no logging to save memory and CPU
- **Persistent State**: Mode is saved to disk and restored on restart

### 🧠 Smart Filter Rules (Bypass Engine)
- **Two Modes**: `Ignore` (redirect noisy traffic away from the UI) or `Focus` (only process matching requests)
- **Rule Management**: Create URL-based rules with names, enable/disable them and switch mode from the UI
- **Suggestions**: Automatically suggested rules based on recent traffic patterns
- **Metrics**: See how many requests are redirected vs processed on the dashboard

### ✏️ Live Edit Rules
- **Global Rewriting**: Apply text or JSONPath-based rewrites to HTTP requests/responses, Connect/gRPC frames and WebSocket messages
- **Structured Rules**: Use URL-scoped JSONPath rules to target specific JSON fields (including decoded Protobuf messages)
- **Regex Support**: Use regex or plain text, with optional case sensitivity
- **Selective Enablement**: Toggle the entire edit-engine ON/OFF, or enable/disable individual rules
- **Safe Experiments**: Quickly prototype backend changes without touching the real service

## 🚀 Quick Start

### Installation
```bash
# Install all dependencies (backend and frontend)
npm run install-all

# Start proxy server and web interface
npm run dev
```

### Access
- **Web UI**: http://localhost:3050
- **Proxy Server**: http://localhost:8050

## 📖 Documentation

- **[QUICKSTART.md](QUICKSTART.md)** - Quick guide to get started
- **[USAGE.md](USAGE.md)** - Complete documentation with examples
- **[ARCHITECTURE.md](ARCHITECTURE.md)** - Internal architecture and request flow
- **[INSTALL-CERTIFICATE.md](INSTALL-CERTIFICATE.md)** - HTTPS MITM certificate installation

## 💡 Quick Example

### 1. Upload a local resource

In the web interface (http://localhost:3050):
1. Go to the **Local** tab, open the **Local Resources** panel and click **"Add Resource"**
2. URL: `/api/users`
3. Content Type: `application/json`
4. Content:
```json
{
  "users": [
    {"id": 1, "name": "John Doe"},
    {"id": 2, "name": "Jane Smith"}
  ]
}
```

### 2. Test the proxy

```bash
# Request to local resource
curl http://localhost:8050/api/users

# Proxy to external API
curl http://localhost:8050/posts/1 \
  -H "X-Target-URL: https://jsonplaceholder.typicode.com/posts/1"
```

### 3. Analyze logs

Go to **"Request Logs"** in the web interface to see all requests!

## 🎯 Use Cases

- **Frontend Development**: Test with mock data without backend
- **Testing**: Simulate specific scenarios with controlled data
- **Debugging**: Analyze HTTP traffic in detail
- **Prototyping**: Quickly create mock APIs
- **Offline Development**: Work without connection to real server

## 🛠️ Technologies

### Backend
- **Node.js** - JavaScript runtime
- **Express** - Web framework
- **undici** - HTTP client for proxying upstream requests
- **ws** - WebSocket server
- **node-forge** - HTTPS MITM and certificate generation
- **Multer** - File upload handling
- **fzstd** - Zstandard decompression (via WebAssembly bindings)

### Frontend
-- **React** - UI library
-- **TailwindCSS** - Utility-first CSS
-- **Lucide React** - Icon library
-- **Axios** - HTTP client
-- **react-json-tree** - JSON viewer

## 📁 Project Structure

```
proxy/
├── server/                 # Node.js backend
│   ├── index.js           # Main proxy server (HTTP/HTTPS, WebSocket, filters, edit rules, CA, Connect/Protobuf rewriting)
│   ├── config.js          # Server configuration (reads ports.config.json + env overrides)
│   └── storage/           # Persistent configuration and rules
│       ├── config.json        # Global modes (interactive, filters, edit, blocked, local)
│       ├── blocked-urls.json  # Blocked URL rules
│       ├── filter-urls.json   # Filter rules (ignore/focus)
│       └── edit-rules.json    # Live edit rules
├── client/                # React frontend
│   ├── src/
│   │   ├── App.js            # Main layout, dashboard and modes
│   │   ├── components/       # UI components
│   │   │   ├── RequestLogs.js     # Advanced logs viewer
│   │   │   ├── LocalResources.js  # Local resources management
│   │   │   ├── BlockedResources.js# Blocked URLs management
│   │   │   ├── FilterRules.js     # Filter rules (ignore/focus)
│   │   │   ├── EditRules.js       # Live edit rules
│   │   │   └── AuditPanel.js      # Secret audit panel for performance analysis
│   │   └── index.css         # Global styles
│   └── public/
├── package.json             # Root scripts and dependencies
├── README.md               # This file
├── QUICKSTART.md           # Quick guide
├── USAGE.md                # Complete usage documentation
├── ARCHITECTURE.md         # Internal architecture
└── INSTALL-CERTIFICATE.md  # HTTPS MITM certificate installation
```

## 🔧 Available Commands

```bash
# Development
npm run dev              # Start server + UI
npm run server           # Proxy server only
npm run client           # Web interface only

# Installation
npm run install-all      # Install all dependencies

# Production
npm run build            # Build frontend for production
```

## 🌟 Features in Detail

### Dashboard
- Real-time statistics
- Counters by request type:
  - **Total**: all logged traffic while Interactive Mode is ON (including proxied/local/blocked/error and logged bypass flows)
  - **Blocked**: requests blocked by blocked URL rules
  - **Redirected**: requests skipped by filter rules in `Ignore` mode
  - **Processed**: requests fully processed by the proxy internals
  - **Edited**: requests/responses touched by edit rules
  - **Served**: requests served from local resources
- Automatically refreshed every 2 seconds by polling `/api/dashboard` when interactive mode is ON

### Request Logs
- Chronological view of processed traffic that passes the filter rules
- Filters by source (local/proxied/MITM/WebSocket/blocked/error)
- Filters by HTTP method (GET/POST/PUT/DELETE/PATCH, etc.)
- Filters by file type (JSON, HTML, CSS, JS, images, media, fonts, other)
- Text search in URL, headers and bodies, with advanced operators
- Logs fetched on demand from `/api/logs` with pagination and infinite
  scroll
- Detailed view with headers, body, Connect/gRPC frames, WebSocket
  messages and rewrite metadata

### Local Resource Management
- View all local resources
- Detailed information (type, size, date, URL)
- Enable/disable local overriding globally or per resource
- Simple deletion with confirmation
- Support for any file type

### Filter Rules
- Define URL-based rules used by the bypass engine
- Switch between `Ignore` and `Focus` modes from the UI
- See how many requests are redirected vs processed
- Use automatic suggestions based on recent traffic

### Blocked URLs
- Manage a list of blocked URL rules
- Enable/disable blocking globally or per rule
- Quickly block from the logs view

### Edit Rules
- Create live rewrite rules applied to traffic bodies
- Choose between plain text or regex, case sensitive or not
- Scope text rules optionally by URL and by phase (`request`, `response`,
  or `both`)
- Use JSONPath rules to target structured JSON/Protobuf fields based on
  URL and JSON path
- URL patterns for edit rules support:
  - Full URLs (`https://api.example.com/v1/users`) matched by host and path
    (exact or prefix)
  - Pure paths (`/v1/users`) matched by path equality/prefix
  - Generic substrings (`login`, `example.com`) matched case-insensitively
- Apply to HTTP bodies, Connect/gRPC envelopes and WebSocket messages
- Enable/disable the entire edit engine or single rules

## ⚠️ Important Notes

- **Development only**: Do not use in production
- **Security**: Do not expose on internet
- **Ports**: Requires ports 8050 and 3050 to be free
- **Sensitive data**: Do not handle sensitive information

## 🐛 Troubleshooting

### Ports already in use
```bash
# Windows - Find processes on ports
netstat -ano | findstr :8050
netstat -ano | findstr :3050

# Kill process (replace PID)
taskkill /PID <PID> /F
```

### Dependencies not installed
```bash
# Reinstall everything
rm -rf node_modules client/node_modules
npm run install-all
```

### TailwindCSS errors
The `@tailwind` warnings are normal and resolve after `npm install` in client.

## 📝 License

MIT License - Feel free to use and modify this project!

## 🤝 Contributions

Contributions, issues and feature requests are welcome!

---

**Developed with ❤️ using Node.js and React**
