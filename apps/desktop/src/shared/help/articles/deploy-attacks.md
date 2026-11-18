---
title: Attack detection and blocking
category: Deploy
order: 43
summary: Have a server notice scans, password guessing, floods and injection probes on its websites, alert you in the app and on Telegram, and block an address with one click or by itself.
keywords: attack, security, scan, brute force, password guessing, flood, ddos, sql injection, xss, log4shell, block, unblock, ip address, allowlist, auto-block, nginx, 444, telegram, alerts, deploy
route: /deploy
---

The server's core watches the access logs of its websites for attacks while they happen. It reads the same lines as [traffic statistics](deploy-traffic.md), and works with statistics on or off.

## What it notices

| Attack | When |
| --- | --- |
| Scans | One address asks for files and admin pages such as `/.env`, `/.git` or `/phpmyadmin` (20 in 5 minutes), or for 50 pages that are not there. |
| Password guessing | One address sends 20 logins in 5 minutes to pages such as `/wp-login.php`, `/xmlrpc.php` or `/login`. |
| Floods | One address sends 600 requests a minute, or a site gets ten times its usual traffic. |
| Injection probes | One address sends 5 requests in 10 minutes carrying SQL injection, script injection, path traversal, shell commands or Log4Shell. |

Addresses on the server's own network, loopback, Cloudflare's addresses and your **allowlist** are never counted.

## Alerts

Each kind opens one alert per site, naming the busiest addresses with their country. It goes to the app's notifications, to the phone, and to [Telegram](deploy-telegram-notifications.md) when that is set up. Ten quiet minutes close it. Clicking the notification opens the site's **Traffic** section at its **Security** card.

## The Security card

At the bottom of **Traffic**, the **Security** card shows the attacks of the last 7 days by kind, the recent addresses with their country, what they did, how often and the paths they tried, and the blocked addresses.

## Block an address

1. In **Recent attacks**, press **Block** beside the address. You need to be an Admin or Owner.
2. Read what happens: nginx refuses the address on every site on this server and answers nothing at all.
3. Press **Block**.

Blocking writes one small file and reloads nginx. It does not apply pending site changes, and it works behind Cloudflare too, where a firewall rule would only see Cloudflare. The address shows under **Blocked addresses**; **Unblock** lets it back in within seconds.

The address your app connects from, loopback and networks wider than /8 cannot be blocked, so you never lock yourself out.

## Block attackers automatically

**Settings**, **Auto-block** lets the server block an address the moment it attacks. It is off to begin with, and only an Owner can turn it on, after confirming their password. Choose:

- the kinds of attack that block,
- how long a block lasts, in minutes (0 blocks for good),
- the most addresses blocked at once.

Automatic blocks are marked **Automatic** in the blocked list and end on their own. Addresses on your own network are never blocked automatically.

## Detection settings

Admins and Owners change these in **Settings**, **Detection**:

- **Watch for attacks**: on or off. Off closes the open alerts.
- The thresholds of each kind and their windows.
- **Never flag or block**: one address or range per line, such as `203.0.113.7` or `10.0.0.0/8`.
- **Keep attacks**: how long attack events, with their addresses, are kept (7 to 365 days).
