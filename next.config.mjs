/**
 * Response headers are deliberately modest. A full Content-Security-Policy is
 * *not* here: this app loads Google Fonts, opens a socket to another origin,
 * hands out `blob:` URLs for downloads, and relies on Next's inline hydration
 * script — so a strict policy has several ways to silently break connecting or
 * lose the fonts, and deserves its own tested change.
 *
 * What is here costs nothing and cannot break a working page:
 *   - `frame-ancestors 'none'` (plus the older X-Frame-Options) so the site
 *     cannot be framed to trick someone into accepting a transfer. A CSP that
 *     names only frame-ancestors leaves scripts and styles unrestricted.
 *   - nosniff, so a response is never reinterpreted as another type.
 *   - a Referrer-Policy, so session links in the URL are not leaked in full to
 *     third parties. The /r/<id> path *is* the bearer token for a transfer.
 *   - Permissions-Policy denying what the app never uses. Camera stays allowed
 *     for same-origin, because /receive scans the QR code with it.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(self), microphone=(), geolocation=(), payment=(), usb=()",
  },
];

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // strict-mode double-mount would tear down live RTCPeerConnections
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
