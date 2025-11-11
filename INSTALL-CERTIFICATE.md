# 🔐 Installing CA Certificate for Interactive Proxy

To intercept and analyze HTTPS traffic, the proxy uses MITM (Man-In-The-Middle) technique which requires installing a custom CA certificate on your system.

## ⚠️ Important

- **Development only**: Do not use in production
- **Security**: The CA certificate allows decrypting all HTTPS traffic
- **Privacy**: Use only on personal development machines
- **Removal**: Remember to remove the certificate when no longer needed

## 📍 Certificate Location

The CA certificate is automatically generated when the proxy starts and saved to:

```
c:\Projects\proxy\server\certs\ca-cert.pem
```

## 🪟 Installation on Windows 11

### Method 1: Graphical Interface (Recommended)

1. **Open the certificate**
   - Navigate to `c:\Projects\proxy\server\certs\`
   - Double-click on `ca-cert.pem`

2. **Install the certificate**
   - Click "Install Certificate..."
   - Select "Local Machine" (requires administrator privileges)
   - Click "Next"

3. **Choose the store**
   - Select "Place all certificates in the following store"
   - Click "Browse..."
   - Select **"Trusted Root Certification Authorities"**
   - Click "OK"

4. **Complete installation**
   - Click "Next"
   - Click "Finish"
   - Confirm the security warning with "Yes"

### Method 2: PowerShell (Administrator)

```powershell
# Run as Administrator
$certPath = "path/to/interactive-proxy/server/certs/ca-cert.pem"
Import-Certificate -FilePath $certPath -CertStoreLocation Cert:\LocalMachine\Root
```

## ✅ Verify Installation

1. **Open Certificate Manager**
   - Press `Win + R`
   - Type `certmgr.msc`
   - Press Enter

2. **Find the certificate**
   - Expand "Trusted Root Certification Authorities"
   - Click on "Certificates"
   - Look for "Cascade Proxy CA"

3. **Verify details**
   - Double-click on the certificate
   - "General" tab → should say "This certificate is intended for the following purposes: All"
   - "Certification Path" tab → should show "Cascade Proxy CA"

## 🧪 Test Functionality

1. **Start the proxy**
   ```bash
   npm run dev
   ```

2. **Configure Windows to use the proxy**
   - Settings → Network & Internet → Proxy
   - Enable "Use a proxy server"
   - Address: `127.0.0.1`
   - Port: `8080`

3. **Test with an HTTPS site**
   - Open your browser
   - Visit `https://www.google.com`
   - Open the proxy interface at `http://localhost:3000`
   - Go to "Request Logs"
   - You should see HTTPS requests with **MITM** badge (cyan)
   - You can expand requests to see full URLs, headers, and body

## 🔍 What You Can See with MITM

With the certificate installed, the proxy can intercept and show:

- ✅ **Complete URLs** of HTTPS requests (e.g., `https://www.google.com/search?q=test`)
- ✅ **Complete HTTP headers** (cookies, user-agent, etc.)
- ✅ **Request bodies** for POST/PUT (form data, JSON, etc.)
- ✅ **Response status codes**
- ✅ **Response headers**
- ✅ **Response bodies** with preview for JSON/HTML/images
- ✅ **Ability to serve local resources** even for HTTPS
- ✅ **WebSocket message interception** over secure connections

## 🗑️ Remove Certificate

When you're done using the MITM proxy:

### Method 1: Graphical Interface

1. Press `Win + R` → `certmgr.msc`
2. Expand "Trusted Root Certification Authorities" → "Certificates"
3. Find "Cascade Proxy CA"
4. Right-click → "Delete"
5. Confirm with "Yes"

### Method 2: PowerShell (Administrator)

```powershell
# List Cascade Proxy certificates
Get-ChildItem Cert:\LocalMachine\Root | Where-Object {$_.Subject -like "*Cascade Proxy*"}

# Remove the certificate (replace THUMBPRINT with the one shown above)
Get-ChildItem Cert:\LocalMachine\Root\THUMBPRINT | Remove-Item
```

## 🔧 Troubleshooting

### Browser still shows SSL errors

1. **Restart the browser** after installing the certificate
2. **Verify the certificate is in "Root"** and not in other stores
3. **Check that the proxy is running** on port 8080
4. **Verify Windows proxy settings**

### Chrome/Edge doesn't accept the certificate

- Chrome/Edge use the Windows certificate store
- Make sure you installed in "Trusted Root Certification Authorities"
- Completely restart the browser (close all windows)

### Firefox doesn't accept the certificate

Firefox uses its own certificate store:

1. Open Firefox
2. Settings → Privacy & Security → Certificates
3. Click "View Certificates..."
4. "Authorities" tab
5. Click "Import..."
6. Select `ca-cert.pem`
7. Check "Trust this CA to identify websites"
8. Click "OK"

### Errors "ERR_CERT_AUTHORITY_INVALID"

- The certificate is not installed correctly
- Reinstall following the steps above
- Verify it's in "Trusted Root Certification Authorities"

### Proxy doesn't decrypt HTTPS

1. Verify the certificate is installed
2. Check server logs for errors
3. Restart the proxy after installing the certificate
4. Verify Windows is using the proxy (127.0.0.1:8080)

## 🛡️ Security

### Why is it safe for local development?

- The certificate is generated locally and not shared
- The private key stays on your computer
- Only works with the proxy running
- You can remove it anytime

### Why NOT use it in production?

- Anyone with access to the certificate can intercept traffic
- No validation of the real server's identity
- Violates HTTPS security best practices
- Can expose sensitive data if the proxy is compromised

## 📚 Additional Resources

- [node-forge Documentation](https://github.com/digitalbazaar/forge)
- [How MITM Works](https://en.wikipedia.org/wiki/Man-in-the-middle_attack)
- [Windows Certificate Management](https://docs.microsoft.com/en-us/windows-server/administration/windows-commands/certutil)

---

**Remember**: This certificate is ONLY for local development. Remove it when you no longer need it!
