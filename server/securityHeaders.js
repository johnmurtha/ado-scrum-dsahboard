// Security headers shared by the Express server and the Cloudflare Worker.
//
// The app is a same-origin SPA with no third-party resources, so the policy
// allows only 'self'. Notes on the few relaxations:
//  - style-src 'unsafe-inline': Recharts and React inline style attributes.
//  - img-src data: blob: and connect-src data:: PNG export (html-to-image)
//    renders through data URLs and re-reads the result with fetch().
//  - A pure-script injection still cannot run (no inline/eval scripts) or
//    send the PAT off-origin (connect-src has no external hosts).
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' data:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

export const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
};
