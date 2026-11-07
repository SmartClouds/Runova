/** `GET /analytics-settings`: the tracking tags and site verifications of the public site (E59). */
export interface AnalyticsSettings {
  tagsEnabled: boolean;
  googleAnalyticsIds: string[];
  googleAdsIds: string[];
  googleTagManagerId: string | null;
  clarityProjectId: string | null;
  bingUetTagId: string | null;
  googleSiteVerification: string | null;
  bingSiteVerification: string | null;
  consentBannerEnabled: boolean;
  updatedAt: string | null;
  version: string;
}

/** The text fields of the form, by their API name. Lists are typed as one line, split on commas or spaces. */
export const TEXT_FIELDS = [
  'googleAnalyticsIds',
  'googleAdsIds',
  'googleTagManagerId',
  'clarityProjectId',
  'bingUetTagId',
  'googleSiteVerification',
  'bingSiteVerification',
] as const;

export type TextField = (typeof TEXT_FIELDS)[number];

const LISTS: ReadonlySet<TextField> = new Set(['googleAnalyticsIds', 'googleAdsIds']);

/** The form behind the analytics page. */
export type AnalyticsSettingsForm = Record<TextField, string> & {
  tagsEnabled: boolean;
  consentBannerEnabled: boolean;
};

export function fromAnalyticsSettings(settings: AnalyticsSettings): AnalyticsSettingsForm {
  const text = Object.fromEntries(
    TEXT_FIELDS.map((name) => {
      const value = settings[name];
      return [name, Array.isArray(value) ? value.join(', ') : (value ?? '')];
    }),
  ) as Record<TextField, string>;
  return {
    ...text,
    tagsEnabled: settings.tagsEnabled,
    consentBannerEnabled: settings.consentBannerEnabled,
  };
}

/** The merge patch for a save. The API tidies each ID (case, a file name's .html) and checks it. */
export function analyticsPatchBody(form: AnalyticsSettingsForm) {
  const text = Object.fromEntries(
    TEXT_FIELDS.map((name) => {
      const value = form[name].trim();
      return [name, LISTS.has(name) ? value.split(/[\s,]+/).filter(Boolean) : value || null];
    }),
  );
  return {
    tagsEnabled: form.tagsEnabled,
    ...text,
    consentBannerEnabled: form.consentBannerEnabled,
  };
}

/** Whether the saved settings put any tag on the public pages. */
export const isLive = (settings: AnalyticsSettings) =>
  settings.tagsEnabled &&
  (settings.googleAnalyticsIds.length > 0 ||
    settings.googleAdsIds.length > 0 ||
    settings.googleTagManagerId !== null ||
    settings.clarityProjectId !== null ||
    settings.bingUetTagId !== null);
