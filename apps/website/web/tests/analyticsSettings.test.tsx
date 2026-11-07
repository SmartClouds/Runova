// @vitest-environment jsdom
import './setup/dom';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import AnalyticsSettingsEditor from '../src/components/admin/AnalyticsSettingsEditor';
import {
  type AnalyticsSettings,
  analyticsPatchBody,
  fromAnalyticsSettings,
} from '../src/lib/admin/analyticsSettings';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const SETTINGS = '/api/v1/analytics-settings';

const BASE: AnalyticsSettings = {
  tagsEnabled: false,
  googleAnalyticsIds: [],
  googleAdsIds: [],
  googleTagManagerId: null,
  clarityProjectId: null,
  bingUetTagId: null,
  googleSiteVerification: null,
  bingSiteVerification: null,
  consentBannerEnabled: false,
  updatedAt: null,
  version: '3',
};

const answer = (settings: Partial<AnalyticsSettings> = {}) => {
  const value = { ...BASE, ...settings };
  return json(value, { headers: { etag: `"${value.version}"` } });
};

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
  window.history.replaceState(null, '', '/admin/settings/analytics');
});

describe('the analytics form', () => {
  it('shows lists as one line and sends them back as lists, with empty fields as null', () => {
    const form = fromAnalyticsSettings({
      ...BASE,
      googleAnalyticsIds: ['G-ABC123XYZ9', 'G-SECOND1234'],
      clarityProjectId: 'abcd1234ef',
    });
    expect(form.googleAnalyticsIds).toBe('G-ABC123XYZ9, G-SECOND1234');
    expect(form.bingUetTagId).toBe('');

    expect(
      analyticsPatchBody({ ...form, googleAnalyticsIds: ' g-one12345,G-TWO12345  g-three1234,' }),
    ).toEqual({
      tagsEnabled: false,
      googleAnalyticsIds: ['g-one12345', 'G-TWO12345', 'g-three1234'],
      googleAdsIds: [],
      googleTagManagerId: null,
      clarityProjectId: 'abcd1234ef',
      bingUetTagId: null,
      googleSiteVerification: null,
      bingSiteVerification: null,
      consentBannerEnabled: false,
    });
  });
});

describe('AnalyticsSettingsEditor', () => {
  it('says the tags are off until one is saved and switched on', async () => {
    fakeFetch({ [`GET ${SETTINGS}`]: answer() });
    render(<AnalyticsSettingsEditor />);

    expect(await screen.findByLabelText('Google Analytics measurement IDs')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: /Load the tracking tags/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Ask each visitor first/ })).not.toBeChecked();
    expect(screen.getByText(/The tags are off/)).toBeInTheDocument();
    for (const label of [
      'Google Ads tag IDs',
      'Google Tag Manager container ID',
      'Search Console verification file',
      'Microsoft Clarity project ID',
      'Microsoft Advertising (Bing) UET tag ID',
      'Bing Webmaster verification code',
    ]) {
      expect(screen.getByLabelText(label)).toBeInTheDocument();
    }
  });

  it('says when the tags wait for each visitor to allow them', async () => {
    fakeFetch({
      [`GET ${SETTINGS}`]: answer({
        tagsEnabled: true,
        clarityProjectId: 'abcd1234ef',
        consentBannerEnabled: true,
      }),
    });
    render(<AnalyticsSettingsEditor />);

    expect(await screen.findByLabelText('Microsoft Clarity project ID')).toHaveValue('abcd1234ef');
    expect(screen.getByText(/for visitors who allow them/)).toBeInTheDocument();
  });

  it('saves the tags, the switches and the verifications with the version it read', async () => {
    const api = fakeFetch({
      [`GET ${SETTINGS}`]: answer(),
      [`PATCH ${SETTINGS}`]: answer({
        tagsEnabled: true,
        googleAnalyticsIds: ['G-ABC123XYZ9'],
        bingSiteVerification: '0123456789ABCDEF',
        consentBannerEnabled: true,
        version: '4',
      }),
    });
    const user = userEvent.setup();
    render(<AnalyticsSettingsEditor />);

    await user.type(
      await screen.findByLabelText('Google Analytics measurement IDs'),
      'g-abc123xyz9',
    );
    await user.type(screen.getByLabelText('Bing Webmaster verification code'), '0123456789ABCDEF');
    await user.click(screen.getByRole('checkbox', { name: /Load the tracking tags/ }));
    await user.click(screen.getByRole('checkbox', { name: /Ask each visitor first/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByText(/^Saved\./)).toBeInTheDocument();
    const [patch] = api.calls(`PATCH ${SETTINGS}`);
    expect(patch?.headers.get('if-match')).toBe('"3"');
    expect(patch?.json()).toMatchObject({
      tagsEnabled: true,
      googleAnalyticsIds: ['g-abc123xyz9'],
      bingSiteVerification: '0123456789ABCDEF',
      consentBannerEnabled: true,
    });
    // The API's answer is what shows, tidied.
    expect(screen.getByLabelText('Google Analytics measurement IDs')).toHaveValue('G-ABC123XYZ9');
    expect(screen.getByText(/for visitors who allow them/)).toBeInTheDocument();
  });

  it('puts what the API refused next to the field', async () => {
    fakeFetch({
      [`GET ${SETTINGS}`]: answer(),
      [`PATCH ${SETTINGS}`]: problem(400, 'validation-failed', {
        errors: { googleTagManagerId: ['Give a Tag Manager container ID, such as GTM-ABC1234.'] },
      }),
    });
    const user = userEvent.setup();
    render(<AnalyticsSettingsEditor />);

    await user.type(await screen.findByLabelText('Google Tag Manager container ID'), 'G-1234');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findAllByText(/Give a Tag Manager container ID/)).not.toHaveLength(0);
    expect(screen.getByLabelText('Google Tag Manager container ID')).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });
});
