# Interactive Proxy

A modern interactive development proxy with a sleek web interface for intercepting, analyzing, and managing HTTP/HTTPS/WebSocket traffic.

## ✨ Main Features

### 🎯 Smart Interception
- **Local Resources**: Automatically serves manually uploaded resources
- **Transparent Proxy**: Forwards unmatched requests to original source
- **Flexible Matching**: Full or partial URLs for maximum flexibility

### 📊 Advanced Traffic Analysis
- **Real-time Monitoring**: View all requests in real-time
- **Multiple Filters**: By HTTP method, source, text search
- **Complete Details**: Headers, body, timestamp, status code
- **Live Statistics**: Dashboard with aggregated metrics

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

## 🚀 Quick Start

### Installation
```bash
# Install all dependencies (backend and frontend)
npm run install-all

# Start proxy server and web interface
npm run dev
```

### Access
- **Web UI**: http://localhost:3000
- **Proxy Server**: http://localhost:8080

## 📖 Documentation

- **[QUICKSTART.md](QUICKSTART.md)** - Quick guide to get started
- **[USAGE.md](USAGE.md)** - Complete documentation with examples

## 💡 Quick Example

### 1. Upload a local resource

In the web interface (http://localhost:3000):
1. Tab **"Add Resource"**
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
curl http://localhost:8080/api/users

# Proxy to external API
curl http://localhost:8080/posts/1 \
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
- **Axios** - HTTP client for proxy
- **Multer** - File upload handling

### Frontend
- **React** - UI library
- **TailwindCSS** - Utility-first CSS
- **Lucide React** - Icon library
- **Axios** - HTTP client

## 📁 Project Structure

```
proxy/
├── server/              # Node.js backend
│   ├── index.js        # Main proxy server
│   ├── storage/        # Uploaded local resources
│   └── logs/           # Request logs
├── client/             # React frontend
│   ├── src/
│   │   ├── App.js     # Main component
│   │   ├── components/ # UI components
│   │   │   ├── RequestLogs.js
│   │   │   ├── LocalResources.js
│   │   │   ├── BlockedResources.js
│   │   │   └── AddResource.js
│   │   └── index.css  # Global styles
│   └── public/
├── package.json        # Backend dependencies
├── README.md          # This file
├── QUICKSTART.md      # Quick guide
└── USAGE.md           # Complete documentation
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
- Counters by request type (total, local, proxy, errors)
- Automatic update every 2 seconds

### Request Logs
- Chronological view of all requests
- Filters by source (local/proxy/errors)
- Filters by HTTP method (GET/POST/PUT/DELETE/PATCH)
- Text search in URL, methods, resources
- Expandable details with complete headers and body
- Colored badges for status and type

### Local Resource Management
- View all uploaded resources
- Detailed information (type, size, date)
- Simple deletion with confirmation
- Support for any file type

### Add Resource
- Two modes: file upload or text content
- Auto-detection of content type
- Input validation
- Immediate success/error feedback
- Integrated guide

## ⚠️ Important Notes

- **Development only**: Do not use in production
- **Security**: Do not expose on internet
- **Ports**: Requires ports 8080 and 3000 to be free
- **Sensitive data**: Do not handle sensitive information

## 🐛 Troubleshooting

### Ports already in use
```bash
# Windows - Find processes on ports
netstat -ano | findstr :8080
netstat -ano | findstr :3000

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
