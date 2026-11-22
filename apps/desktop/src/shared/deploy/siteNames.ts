import type { SiteSettings } from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * Every name a site answers for: its domains, then the names redirected to it (www sent on to
 * the bare domain, say). A certificate for the site covers all of them, and each one needs DNS.
 */
export function siteNames(settings: Pick<SiteSettings, 'domains' | 'redirectDomains'>): string[] {
  return [...settings.domains, ...(settings.redirectDomains ?? [])];
}
