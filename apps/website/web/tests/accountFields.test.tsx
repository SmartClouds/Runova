// @vitest-environment jsdom
import './setup/dom';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { AppInput, AppRadio, AppSelect, PasswordInput } from '../src/components/account/fields';

// jsdom swaps in its own URL, which node:url refuses, so paths are joined from the test's folder.
const read = (path: string) => readFileSync(join(import.meta.dirname, path), 'utf8');
const accountDir = join(import.meta.dirname, '../src/components/account');

describe('account panel fields', () => {
  it('draws a text field as the app does: a full pill with the field wash', () => {
    render(<AppInput aria-label="Name" />);
    const field = screen.getByLabelText('Name');

    expect(field.className).toContain('app-field');
    expect(field.className).toContain('rounded-full');
    expect(field.className).toContain('h-9');
    expect(field.className).toContain('px-3.5');
  });

  it('hides a password until the eye is pressed, and keeps its label on the field', async () => {
    const user = userEvent.setup();
    render(
      <>
        <label htmlFor="pw">Password</label>
        <PasswordInput id="pw" defaultValue="correct horse" />
      </>,
    );
    const field = screen.getByLabelText('Password');
    expect(field).toHaveAttribute('type', 'password');

    await user.click(screen.getByRole('button', { name: 'Show password' }));

    expect(field).toHaveAttribute('type', 'text');
    await user.click(screen.getByRole('button', { name: 'Hide password' }));
    expect(field).toHaveAttribute('type', 'password');
  });

  it('draws a select as a pill with its own chevron instead of the native arrow', () => {
    const { container } = render(
      <AppSelect aria-label="Role" defaultValue="admin">
        <option value="admin">Admin</option>
      </AppSelect>,
    );
    const select = screen.getByLabelText('Role');

    expect(select.className).toContain('app-field');
    expect(select.className).toContain('rounded-full');
    expect(select.className).toContain('appearance-none');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('draws a radio like the app checkbox, round, with no native look', () => {
    render(<AppRadio aria-label="Member" name="role" />);
    const radio = screen.getByLabelText('Member');

    expect(radio).toHaveAttribute('type', 'radio');
    expect(radio.className).toContain('appearance-none');
    expect(radio.className).toContain('rounded-full');
  });

  it('is the only place the panel makes a form control', () => {
    const files = readdirSync(accountDir).filter(
      (name) => name.endsWith('.tsx') && name !== 'fields.tsx',
    );
    for (const name of files) {
      const source = readFileSync(join(accountDir, name), 'utf8');
      expect(source, name).not.toContain("from '@/components/ui/input'");
      expect(source, name).not.toMatch(/<(input|select|textarea)[\s>]/);
    }
  });
});

describe('.app-field', () => {
  // Every rule of the app's .field-surface, renamed, must be in the site CSS word for word, so the
  // panel's fields hover, focus, go invalid and dim exactly like the app's.
  const rules = (css: string) =>
    [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({
      selectors: (m[1] ?? '')
        .split(',')
        .map((s) => s.trim().replace(/\s+/g, ' '))
        .filter(Boolean),
      body: (m[2] ?? '').replace(/\s+/g, ' ').trim(),
    }));
  const appCss = read('../../../desktop/src/renderer/src/index.css');
  const siteRules = rules(read('../src/styles/global.css'));

  const appRules = rules(appCss)
    .map((rule) => ({
      ...rule,
      selectors: rule.selectors
        .filter((s) => s.includes('.field-surface'))
        .map((s) => s.replaceAll('.field-surface', '.app-field')),
    }))
    .filter((rule) => rule.selectors.length > 0);

  it('finds the app rules to compare with', () => {
    expect(appRules.length).toBeGreaterThanOrEqual(8);
  });

  it.each(appRules.flatMap((rule) => rule.selectors.map((selector) => ({ selector, rule }))))(
    'carries the app rule for $selector',
    ({ selector, rule }) => {
      const site = siteRules.find(
        (candidate) => candidate.selectors.includes(selector) && candidate.body === rule.body,
      );
      expect(site, `${selector} { ${rule.body} }`).toBeDefined();
    },
  );
});
