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

- **Web UI**: http://localhost:3000
- **Proxy Server**: http://localhost:8080

## 📝 First Use (3 Steps)

### 1️⃣ Upload a Local Resource

In the web interface:
1. Go to **"Add Resource"**
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
curl http://localhost:8080/api/test

# Test proxy to external API
curl http://localhost:8080/users/1 -H "X-Target-URL: https://jsonplaceholder.typicode.com/users/1"
```

### 3️⃣ View Logs

Go back to the web interface and navigate to **"Request Logs"** to see all intercepted requests!

## 📚 Complete Documentation

Read [USAGE.md](USAGE.md) for the complete guide.

## ✨ Main Features

- ✅ **Automatic interception** of all requests
- ✅ **Custom local resources** (JSON, HTML, images, etc.)
- ✅ **Transparent proxy** to remote servers
- ✅ **Real-time analysis** of all traffic
- ✅ **Advanced filters** by method, source, text search
- ✅ **Modern UI** with React and TailwindCSS
- ✅ **Live statistics** of traffic
- ✅ **Interactive Mode** toggle to save resources when not monitoring

## 🛠️ Project Structure

```
proxy/
├── server/              # Node.js backend
│   ├── index.js        # Main proxy server
│   ├── storage/        # Uploaded local resources
│   └── logs/           # Request logs
├── client/             # React frontend
│   ├── src/
│   │   ├── App.js     # Main component
│   │   └── components/ # UI components
│   └── public/
└── package.json
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

1. **Auto-refresh**: Logs update automatically every 2 seconds (when Interactive Mode is ON)
2. **Search**: Use the search bar to filter specific requests
3. **Details**: Click on a request to see complete headers and body
4. **Resources**: Local resources are saved to disk and persist between restarts
5. **Interactive Mode**: Toggle OFF to disable logging and save resources when not actively monitoring

## ⚠️ Notes

- This is a **local development** tool
- Do not use in production
- Ports 8080 and 3000 must be free

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
