---
title: App Store
category: Deploy
order: 50
summary: Install well-known apps such as databases, WordPress, n8n or Grafana on a server you deploy to with one screen, then connect to them, update them and roll them back.
keywords: app store, install app, catalog, wordpress, postgres, mysql, redis, mongodb, n8n, grafana, gitea, nextcloud, ollama, update, latest version, release, rollback, passwords, connection string, one click, self hosted, resource limits, cpu limit, memory limit, ram limit, disk limit
route: /deploy
---

The **App Store** section of a server in Deploy installs ready-made apps on that server. You pick an app from a catalog, choose a release (the newest one by default), review the generated passwords, optionally put it on a domain with a free certificate, set how much CPU, memory and disk each of its containers may use, and click **Install**. Behind the scenes each app is a Docker Compose app, so it also appears under **Apps** and can be rolled back like any other.

Every catalog image is an official Docker image or comes from a verified publisher. Runova reads each image's registry to find its newest releases, keeps only the ones built for both Intel/AMD and ARM servers, and pins the one you install by tag and by digest, so the server runs exactly the image that was checked. When the registries cannot be reached, the store falls back to the versions it shipped with. The server needs Docker, see [Containers, apps and stacks](deploy-containers-stacks.md).

## Where to find it

Click **Deploy** in the sidebar, pick a server in the server rail, then click **App Store** in the strip of sections above the content. You need to be signed in to that server's core first (see [Servers and setup](deploy-servers-setup.md)); otherwise the section shows a card with a **Sign in** button, so you can sign in without leaving it.

Installing needs the **Operator** role. Putting an app on a domain and revealing its passwords later need the **Admin** role.

## What the section shows

The page has two parts.

- **Installed** lists the apps this server got from the App Store. Each row shows the app's name, its version (and the domain, if any), a status word (Not deployed, Working, Running, Degraded, Stopped, Taken down or Failed) and **Update available** when a newer release of its version exists. Click a row to open that app. The list only appears once you installed something.
- **Catalog** lists everything you can install, grouped by category: Databases, Websites, AI, Automation, Monitoring, Developer tools, Search, Messaging and Storage. Type in **Find an app** to filter by name or description. Each card shows the name, the newest release (with a **Latest** mark when it is newer than the one the app shipped with, or **Bundled** when the registries could not be reached), a short description, a badge (**Official image** or **Verified publisher**), how much memory the app needs, and an **Install** button. If your role is below Operator the button is disabled with a hint.

### What is in the catalog

| App | Category | What it is | Memory it needs |
| --- | --- | --- | --- |
| MySQL | Databases | Relational database, versions 9.7 LTS and 8.4 LTS | about 512 MB |
| MariaDB | Databases | MySQL fork, versions 12.3 LTS and 11.4 LTS | about 512 MB |
| PostgreSQL | Databases | SQL database, versions 18 and 17 | about 256 MB |
| Redis | Databases | In-memory store for caches, queues and sessions | about 128 MB |
| MongoDB | Databases | Document database, versions 9.0 and 8.0 | about 1 GB |
| Adminer | Databases | One-page database manager | about 64 MB |
| phpMyAdmin | Databases | Web interface for MySQL and MariaDB | about 128 MB |
| WordPress | Websites | Blog and site builder, with its own MySQL | about 1 GB |
| Ghost | Websites | Publishing platform, with its own MySQL | about 1 GB |
| Ollama | AI | Runs open language models, with Open WebUI as a chat front end | about 8 GB |
| n8n | Automation | Workflow automation with a visual editor | about 1 GB |
| Uptime Kuma | Monitoring | Watches your sites and tells you when one goes down | about 256 MB |
| Grafana | Monitoring | Dashboards and alerts | about 256 MB |
| Prometheus | Monitoring | Metrics collection and storage | about 512 MB |
| Gitea | Developer tools | Lightweight self-hosted Git | about 512 MB |
| Meilisearch | Search | Fast, typo-tolerant search engine | about 512 MB |
| RabbitMQ | Messaging | Message broker with its management UI | about 512 MB |
| Apache Kafka | Messaging | Event streaming on a single node, with a password on every connection | about 1.5 GB |
| Nextcloud | Storage | File sync and sharing, with MariaDB | about 2 GB |

## Install an app

1. In **Catalog**, find the app and click **Install**. The install sheet opens (it is also reachable by link, so the address of the page holds the app you picked).
2. At the top, check the **Images** badges. Each one says who publishes the image ("Docker Official Image" or "Verified publisher: name") and shows the image with the start of its pinned digest. Hover it to see the full reference, when it was checked and for which platforms.
3. Set the **App name**. It becomes the compose project name on the server, so use lowercase letters, digits, dashes and underscores. The app suggests the catalog name and adds a number if that name is taken.
4. Pick a **Release**. It starts on **Latest**, which installs the newest release the registries list, and the list under it offers recent releases if you need an older one. You never type a version number. Apps with more than one release line (PostgreSQL 18 and 17, for example) also have a **Version** list for the line, and the best one is marked "(recommended)". While the newest releases are being checked the sheet says so.
5. Fill in the app's own settings, which differ per app. Typical ones are the **Port** the app uses on the server, a **Database** name, a **User**, an **Admin user** or a **Default server**. Ollama has toggles for **Open WebUI** (a chat interface with accounts of its own) and **Use NVIDIA GPUs** (the server needs the NVIDIA Container Toolkit). Each field has a hint under it, and problems show in red.
6. Look at the **Passwords** block. The app generates strong passwords and keys on your computer for this install only. For each one you can copy it, click the refresh button to make a new one, or type your own (it must pass the same rules). This is the one time they are shown in full, so copy what you need now. An Admin can reveal them later from the app's card.
7. Decide about **Put it on a domain** (see the next section). It is off by default, and the app then listens on `127.0.0.1` of the server only.
8. Read the notes at the bottom. They say how much memory the app needs and that every port stays on `127.0.0.1`. Some apps add a warning that the first person to open the app creates its admin account, so you should open it right after the install. That applies to WordPress, Ghost, Gitea, n8n, Uptime Kuma and Ollama's Open WebUI.
9. Click **Install (app name)**. The **Set resource limits** window opens, see the next section.
10. Click **Install** there. Nothing is sent to the server until you do. If something is wrong, the sheet shows what to fix.

Click **Cancel** to close the sheet without installing.

### Set resource limits

The **Set resource limits** window has one card per container of the app (Ollama has `ollama` and, with Open WebUI on, `open-webui`). Everything starts at **Unlimited**, so clicking **Install** right away installs the app without limits. Turn off **Unlimited** for what you want to cap:

- **CPU**: pick how many **cores** the container may use (up to the number the server has) and its **max usage** of those cores, from 5% to 100%. The line under them says what that adds up to, for example "Up to 1 core of CPU time" for 2 cores at 50%.
- **Memory**: click a size (512 MB, 1 GB, 2 GB, 4 GB, 8 GB) or set any amount with the slider or the box, up to the server's memory. The container cannot go past it, swap included. The card warns you when the amount is below what the app needs to run well.
- **Disk**: the most the container's own files may take, in GB. Docker can only cap this when the server stores containers on overlay2 over xfs (with pquota), btrfs or zfs. On other servers the switch stays on Unlimited and says why.

**Use these limits for every service** copies a card's limits to the other containers. Click **Back** to return to the sheet. You can change the limits later from the app's page, see [Resource limits](deploy-containers-stacks.md#resource-limits).

If the server's core is too old to apply limits, the window says so and the app installs without them. Update the core from the server's overview first if you want limits.

### Put it on a domain

Turn on **Put it on a domain** to add a site in Websites that forwards your domain to the app. This switch is only available when the app has a web interface and you are an Admin. If it is disabled, the hint tells you why: either the app has no web interface to put on a domain (the hint may add a note, for example that only a management UI can go on a domain), or you are not an Admin and the app stays on `127.0.0.1` until an Admin adds it in Websites.

1. Type the **Domain**, for example `app.example.com`. Point its DNS at the server first, so the certificate can be issued. Cloudflare users can do that from [Cloudflare](cloudflare.md).
2. Leave the checkbox on to get a free certificate from Let's Encrypt for HTTPS. Ticking it accepts Let's Encrypt's terms of service.

After the install starts, the app view shows three **Domain steps**: **Add the site in Websites**, **Apply nginx** and **Ask for a certificate**. Each step shows working, done, failed or skipped, with a detail line when something fails. The certificate step says that Let's Encrypt is checking the domain, and the site's **SSL** tab in Websites shows when the certificate arrives. If you did not ask for a certificate, the step is skipped and you can add one later from the site's **SSL** tab. The site starts without the redirect from HTTP to HTTPS, so turn that on in Websites once the certificate is there. See [Websites and certificates](deploy-websites-certificates.md).

> [!NOTE]
> Some apps carry a warning in their sheet. For example, Ollama's API has no login and should never go on a domain without something in front of it, and Open WebUI's first account becomes its admin, so create yours before exposing it.

## After the install

When you click Install, the section switches to the app's own view, which has an **App Store** back button, the app name, **Logs**, **Console** and **Open in Apps** (jumps to the same app under **Apps**, where you find its services, revisions and files). **Logs** follows every service of the app live, and **Console** (Admins only) opens a shell or runs a command, such as `redis-cli` or `psql`, in one of its running containers. Both wait until something runs. See [Logs and consoles of an app](deploy-containers-stacks.md#logs-and-consoles-of-an-app).

- **The deploy timeline** appears first while the install runs: Validate, Pull images, Build, Start containers and Health check, each with its log. See [Containers, apps and stacks](deploy-containers-stacks.md#deploy-timeline).
- If the server refuses the files, the view shows why nothing was deployed.
- The **Connect to (app name)** card lists connection details such as URLs, hosts, ports and connection strings, with a copy button on each row. Anything sensitive (passwords, keys, connection strings that contain one) is masked until someone asks to see it.

### Show or reveal passwords

Right after the install, your computer still holds the passwords, so the card has **Show passwords** and **Hide passwords** buttons and the copy buttons work. Later, when you open the app again, the passwords are not held any more. An Admin can click **Reveal passwords**, confirm their account password again, and the server returns them. Other roles see "Only an Admin can reveal the passwords." Copy buttons for sensitive rows are disabled until the passwords are revealed.

### Update an app

The card has an **Updates** section. Updates are never applied on their own.

- If a newer release of your version came out, you see "(release) is available: ..." with the tags that change (for example "0.35.0 to 0.38.2") and an **Update to (release)** button. The update moves to the newest release the registries list.
- If the images behind your release were rebuilt under the same tags, you see "Newer images for (release): ..." with the tags and the short digests, and an **Update** button.
- If a newer release line exists (for example PostgreSQL 18 when you run 17), you see "(version) is available" and a **Move to (version)** button. A new release line can change how data is stored on disk, so back up first.
- When nothing is newer, the card says "Up to date: (release) is the newest release the App Store knows of."

Some apps also have their own update notice inside them. Open WebUI, for example, shows one when a newer Open WebUI exists. Install the newest release (or use **Update** here) rather than updating from inside the app, so Runova keeps track of what runs.

Click **Update**, **Update to** or **Move to**, read the confirmation (the app is deployed again as a new revision with the newer images and the same settings, passwords and resource limits, and you can roll back if it does not come up healthy) and confirm. Updating needs the Operator role. The buttons are disabled while a job is running on the app.

### Roll back

After an update (or any later deploy), **Roll back to revision N** appears on the card. It copies that older revision's files into a new revision and deploys it, after a confirmation. Data in the app's volumes stays as it is, so a rollback cannot undo changes a newer release already made to your data. That is why you should back up before moving to a new release line.

## Tips

- Check the "Needs about N of memory" line on the card against your server's memory (the [Deploy overview](deploy.md) shows the server's figures) before installing big apps such as Ollama or Nextcloud.
- Cap the memory of apps that can grow, such as Ollama with large models, so one app cannot starve the others. Leave enough for the app itself: the limits window warns you when you go below what it needs.
- Open a freshly installed app right away if it says the first visitor creates the admin account.
- Copy the passwords at install time. An Admin can reveal them later, but only after confirming their password.
- Put the app on a domain in the sheet only after its DNS points at the server, so the certificate succeeds.
- To keep a database off the internet, do not turn on **Put it on a domain**. The port stays on `127.0.0.1`. See [Firewall and security](deploy-firewall-security.md) for what else is reachable.

## Related

- [Deploy overview](deploy.md)
- [Containers, apps and stacks](deploy-containers-stacks.md)
- [Websites and certificates](deploy-websites-certificates.md)
- [Registries](deploy-registries.md)
- [Firewall and security](deploy-firewall-security.md)
- [Cloudflare](cloudflare.md)
