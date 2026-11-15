import type { SiteDraft } from '@/lib/deploy/sites/draft';

/** What every tab of the site editor is handed. */
export interface SiteTabProps {
  draft: SiteDraft;
  set: (patch: Partial<SiteDraft>) => void;
  /** The message about a field (or anything below it), from this computer's checks or the core's. */
  error: (path: string) => string | undefined;
  /** Viewers and Operators see the settings but cannot change them. */
  readOnly: boolean;
  /** The domains the site is saved with; empty for a new site. */
  savedDomains?: readonly string[];
}
