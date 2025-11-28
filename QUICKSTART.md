# 🚀 Quick Start Guide

## Quick Installation
```bash
# Install all dependencies
npm run install-all

# Start server and UI
npm run dev
```

## 🌐 Access

After starting, open your browser:

- **Web UI**: http://localhost:3050
- **Proxy Server**: http://localhost:8050

Ports for both the UI and proxy server are defined in the root `ports.config.json`
file, so you can change them in a single place.

## 📝 First Use (3 Steps)

### 1️⃣ Upload a Local Resource

In the web interface:
1. Go to the **Local** tab and click **"Add Resource"**
2. Enter URL: `/api/test`
3. Choose **"Text Content"**
4. Content Type: `application/json`
5. Content:
```json
{
  "message": "Hello from proxy!",
  "status": "success"
}
```
6. Click **"Add Resource"**

### 2️⃣ Test the Proxy

Open a new terminal and run:

```bash
# Test local resource
curl http://localhost:8050/api/test

# Test proxy to external API
curl http://localhost:8050/users/1 -H "X-Target-URL: https://jsonplaceholder.typicode.com/users/1"
```

### 3️⃣ View Logs

Go back to the web interface and navigate to **"Request Logs"** to see all intercepted requests!

## 📚 Complete Documentation

- [USAGE.md](USAGE.md) – Complete usage guide
- [ARCHITECTURE.md](ARCHITECTURE.md) – Internal architecture and request flow
- [INSTALL-CERTIFICATE.md](INSTALL-CERTIFICATE.md) – HTTPS MITM certificate installation

## ✨ Main Features

- ✅ **Automatic interception** of HTTP/HTTPS/WebSocket traffic
- ✅ **Custom local resources** (JSON, HTML, images, etc.)
- ✅ **Transparent proxy** to remote servers
- ✅ **Real-time analysis** of all processed traffic
- ✅ **Advanced filters & rules** (methods, sources, text search, blocked URLs, filter modes Ignore/Focus)
- ✅ **Live edit rules** to rewrite requests/responses in-flight
- ✅ **Modern UI** with React and TailwindCSS
- ✅ **Live statistics** of traffic with dashboard counters
- ✅ **Interactive Mode** toggle to save resources when not monitoring

## 🛠️ Project Structure

```
proxy/
├── server/              # Node.js backend (HTTP/HTTPS, WebSocket, rules)
│   ├── index.js         # Main proxy server
│   ├── config.js        # Environment configuration
│   └── storage/         # Persistent config, resources and rules
├── client/              # React frontend
│   └── src/             # App.js and UI components
└── package.json         # Root scripts and dependencies
```

## 🔧 Useful Commands

```bash
# Start everything (server + UI)
npm run dev

# Proxy server only
npm run server

# Web interface only
npm run client

# Production build frontend
npm run build
```

## 💡 Tips

1. **Auto-refresh**: The dashboard updates automatically every 2 seconds via
   `/api/dashboard` when Interactive Mode is ON. The Request Logs view fetches
   `/api/logs` on demand and only performs a light 2s poll while the first
   page is still filling.
2. **Search**: Use the search bar to filter specific requests
3. **Details**: Click on a request to see complete headers and body
4. **Resources**: Local resources are saved to disk and persist between restarts
5. **Interactive Mode**: Toggle OFF to disable logging and save resources when not actively monitoring

## ⚠️ Notes

- This is a **local development** tool
- Do not use in production
- Ports 8050 and 3050 must be free

## 🎨 Feature Screenshots

### Dashboard
- Real-time statistics
- Counters by request type
- Modern and responsive interface

### Request Logs
- Multiple filters (source, method, search)
- Detailed visualization
- Expand/collapse details

### Resource Management
- Upload file or text content
- View uploaded resources
- Simple deletion

---

**Happy developing with Interactive Proxy! 🚀**
