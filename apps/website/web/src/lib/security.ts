// The site's security headers. The CSP comes from Astro (`security.csp` in astro.config.mjs), which
// hashes its own scripts and has the Node adapter send the policy as a header, prerendered pages
// included. The other headers are the same on every response, so scripts/server.ts adds them
// around the adapter's handler: prerendered files never pass through Astro middleware.
import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AstroUserConfig } from 'astro';
import { themeInitScript } from './theme';

/** Sent with every response, HTML or not. */
export const SECURITY_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ['Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload'],
  ['Referrer-Policy', 'strict-origin-when-cross-origin'],
  ['X-Content-Type-Options', 'nosniff'],
  [
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()',
  ],
];

type Hash = `sha256-${string}`;
type CspConfig = Exclude<NonNullable<NonNullable<AstroUserConfig['security']>['csp']>, boolean>;

export interface CspOptions {
  /** The public site URL; post and news covers are absolute URLs on it. */
  site: string | URL;
  /** The browser Sentry DSN, or an empty string when Sentry is off. */
  sentryDsn: string;
}

/** The `security.csp` object for the Astro config. */
export function contentSecurityPolicy({ site, sentryDsn }: CspOptions) {
  const connect = ["'self'"];
  if (sentryDsn) connect.push(new URL(sentryDsn).origin);
  const themeHash: Hash = `sha256-${createHash('sha256').update(themeInitScript).digest('base64')}`;
  return {
    directives: [
      "default-src 'self'",
      `img-src 'self' data: ${new URL(site).origin}`,
      // Vite inlines the smallest font subsets as data URLs.
      "font-src 'self' data:",
      `connect-src ${connect.join(' ')}`,
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'none'",
    ],
    // Pagefind runs its search index as WebAssembly.
    scriptDirective: { resources: ["'self'", "'wasm-unsafe-eval'"], hashes: [themeHash] },
    // React and Radix set `style` attributes, which only 'unsafe-inline' allows. Astro then leaves
    // the style hashes out, as browsers would ignore 'unsafe-inline' next to them.
    styleDirective: { resources: ["'self'", "'unsafe-inline'"] },
  } satisfies CspConfig;
}

type Listener = (request: IncomingMessage, reply: ServerResponse) => void;

/** `listener` with SECURITY_HEADERS set first, so the handler can still replace one. */
export function withSecurityHeaders(listener: Listener): Listener {
  return (request, reply) => {
    for (const [name, value] of SECURITY_HEADERS) reply.setHeader(name, value);
    listener(request, reply);
  };
}
