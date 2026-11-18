---
title: Account, sync and teams
category: Settings
order: 5
summary: Sign in to a Runova account on each of your computers so your projects, servers, Vault and settings stay the same everywhere, with secrets sealed by a key only you hold, and share chosen items with a team.
keywords: account, sign in, sign out, sync, cloud, devices, sessions, computers, encryption, end to end, passphrase, recovery key, team, share, invite, conflict, google, two-factor
route: /account
---

A Runova account keeps your computers in step. Sign in on your Windows desktop and your Mac laptop, and the projects, SSH and Remote Desktop servers, Vault entries, environments, monitors, API client collections, database connections and settings you make on one appear on the other. Everything works signed out exactly as before; the account is only for keeping computers alike and for working with a team.

## Where to find it

Click **Account** near the bottom of the sidebar, above Help and Settings. When you are signed in, the status bar also shows how sync is doing: **Synced**, **Syncing**, **Offline**, **Key needed** or a number of items **to review**. Click it for the details.

## Sign in

1. Open **Account** and click **Sign in**.
2. Your browser opens runovahq.com. Sign in there with your email and password, or with **Continue with Google**, and give the code from your authenticator app if you turned on two-factor.
3. The page asks **Sign in Runova on** your computer's name. Click **Sign in this computer**.
4. Go back to Runova. It is signed in and starts syncing.

Runova never sees your password: the browser signs you in, and the app gets a key for this computer only. Each computer you sign in on shows up under **Devices**.

## A project's folder stays on each computer

A project you made on one computer arrives on the others without a folder, because the same project usually lives somewhere else on each one. Its card shows **Choose folder**. Pick where the project is on this computer, and that choice stays here: your other computers keep their own folders.

The pairing of a remote device, a private key file's path and caches never sync either.

## Encryption

Passwords, private keys, environment values and tokens leave your computer only sealed with a key that only your computers hold. Until you set one, they stay on the computer they were made on, and the others get the rest of the item (a server's host and user, say) without them.

1. Open **Account**, then **Sync and encryption**.
2. On **Your own data**, click **Set a key**.
3. Choose how to lock it:
   - **Create a phrase for me** (the default): Runova makes 24 random words, like a crypto wallet's recovery phrase. Click **Show the words**, then copy them, **Save to a file**, or switch to **QR code** and scan it with the Runova app on your phone. Click **I saved it, check me** and pick the right word for three places.
   - **Type my own**: a passphrase of at least 12 characters, twice. A few unrelated words work well.
4. Click **Set the key**. Runova shows a **recovery key**, also 24 words, with the same copy, save and QR code. After a typed passphrase you check three of its words; after a phrase, tick that you saved it. Then click **Done**.

The words and the QR code stay hidden until you ask for them, hide again when you switch to another window, and are left out of screenshots and screen sharing. A copied phrase is cleared from the clipboard after the Vault's clipboard time (a minute when that is set to never). A saved file is a plain text file only your user can open: keep it in a password manager or on an encrypted drive, or print it and delete it.

On each other computer, the same card says **Locked on this computer**. Click **Unlock here** and type the passphrase (or the recovery key) once. A phrase goes in 24 word boxes: paste it, type it with suggestions, or click **Open a saved file**. Capitals and spaces do not matter in a phrase. Recovery keys from before phrases (eight groups of seven characters) still work: click **I have an older key in groups of characters**. The server keeps only a wrapped copy of the key and can never read what it seals.

Under **Also seal** you can seal more than the secrets: **Server connections**, **Environments**, or **Everything**.

> [!WARNING]
> Nobody can recover a lost passphrase and recovery key, Runova included. If you lose both, you can reset the key on runovahq.com (Sync, Reset the key). Everything sealed with it is deleted from the cloud, and each computer sends what it still has again once you set a new key.

## Changed on two computers

If you edit the same item on two computers before they sync, Runova does not guess. **Sync and encryption** shows **Changed on two computers**. Click **Review** to see both versions side by side, with the fields that differ highlighted, then choose **Keep this computer's**, **Use the other computer's**, or **Keep both**.

## Teams

A team shares chosen items with the people in it.

1. On the **Teams** tab, type a name and click the plus button. You are the team's Owner.
2. On **Sync and encryption**, set the team's key. Give the passphrase to your team yourself, in person or through a password manager, never by plain email.
3. Back on **Teams**, invite people by email and pick a role: **Admin** (invites and manages Members and Viewers), **Member** (reads and changes what the team shares) or **Viewer** (only reads it).
4. Click **Share something** and pick servers, Vault entries, environments, monitors and more. They move into the team, and every member gets them.

An invited person accepts on the **Teams** tab or on runovahq.com, then types the team key once on each computer. Role changes, removing someone and deleting the team ask for your password, so they open on runovahq.com. After someone leaves, use **Replace the key** so the old one opens nothing new.

## Devices, sessions and activity

**Devices** lists every browser and computer signed in to your account. Sign out one you do not recognise, then change your password. **Activity** shows sign-ins, new computers, failed attempts and every change to your account. The same lists are on runovahq.com, under your account.

## Sign out

Click **Sign out** at the top of the Account page. Syncing stops on this computer, and everything on it stays as it is.
