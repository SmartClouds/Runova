import type { APIContext } from 'astro';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { latestDownloadTarget, parseDesktopArch, parseDesktopOs } from '../src/lib/download/latest';
import { GITHUB_RELEASES_URL, parseRelease, type Release } from '../src/lib/download/release';
import { GET } from '../src/pages/download/[os]/latest';
import {
  deadApiUrl,
  FAKE_RELEASE,
  type FakeReleaseApi,
  startFakeReleaseApi,
} from './helpers/fakeReleaseApi';

const release = parseRelease(FAKE_RELEASE) as Release;
const urlOf = (name: string) =>
  release.assets.find((asset) => asset.name === name)?.downloadUrl ?? `missing ${name}`;

describe('latestDownloadTarget', () => {
  it('sends Windows to the x64 installer and Linux to the AppImage', () => {
    expect(latestDownloadTarget(release, 'windows', null)).toBe(urlOf('Runova-Setup-2.2.0.exe'));
    expect(latestDownloadTarget(release, 'linux', null)).toBe(urlOf('Runova-2.2.0.AppImage'));
  });

  it('sends a Mac of known arch to its own disk image', () => {
    expect(latestDownloadTarget(release, 'macos', 'arm64')).toBe(urlOf('Runova-2.2.0-arm64.dmg'));
    expect(latestDownloadTarget(release, 'macos', 'x64')).toBe(urlOf('Runova-2.2.0.dmg'));
  });

  it('sends a Mac of unknown arch to /download, which offers both disk images', () => {
    expect(latestDownloadTarget(release, 'macos', null)).toBe('/download');
  });

  it('sends a system without a build to the full list', () => {
    expect(latestDownloadTarget(release, 'linux', 'arm64')).toBe('/download#all-downloads');
  });

  it('sends everyone to GitHub Releases when the API has no release', () => {
    expect(latestDownloadTarget(null, 'windows', null)).toBe(GITHUB_RELEASES_URL);
  });
});

describe('parseDesktopOs and parseDesktopArch', () => {
  it('accept only the known names', () => {
    expect(parseDesktopOs('macos')).toBe('macos');
    expect(parseDesktopOs('android')).toBeNull();
    expect(parseDesktopOs(undefined)).toBeNull();
    expect(parseDesktopArch('arm64')).toBe('arm64');
    expect(parseDesktopArch('universal')).toBeNull();
    expect(parseDesktopArch(null)).toBeNull();
  });
});

describe('GET /download/<os>/latest', () => {
  let api: FakeReleaseApi;

  beforeAll(async () => {
    api = await startFakeReleaseApi();
  });

  afterAll(async () => {
    await api?.close();
  });

  async function get(os: string, query = '', apiUrl = api.url): Promise<Response> {
    process.env.WEBSITE_API_INTERNAL_URL = apiUrl;
    const url = new URL(`https://runovahq.com/download/${os}/latest${query}`);
    return GET({ params: { os }, url, request: new Request(url) } as unknown as APIContext);
  }

  it('redirects to the installer, briefly cached', async () => {
    const response = await get('windows');
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(urlOf('Runova-Setup-2.2.0.exe'));
    expect(response.headers.get('cache-control')).toBe('public, max-age=60');
  });

  it('passes the arch on', async () => {
    const response = await get('macos', '?arch=arm64');
    expect(response.headers.get('location')).toBe(urlOf('Runova-2.2.0-arm64.dmg'));
  });

  it('answers 404 for a system it does not know', async () => {
    const response = await get('android');
    expect(response.status).toBe(404);
  });

  it('falls back to GitHub Releases when the API is down', async () => {
    const response = await get('linux', '', await deadApiUrl());
    expect(response.status).toBe(302);
    expect(response.headers.get('location')).toBe(GITHUB_RELEASES_URL);
  });
});
