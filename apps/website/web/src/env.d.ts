interface ImportMetaEnv {
  readonly PUBLIC_SENTRY_DSN?: string;
  /** Set at build time from the environment by astro.config.mjs. */
  readonly SENTRY_ENVIRONMENT: string;
  readonly SENTRY_RELEASE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare namespace App {
  interface Locals {
    /** The staff user of an admin request, set by the middleware once the API knows the session. */
    adminUser?: import('./lib/admin/guard').AdminUser;
    /** The Runova account of an account panel request (E48), set by the middleware. */
    account?: import('./lib/account/guard').PanelAccount;
  }
}
