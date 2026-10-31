// Where the admin e2e stack listens and the owner account it makes. Shared by the stack script,
// playwright.config.ts and the fixtures, so it imports nothing.

const port = (name: string, fallback: number) => Number(process.env[name] || fallback);

export const STACK = {
  /** The HTTPS proxy the browser talks to: `/api` and `/media` go to the API, the rest to the site. */
  proxyPort: port('E2E_ADMIN_PORT', 4369),
  /** The API on HTTPS, which its Secure cookies and antiforgery need. */
  apiHttpsPort: port('E2E_ADMIN_API_HTTPS_PORT', 4349),
  /** The same API on HTTP, for the site's own server-side reads. */
  apiHttpPort: port('E2E_ADMIN_API_HTTP_PORT', 4350),
  /** A second site server, reading the real API instead of the fake one. */
  sitePort: port('E2E_ADMIN_SITE_PORT', 4359),
};

export const ADMIN_BASE_URL = `https://localhost:${STACK.proxyPort}`;

/** The first Admin, made with `admin create-owner` before the API starts. */
export const OWNER = {
  email: 'owner@e2e.runovahq.test',
  displayName: 'E2E Owner',
  password: 'owner-password-for-e2e-only',
};
