---
title: Website traffic statistics
category: Deploy
order: 42
summary: See how a server's websites are used, from the access logs nginx already writes: visitors, visits, page views, pages, referrers, browsers, devices, countries, busy hours and response times, per site or for all of them.
keywords: traffic, statistics, analytics, visitors, unique visitors, visits, page views, bounce rate, referrers, browsers, countries, cities, world map, heatmap, response time, bandwidth, bots, db-ip, cloudflare, geolocation, retention, time zone, deploy
route: /deploy
---

**Traffic** shows how the websites on a server are used: how many people came, what they read, where they came from and when. The server's core reads the access log nginx already writes for each site, a little every few seconds, so there is no script to add to your pages and nothing for your visitors to accept.

## Where to find it

Open **Deploy**, pick the server, then the **Traffic** section (after Websites). The picker at the top shows **All websites** or one site. Each site also has a **Traffic** tab in its settings under **Websites**, with the same report for that site and an **Open in Traffic** button.

## Turn it on

Statistics are off on a new server. An Admin or Owner turns them on, either with **Turn on statistics** or in **Settings**, **Statistics**, **Count traffic**.

- Counting starts at the end of the logs, so the report starts empty and fills within a minute of the next visits.
- Tick **Also count what the logs already hold** the first time to read what nginx has already written (up to 200 MB a site).
- Turning statistics on also turns on [attack detection](deploy-attacks.md), unless someone has already set detection up.
- Turning them off stops every read of the logs at once. The figures so far are kept.

## Reading the report

Pick a range (**Today**, **7 days**, **30 days**, **90 days**, **12 months** or your own days) and how to group it (**Hour**, **Day**, **Week** or **Month**). Hours are offered for up to 14 days within how long hourly figures are kept. **Compare** adds the period of the same length just before, drawn dashed in the chart, and every tile says how it moved. Green means good news: more visitors, or a lower bounce rate.

- **Unique visitors** is an estimate, within about 2%. A visitor is a fingerprint of address and browser; the address itself is never kept in the statistics.
- **Visits** end after 30 minutes without a page view. **Bounce rate** is the share of visits that saw one page.
- **Page views** count pages people opened. Images, scripts, styles and bots are left out.
- **Bandwidth** is everything nginx sent, bots included. **Bot share** is the requests from crawlers and other bots, which are counted apart.
- The breakdowns show the top values: pages, entry pages, referrers (other sites only), browsers, operating systems, devices, countries and cities, status codes and bots. **See all** pages through every value and searches them. Values past the 500 most common of a day are counted together as **Other**.
- **Busiest hours** shades each hour of the week by page views, Monday first, in the report's time zone. The arrow keys read each hour.
- **Responses** shows the average and the slowest 5% of response times, and the requests by status over time.
- The dot at the top shows the visitors on the sites in the last five minutes.

Every chart has a readout on the arrow keys, and the main chart has a **Table** button.

## Countries and cities

A site behind Cloudflare gets its visitors' country from Cloudflare. Everything else is placed with **DB-IP**'s free country database, which the server downloads once a month. The **Where visitors are** card says how many came from each. `Tor` and `Unknown` stand for visitors Cloudflare marked that way.

Cities need Cloudflare's **Add visitor location headers** Managed Transform. **Settings**, **Cloudflare** shows, for each site on a Cloudflare zone this computer knows, whether the country and the city are on, with a **Turn on** button. The change goes to Cloudflare from this computer with the token saved here. Turning on the city headers needs **Zone > Transform Rules > Edit** on the token.

IP geolocation by [DB-IP](https://db-ip.com), CC BY 4.0.

## Settings

Admins and Owners change these in **Settings**, **Statistics**:

- **Countries**: on or off.
- **Sites counted**: leave a site out and its log is not read at all.
- **Keep hourly figures** (7 to 365 days) and **Keep daily figures** (30 to 1825 days).
- **Days start at midnight in**: the time zone of days, weeks (from Monday) and months. It starts as the server's.
- **Delete statistics**: for the site shown or for every site. It asks for your password first and cannot be undone.

A site whose custom snippet turns `access_log off` is named in the settings: that traffic cannot be counted.

## On your phone

The Runova app on your phone shows the same report, read through your computer, so the numbers match. Open a server and tap **Traffic**. It has three tabs:

- **Overview**: the tiles, the chart (touch it for a readout) and the breakdowns, for **Today**, **7 days**, **30 days**, **90 days** or **12 months**, for one site or all of them. **See all** pages through every value. The busiest hours chart stays on the computer.
- **Attacks**: what [attack detection](deploy-attacks.md) found, with **Block** for Admins and Owners.
- **Blocked**: the blocked addresses, with **Unblock**.

The settings sheet changes statistics, countries, how long figures are kept and detection. Turning on automatic blocking and deleting statistics stay on the computer, since both ask for your password there. The report refreshes once a minute.

## When something goes wrong

- **No visits yet**: statistics count from when they were turned on. Visits show up within a minute.
- **This server runs an older core**: update the core from the Overview, then open Traffic again.
- **The country database is not ready yet**: the server could not download DB-IP's file; visitors not behind Cloudflare read Unknown until it can.
