# Trusting the proxy's certificate authority

To read HTTPS traffic, the proxy terminates TLS with certificates it issues itself, signed by a certificate authority it generates on the developer's machine. A client that does not trust that authority rejects every HTTPS connection through the proxy. This document explains where the authority lives, how to trust it, how to verify it, and how to remove it.

Trusting the authority means that whoever holds `ca-key.pem` can impersonate any HTTPS site to that client. Install it only on machines you control and remove it when the proxy is no longer needed.

## Files

The authority is created on the first HTTPS request through the proxy, not at startup, under the certificates directory (`server/certs` by default, `PROXY_CERTS_DIR` to change it):

| File | Content |
|---|---|
| `ca-cert.pem` | The certificate to install, `CN=Cascade Proxy CA`, valid ten years |
| `ca-key.pem` | The authority's private key; never leaves the machine |
| `leaf-key.pem` | The key pair shared by every host certificate |
| `hosts/<host>.pem` | One certificate per host, issued on first use and reused across restarts |

Deleting the directory makes the proxy generate a new authority; the old `ca-cert.pem` then has to be removed from the clients that trusted it.

## Windows

### Certificate dialog

1. Open `server/certs/ca-cert.pem` (double click).
2. Install Certificate, choose Local Machine (administrator rights required), Next.
3. Choose "Place all certificates in the following store", Browse, select "Trusted Root Certification Authorities", OK, Next, Finish.
4. Confirm the security warning.

### PowerShell (administrator)

```powershell
Import-Certificate -FilePath "<repository>\server\certs\ca-cert.pem" -CertStoreLocation Cert:\LocalMachine\Root
```

### Verification

Open `certmgr.msc`, expand Trusted Root Certification Authorities, Certificates, and look for "Cascade Proxy CA". Chrome and Edge use this store; restart them after installing. Firefox keeps its own store: Settings, Privacy & Security, Certificates, View Certificates, Authorities, Import, select `ca-cert.pem` and tick "Trust this CA to identify websites".

### System proxy

Settings, Network & Internet, Proxy: enable "Use a proxy server" with address `127.0.0.1` and port `8050`. Open an HTTPS site; the Requests tab of the UI lists it with source `mitm`.

## curl

No installation is needed: pass the certificate to curl.

```bash
curl --cacert server/certs/ca-cert.pem -x http://127.0.0.1:8050 https://example.com/
```

The curl shipped with Git for Windows uses the Schannel TLS backend, which refuses certificates without revocation information; the proxy's certificates carry none, and the request fails with `curl: (60) schannel: the revocation status is unknown`. Add `--ssl-no-revoke`:

```bash
curl --ssl-no-revoke --cacert server/certs/ca-cert.pem -x http://127.0.0.1:8050 https://example.com/
```

Node clients accept the chain with `tls.connect({ ca: [fs.readFileSync('server/certs/ca-cert.pem')] })` or `NODE_EXTRA_CA_CERTS=server/certs/ca-cert.pem`.

## Removal

Windows certificate dialog: `certmgr.msc`, Trusted Root Certification Authorities, Certificates, right click on "Cascade Proxy CA", Delete.

PowerShell (administrator):

```powershell
Get-ChildItem Cert:\LocalMachine\Root | Where-Object { $_.Subject -like "*Cascade Proxy*" } | Remove-Item
```

Firefox: Settings, Privacy & Security, View Certificates, Authorities, select "Cascade Proxy CA", Delete or Distrust.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `ERR_CERT_AUTHORITY_INVALID` or a certificate warning in Chrome or Edge | The certificate is not in the Local Machine Trusted Root store, or the browser was not restarted after the import |
| The same in Firefox | Firefox does not read the Windows store; import the certificate in its own Authorities list |
| HTTPS sites work but the UI shows nothing | The client is not using the proxy (check the system proxy setting), or Interactive mode is off, or a filter rule in `ignore` mode matches the traffic |
| A site refuses to load through the proxy although the CA is trusted | The client pins the site's certificate (some applications and mobile apps do); add the host to the filter rules in `ignore` mode so that its tunnel is passed through untouched |
| Certificate errors after deleting `server/certs` | A new authority was generated; remove the old one from the clients and install the new `ca-cert.pem` |
