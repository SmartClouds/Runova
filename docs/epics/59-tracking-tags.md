# E59 Tracking tags and site verification

Milestone: standalone (Website). Depends on: E41 (the website API, its audit log), E52 (the admin
Settings page).

## Goal

An Admin sets up visitor analytics and site verification for the public site from the admin panel,
and changes or turns them off again, without a rebuild or a redeploy. A new **Analytics** tab under
Settings holds:

- Google: Analytics 4 measurement IDs, Google Ads tags, a Tag Manager container and the Search
  Console verification file.
- Microsoft: a Clarity project (how visitors move through pages, with heatmaps and recordings), the
  Microsoft Advertising (Bing) UET tag and the Bing Webmaster Tools verification code.
- A cookie consent banner, and one switch that turns all the tags on or off.

The public pages are prerendered, so the IDs can not be written into them at build time. Each page
reads them in the browser from the site's own `/nav/analytics.json` and loads the tags only when
there are some. That route always answers 200 (with no tags when the API is down), so a page never
logs an error for it. The verification files are rendered per request from the saved codes.

The admin pages and the account panel never load a tag. Their CSP stays as it was: only
BaseLayout, which the public pages use, adds the vendors' origins to the page's policy.

## Tasks

- [x] T1 Storage (`AnalyticsSettings` table, one row, migration `AnalyticsSettings`): the switch,
  the lists of Google Analytics and Google Ads IDs, the Tag Manager, Clarity and UET IDs, the two
  verification codes, the consent switch, when it changed and the row version.
- [x] T2 Admin API (`GET`/`PATCH /analytics-settings`, Admin only): ETag and If-Match, each ID
  tidied (case, a file name's `.html`) and checked against its shape, lists of up to 5, the tags on
  only with at least one tag, and an `analytics-settings.update` audit entry naming the fields.
  Mapping through `AnalyticsMapper` (Mapperly), with its own unit tests.
- [x] T3 Public API (`GET /site-analytics`, anonymous): the tags while they are on, the consent
  flag, and the verifications always. Kept by the API for 30 seconds (a save clears it) and sent
  with the list cache header.
- [x] T4 Contract: `docs/website/api-contract.md` and the OpenAPI snapshot.
- [x] T5 Site: `/nav/analytics.json` reads the API on the server and passes on the tags; a module
  script in BaseLayout rebuilds each vendor's snippet with DOM calls, since the CSP blocks inline
  scripts. Only IDs of the right shape reach a script URL; anything odd and the page loads nothing.
- [x] T6 Verification: `/<file>.html` answers with Search Console's line for the saved file name
  and 404 for any other; `/BingSiteAuth.xml` carries the saved Bing code.
- [x] T7 Consent: with the banner on, no tag loads until the visitor clicks Allow. The choice is
  kept in the browser; Cookie settings in the footer opens the banner again; saying no afterwards
  clears the tags' cookies and reloads the page. Google (Consent Mode) and Clarity are told when a
  visitor allows them.
- [x] T8 CSP: BaseLayout adds the script, image, connect and frame origins each vendor's CSP guide
  lists, through `Astro.csp`, so only the public pages get them. No 'unsafe-inline' or
  'unsafe-eval'.
- [x] T9 Admin page `/admin/settings/analytics` (Admins only), with Sign-in and Analytics tabs
  under one Settings heading, and the overview card renamed to Settings.
- [x] T10 e2e `e2e/admin/analytics.spec.ts` against the real API: the Admin saves tags and codes,
  both verification files are served, a visitor's page asks for every tag with no CSP error, the
  admin page asks for none, the banner holds the tags back until Allow and remembers the answer,
  a Decline loads nothing, and with the tags off the visitor gets none. The vendors' scripts are
  answered by the test, so Google and Microsoft are never reached.

## Acceptance criteria

- AC1 With the tags off (the default), no page loads anything from Google or Microsoft.
- AC2 Each ID is taken only in its own shape; a wrong one is refused next to its field.
- AC3 A saved change reaches visitors within a few minutes, with no rebuild.
- AC4 The admin pages and the account panel never load a tag, and their CSP does not allow one.
- AC5 With the banner on, nothing loads before the visitor allows it, and a no is kept.
- AC6 When the API can not be reached, the public pages work as before and log no error.

## Setting it up

- Google Analytics: Admin, Data streams, add a Web stream for the site and copy its `G-` ID.
- Google Ads: Tools, Data manager, Google tag, and copy the `AW-` ID.
- Search Console: add the site as a URL-prefix property, pick **HTML file**, and paste the file
  name it shows (`google….html`). Then press Verify.
- Microsoft Clarity: add a project for the site and copy its project ID from Settings.
- Microsoft Advertising: Tools, UET tag, and copy the tag ID.
- Bing Webmaster Tools: add the site, pick **XML file**, open the `BingSiteAuth.xml` it offers and
  paste the code inside `<user>`. (Bing can also import the site from Search Console.)

Paste them on `/admin/settings/analytics`, tick **Load the tracking tags on the public pages**,
and save. Turn on the consent banner where visitors must agree first (the EU and the UK, for
example).

## Not in this epic

- Tag Manager's Custom HTML tags and Custom JavaScript variables, and its Preview mode, which need
  'unsafe-inline' and 'unsafe-eval' in the CSP. Google's built-in tags in the container work.
- Google Ads pixels on country domains (`www.google.co.uk` and the like), which a CSP can not
  allow with one entry; conversions on `www.google.com` and doubleclick work.
- Tracking on the admin pages and in the account panel.
