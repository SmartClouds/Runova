// Where the admin e2e stack listens and the owner account it makes. Shared by the stack script,
// playwright.config.ts and the fixtures, so it imports nothing.

const port = (name: string, fallback: number) => Number(process.env[name] || fallback);

export const STACK = {
  /** The HTTPS proxy the browser talks to: `/api`, `/hangfire` and `/media` go to the API, the rest to the site. */
  proxyPort: port('E2E_ADMIN_PORT', 4369),
  /** The API on HTTPS, which its Secure cookies and antiforgery need. */
  apiHttpsPort: port('E2E_ADMIN_API_HTTPS_PORT', 4349),
  /** The same API on HTTP, for the site's own server-side reads. */
  apiHttpPort: port('E2E_ADMIN_API_HTTP_PORT', 4350),
  /** A second site server, reading the real API instead of the fake one. */
  sitePort: port('E2E_ADMIN_SITE_PORT', 4359),
  /** Stands in for Cloudflare's Turnstile siteverify, so the captcha spec never uses the network. */
  siteVerifyPort: port('E2E_ADMIN_SITEVERIFY_PORT', 4379),
  /** Stands in for api.stripe.com and its hosted checkout, so the plan spec never pays anyone. */
  stripePort: port('E2E_ADMIN_STRIPE_PORT', 4389),
};

/** The keys the plan spec saves in the payment settings; the fake Stripe takes only this secret key. */
export const FAKE_STRIPE = {
  secretKey: 'sk_test_e2e',
  webhookSecret: 'whsec_e2e',
};

/** The one token the fake siteverify refuses; every other passes. */
export const REFUSED_CAPTCHA_TOKEN = 'e2e-refused';

export const ADMIN_BASE_URL = `https://localhost:${STACK.proxyPort}`;

/** The first Admin, which the API makes on start from its `Admin__*` settings. */
export const OWNER = {
  email: 'owner@e2e.runovahq.test',
  displayName: 'E2E Owner',
  password: 'owner-password-for-e2e-only',
};
