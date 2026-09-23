// lib/base-url.js
// Resolves the public base URL of the app for building email links and redirects.
//
// Priority:
//   1. APP_URL env var            → explicit override (recommended in production)
//   2. Request headers            → whatever host the user actually reached us on
//   3. CANONICAL_URL constant     → last-resort fallback
//
// This avoids emailing users links to a stale/dead deployment hostname.

const CANONICAL_URL = "https://kmc-solutions.de";

function normalize(url) {
  if (!url) return "";
  let u = String(url).trim().replace(/\/+$/, ""); // strip trailing slashes
  if (!/^https?:\/\//i.test(u)) u = "https://" + u; // tolerate "example.com"
  return u;
}

export function getBaseUrl(req) {
  // 1. Explicit configuration always wins.
  if (process.env.APP_URL) return normalize(process.env.APP_URL);

  // 2. Derive from the incoming request (works on any domain or preview deploy).
  const headers = req?.headers || {};
  const host = headers["x-forwarded-host"] || headers.host;
  if (host) {
    const isLocal = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
    const proto = headers["x-forwarded-proto"] || (isLocal ? "http" : "https");
    return `${proto}://${host}`;
  }

  // 3. Nothing else available.
  return CANONICAL_URL;
}

export { CANONICAL_URL };
