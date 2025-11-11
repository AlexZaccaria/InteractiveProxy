# Interactive Proxy - Usage Guide

## 📋 Table of Contents

1. [Installation](#installation)
2. [Starting](#starting)
3. [Configuration](#configuration)
4. [Using the Proxy](#using-the-proxy)
5. [Managing Local Resources](#managing-local-resources)
6. [Request Analysis](#request-analysis)
7. [Practical Examples](#practical-examples)
8. [Interactive Mode](#interactive-mode)

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
This command starts both the proxy server (port 8080) and web interface (port 3000).

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
http://localhost:8080
```

#### Example with cURL:
```bash
curl -x http://localhost:8080 https://api.example.com/data
```

#### Example with Axios (Node.js):
```javascript
const axios = require('axios');

axios.get('http://localhost:8080/api/data', {
  headers: {
    'X-Target-URL': 'https://api.example.com/api/data'
  }
});
```

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

1. Open `http://localhost:3000`
2. Go to **"Add Resource"** tab
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
curl -X POST http://localhost:8080/api/resources \
  -F "url=/api/users" \
  -F "contentType=application/json" \
  -F "file=@users.json"

# Upload text content
curl -X POST http://localhost:8080/api/resources \
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
curl -X DELETE http://localhost:8080/api/resources/[URL_ENCODED]
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
- **Total Requests**: Total number of intercepted requests
- **Local Resources**: Requests served from local resources
- **Proxied**: Requests forwarded to remote servers
- **Blocked**: Number of blocked requests
- **Errors**: Number of failed requests

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

1. In the UI, go to "Add Resource"
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
curl http://localhost:8080/api/test

# Test proxy to external API
curl http://localhost:8080/users/1 \
  -H "X-Target-URL: https://jsonplaceholder.typicode.com/users/1"

# Test POST request
curl -X POST http://localhost:8080/api/data \
  -H "X-Target-URL: https://jsonplaceholder.typicode.com/posts" \
  -H "Content-Type: application/json" \
  -d '{"title":"Test","body":"Test body","userId":1}'
```

### Example 4: API Debugging

1. Configure your application to use the proxy
2. Open the web interface at `http://localhost:3000`
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
  - Logs all requests
  - Updates UI in real-time
  - Shows console output
  - Polls for updates every 2 seconds

- **OFF** (Gray): When you want the proxy to run without overhead
  - No logging to memory
  - No console output
  - No UI updates
  - Saves CPU and memory resources
  - Proxy continues to work normally (local resources, blocking, proxying)

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
# Check that ports 8080 and 3000 are free
netstat -ano | findstr :8080
netstat -ano | findstr :3000
```

### Local resources not being served
- Verify the URL matches exactly
- Check server console logs
- Verify Content-Type is correct

### Web interface won't connect to server
- Verify proxy server is running
- Check proxy configuration in `client/package.json`
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
