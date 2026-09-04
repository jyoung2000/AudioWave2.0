# Remote access

The hub supports exactly three documented modes. It never opens router ports, uses UPnP, or provisions a tunnel on your behalf.

## Truth table

| Situation | What works | What does not |
|---|---|---|
| Hub on `localhost` (default, required for first setup) | Player/companion on the same machine; pairing by QR/deep link or code; admin GUI at `http://localhost:4546` | Any other device; shareable links outside this machine |
| Hub in `lan` mode behind your firewall | Devices on the same network; QR/deep link includes the LAN endpoint + fingerprint; code-only pairing when the app already knows the endpoint | Internet access; a short code alone cannot find the hub from outside |
| Hub in `remote` mode behind a user-supplied HTTPS reverse proxy / VPN / tunnel with WebSocket support | Cross-network operation: player and companion connect outbound to the public endpoint; QR/deep links carry the public endpoint; shareable links reachable publicly | Nothing "magic": without a reachable endpoint the hub cannot be discovered |
| No hub at all | Solo mode entirely local; companion ↔ player direct pairing only on the same network over an authenticated TLS transport | Group mode, provider aggregation, shareable links |

`GET /api/v1/hub` reports `codeOnlyPairingAvailable` and `publicEndpoint`; the player and companion display these states rather than assuming reachability.

## Configuring `remote` mode

1. Complete first-run setup on localhost (replace `admin/admin`).
2. In Admin → Network set **Bind mode: remote**, the **Public endpoint** (`https://music.example.com`), and **Trusted proxy CIDRs** (the proxy's IPs, e.g. `172.18.0.0/16` for a Compose network). Restart the container when prompted.
3. Terminate TLS at the proxy and forward WebSockets.

### Caddy
```caddyfile
music.example.com {
  reverse_proxy hub:4546 {
    header_up X-Forwarded-For {remote_host}
    header_up X-Forwarded-Proto {scheme}
  }
}
```

### nginx
```nginx
server {
  listen 443 ssl http2;
  server_name music.example.com;
  # ssl_certificate / ssl_certificate_key …
  location / {
    proxy_pass http://hub:4546;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 3600s;
    client_max_body_size 2g;   # chunked file uploads
  }
}
```

### Traefik (labels on the hub service)
```yaml
labels:
  - traefik.http.routers.hub.rule=Host(`music.example.com`)
  - traefik.http.routers.hub.entrypoints=websecure
  - traefik.http.routers.hub.tls.certresolver=letsencrypt
  - traefik.http.services.hub.loadbalancer.server.port=4546
```

### VPN / private tunnel
Tailscale, WireGuard or similar: bind in `lan` mode on the VPN interface (`NP_BIND_ADDRESS=100.x.y.z`) and set the public endpoint to the VPN hostname. Devices connect outbound over the VPN.

## Headers and trust
- `X-Forwarded-For` / `X-Forwarded-Proto` are honoured only from the configured trusted proxy CIDRs; otherwise the socket address is used.
- Session cookies are `Secure` in remote mode; the admin GUI refuses to log in over plain HTTP from a non-loopback address.
- The hub sets `Content-Security-Policy`, `Strict-Transport-Security` (when `X-Forwarded-Proto: https`), `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy`.

## Threat warnings
- Exposing the admin GUI publicly makes credential stuffing possible: keep the strong password, enable the optional TOTP (Security → Two-factor) and consider restricting the admin path at the proxy.
- Shareable links are public URLs; anyone who has one can access the shared items until you revoke or expire them.
- A reverse proxy that strips `Upgrade` headers breaks group realtime; the admin Overview shows WebSocket error counts.
- LAN mode without TLS transmits the admin session in clear on your network; use it only on trusted networks or terminate TLS locally.
