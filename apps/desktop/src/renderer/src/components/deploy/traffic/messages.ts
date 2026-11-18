import type { TrafficDimension } from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { KpiKey } from '@/lib/deploy/traffic/report';

/**
 * The words of a server's Traffic section (E109, E110), in one place so they read as one voice:
 * plain, specific, and about what the person sees and controls.
 */

export const KPI_TEXT: Record<KpiKey, { label: string; hint: string }> = {
  visitors: {
    label: 'Unique visitors',
    hint: 'An estimate, within about 2%. A visitor is counted from a fingerprint of address and browser; the address itself is never kept.',
  },
  visits: { label: 'Visits', hint: 'A visit ends after 30 minutes without a page view.' },
  pageViews: {
    label: 'Page views',
    hint: 'Pages people opened. Images, scripts, styles and bots are left out.',
  },
  bounceRate: { label: 'Bounce rate', hint: 'Visits that saw only one page.' },
  pagesPerVisit: { label: 'Pages per visit', hint: 'Page views divided by visits.' },
  visitLength: {
    label: 'Visit length',
    hint: 'The average time from the first page of a visit to its last.',
  },
  bandwidth: { label: 'Bandwidth', hint: 'Everything nginx sent, bots included.' },
  botShare: {
    label: 'Bot share',
    hint: 'Requests from crawlers and other bots. They are counted apart and kept out of the other figures.',
  },
};

export const DIMENSION_TITLES: Record<TrafficDimension, string> = {
  page: 'Pages',
  entryPage: 'Entry pages',
  referrer: 'Referrers',
  browser: 'Browsers',
  operatingSystem: 'Operating systems',
  device: 'Devices',
  country: 'Countries',
  city: 'Cities',
  statusCode: 'Status codes',
  bot: 'Bots',
};

/** What each breakdown counts, under its title. */
export const DIMENSION_UNITS: Record<TrafficDimension, string> = {
  page: 'page views',
  entryPage: 'visits',
  referrer: 'page views',
  browser: 'page views',
  operatingSystem: 'page views',
  device: 'page views',
  country: 'page views',
  city: 'page views',
  statusCode: 'requests',
  bot: 'bot requests',
};

export const DEVICE_LABELS: Record<string, string> = {
  desktop: 'Desktop',
  mobile: 'Mobile',
  tablet: 'Tablet',
};

export const TEXT = {
  allSites: 'All websites',
  liveNow: (visitors: number) => `${visitors} ${visitors === 1 ? 'visitor' : 'visitors'} now`,
  liveTitle: (requests: number) =>
    `${requests} requests in the last minute. Updates every 5 seconds.`,
  liveWaiting: 'Waiting for live visitors',
  compare: 'Compare with the period before',
  chartTitle: 'Visitors and page views',
  previous: 'Period before',
  noEarlierData: 'No earlier data',
  emptyTitle: 'No visits yet',
  emptyBody:
    'Nothing in this range yet. Visits show up here within a minute of happening; statistics count from when they were turned on.',
  offTitle: 'Traffic statistics are off',
  offBodyAdmin:
    'Turn them on and the server reads the access logs nginx already writes for each website. It reads a little every few seconds, so the sites do not slow down, and you can turn it off again at any time.',
  offBodyViewer: 'An Admin or Owner can turn traffic statistics on for this server.',
  turnOn: 'Turn on statistics',
  readExisting: 'Also count what the logs already hold (up to 200 MB a site)',
  turnedOn: 'Traffic statistics are on. The first visits show up within a minute.',
  olderCore: /older core/i,
  updateCore: 'Update the core',
  settings: 'Settings',
  seeAll: 'See all',
  nothingHere: 'Nothing in this range.',
  dbIpCredit: 'IP geolocation by DB-IP',
  dbIpLicence: 'CC BY 4.0',
  estimates:
    'Unique visitors are estimates within about 2%. Raw visitor addresses are never stored in the statistics.',
  noCountries: 'Countries are turned off in the settings.',
} as const;

export const SECURITY_TEXT = {
  title: 'Security',
  description:
    'Scans, password guessing, floods and injection probes the server noticed in the logs.',
  noAttacks: 'No attacks in the last 7 days.',
  detectionOff: 'Attack detection is off, so nothing is being watched.',
  openAttacks: 'Recent attacks',
  blockedTitle: 'Blocked addresses',
  noneBlocked: 'No address is blocked.',
  block: 'Block',
  unblock: 'Unblock',
  blocked: 'Blocked',
  settings: 'Detection settings',
  blockPreview: (address: string) =>
    `nginx will refuse ${address} on every site on this server, answering nothing at all. Pending site changes are not applied. You can unblock it here at any time.`,
  blockTitle: (address: string) => `Block ${address}?`,
  blockedToast: (address: string) => `${address} is blocked on every site.`,
  unblockTitle: (address: string) => `Let ${address} back in?`,
  unblockBody: 'nginx answers it again on every site within a few seconds.',
  unblockedToast: (address: string) => `${address} can reach the sites again.`,
  forGood: 'For good',
  automatic: 'Automatic',
} as const;
