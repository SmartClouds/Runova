import type {
  SiteInfo,
  SiteSettings,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The WebSockets switch on a site's row in Websites: it saves the site as it is with only that
 * one setting changed, and Apply puts it live like any other saved change.
 */

/** Only a site that passes requests on has connections to upgrade; a redirect sends them away. */
export function carriesWebsockets(site: SiteInfo): boolean {
  return site.settings.upstream.kind !== 'redirect';
}

/**
 * The saved settings with WebSockets on or off. Basic auth users go back without a password,
 * which tells the core to keep the one it has.
 */
export function withWebsockets(site: SiteInfo, websocket: boolean): SiteSettings {
  const settings: SiteSettings = { ...site.settings, websocket };
  if (site.settings.basicAuth) {
    settings.basicAuth = {
      ...site.settings.basicAuth,
      users: site.settings.basicAuth.users.map(({ name }) => ({ name })),
    };
  }
  return settings;
}
