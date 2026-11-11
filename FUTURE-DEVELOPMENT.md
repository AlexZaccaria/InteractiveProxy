# Future development

Features considered during the 2.0 rework and not built. Each item stands on its own; the order is the one of value for a tool of this kind. Where a design was worked out, it is recorded here so that the work can start from it.

## Features

- Map-local to a folder, not only to a single file, with resolution of the request path inside it.
- Side-by-side diff of the original and the rewritten body in the log card.
- Per-host passthrough in the MITM: hosts with certificate pinning tunnelled as raw bytes.
- Download of the CA certificate from the UI, with the installation steps per platform.
- An optional `Dockerfile`.

## Transparent mode through WireGuard

Goal: route all the traffic of a device (the PC running the proxy, another PC, a phone, a VM) through a virtual network adapter, without per-application proxy settings, and analyse and modify both the HTTP/HTTPS/WebSocket flows (as today) and the packets (IP/TCP/UDP/ICMP/DNS/QUIC).

Architectural choice: the virtual adapter is created by the official WireGuard client (Windows, Linux, macOS, iOS, Android) from a configuration the proxy generates; the proxy implements the server side in user space. It is the only solution identical on every system: no driver of our own, no administrator privilege on the proxy side (it opens a UDP port). The native alternatives (WinDivert, iptables `REDIRECT` with `SO_ORIGINAL_DST`, pf `rdr`, a TUN device managed by us through Wintun, `/dev/net/tun` or utun) need three implementations and a driver or privileges per system, and remain at most an optional optimisation.

Components:

```
WireGuard client (any OS) ─ UDP ─► proxy
  └─ native Rust addon (napi-rs, prebuilt binaries per OS/arch, loaded only when the mode is on)
       ├─ boringtun: the WireGuard protocol in user space
       ├─ packet-level hooks towards JS: log, drop, delay, reorder, header rewrite, QUIC block
       └─ smoltcp: a TCP/IP stack in user space
            ├─ TCP streams ─► transparent listener ─► current pipeline (TLS/HTTP/WS, rules, logs)
            └─ UDP datagrams (DNS, QUIC, other) ─► UDP module (log, forward, block)
  └─ egress: the proxy's ordinary sockets towards the real servers
```

Stages, each usable on its own:

1. **T1, transparent listener** (in the proxy, no addon): accepts TCP connections whose destination is known out of band, reads the first byte (`0x16`: TLS, certificate from the SNI as for an open CONNECT; text: plain HTTP; anything else: raw passthrough), applies the blocked/ignore/focus rules; egress bound to the physical interface (`localAddress` on undici, `net` and `tls`). Tested with a local upstream and pre-routed connections.
2. **T2, WireGuard addon and TCP stack** (Rust: boringtun and smoltcp, with `mitmproxy_rs`, MIT, as the reference): WireGuard server on a configurable UDP port, keys generated and persisted under `server/storage`, client configuration exported as a file and as a QR code from the UI, TCP streams handed to T1; CI builds for Windows, Linux and macOS on x64 and arm64 so that `npm install` needs no local toolchain; tests with a user-space WireGuard client.
3. **T3, UDP and packets**: UDP module (DNS logged and forwarded, QUIC on UDP 443 blockable to force the fallback to TCP), packet hooks exposed to JS (log, drop, delay, reorder, header rewrite with checksum recalculation), filters per protocol and port; a "Packets" view in the UI.
4. **T4, capture on the proxy's own machine**: the only OS-dependent step, needed so that the proxy's egress does not re-enter the tunnel. Windows: binding to the physical IP is enough (strong host model); Linux: `ip rule add from <physical-ip> lookup main`; macOS: an interface-scoped route. The proxy prints the command for the current system and applies it only on confirmation.

Declared limits: the TCP payload is modified only on terminated flows (the pipeline, or a future byte-level "raw stream" channel), not at packet level, because changing the length would break the sequence and acknowledgement numbers; QUIC is blocked, not decrypted; the throughput suits a development tool, since every packet goes through Node's event loop.
