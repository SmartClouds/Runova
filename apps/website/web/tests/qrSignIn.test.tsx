// @vitest-environment jsdom
import './setup/dom';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { QrSignIn } from '../src/components/account/QrSignIn';
import { fakeFetch, json, problem } from './helpers/fakeAdminFetch';

const CODE = 'rq1.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG';
const created = () =>
  json({ id: 7, qrText: CODE, expiresAt: '2026-11-09T12:00:00Z' }, { status: 201 });
const reading = (status: string, matchCode: string | null = null) =>
  json({ status, matchCode, expiresAt: '2026-11-09T12:00:00Z' });
const noContent = () => new Response(null, { status: 204 });

beforeEach(() => {
  document.cookie = 'XSRF-TOKEN=xsrf; path=/';
});

async function showCode() {
  const user = userEvent.setup();
  render(<QrSignIn pollMs={5} />);
  await user.click(screen.getByRole('button', { name: 'Show QR code' }));
  return user;
}

describe('QrSignIn', () => {
  it('draws the code once asked', async () => {
    fakeFetch({
      'POST /api/v1/qr-sign-ins': created(),
      'GET /api/v1/qr-sign-ins/7': reading('waiting'),
    });

    await showCode();

    const image = await screen.findByRole('img', { name: /QR code/ });
    expect(image.querySelector('path')?.getAttribute('d')).toMatch(/^M\d+ \d+h1v1h-1z/);
  });

  it('shows the digits after a scan and approves that device', async () => {
    let approved = false;
    const api = fakeFetch({
      'POST /api/v1/qr-sign-ins': created(),
      'GET /api/v1/qr-sign-ins/7': () => reading(approved ? 'approved' : 'scanned', '0420'),
      'POST /api/v1/qr-sign-ins/7/decisions': () => {
        approved = true;
        return noContent();
      },
    });

    const user = await showCode();
    expect(await screen.findByText('0420')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(await screen.findByText('That device is signed in.')).toBeTruthy();
    const decision = api.seen.find((r) => r.path === '/api/v1/qr-sign-ins/7/decisions');
    expect(decision?.json()).toEqual({ approve: true });
  });

  it('turns a device down and goes back to the start', async () => {
    const api = fakeFetch({
      'POST /api/v1/qr-sign-ins': created(),
      'GET /api/v1/qr-sign-ins/7': reading('scanned', '0420'),
      'POST /api/v1/qr-sign-ins/7/decisions': noContent(),
    });

    const user = await showCode();
    await user.click(await screen.findByRole('button', { name: 'Not my device' }));

    expect(await screen.findByRole('button', { name: 'Show QR code' })).toBeTruthy();
    const decision = api.seen.find((r) => r.path === '/api/v1/qr-sign-ins/7/decisions');
    expect(decision?.json()).toEqual({ approve: false });
  });

  it('offers a new code when the old one is gone', async () => {
    fakeFetch({
      'POST /api/v1/qr-sign-ins': created(),
      'GET /api/v1/qr-sign-ins/7': problem(404, 'not-found'),
    });

    await showCode();

    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Show a new code' })).toBeTruthy(),
    );
  });
});
