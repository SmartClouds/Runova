import { describe, expect, it } from 'vitest';
import { ADMIN_SPECS, CAPTCHA_SPECS, CHROMIUM_IGNORE } from '../e2e/specFolders';

const ignoredByChromium = (file: string) => CHROMIUM_IGNORE.some((pattern) => pattern.test(file));

// Where a checkout can be. The first is the CI Linux VM, whose user is called admin; it broke every
// e2e run when the folders were relative globs, because 'admin/**' matched /home/admin.
const ROOTS = [
  '/home/admin/Runova/apps/website/web',
  '/home/runner/work/Runova/Runova/apps/website/web',
  'C:\\Users\\admin\\Runova\\apps\\website\\web',
  'E:\\Runova\\apps\\website\\web',
  '/srv/stack/captcha/apps/website/web',
];

describe.each(ROOTS)('spec folders under %s', (root) => {
  const sep = root.includes('\\') ? '\\' : '/';
  const spec = (...parts: string[]) => [root, 'e2e', ...parts].join(sep);

  it('keeps a site spec in chromium only', () => {
    for (const file of [spec('blog.spec.ts'), spec('download.spec.ts'), spec('news.spec.ts')]) {
      expect(ignoredByChromium(file), file).toBe(false);
      expect(ADMIN_SPECS.test(file), file).toBe(false);
      expect(CAPTCHA_SPECS.test(file), file).toBe(false);
    }
  });

  it('keeps an admin spec in the admin project only', () => {
    const file = spec('admin', 'signIn.spec.ts');
    expect(ignoredByChromium(file)).toBe(true);
    expect(ADMIN_SPECS.test(file)).toBe(true);
    expect(CAPTCHA_SPECS.test(file)).toBe(false);
  });

  it('keeps a captcha spec in the captcha project only', () => {
    const file = spec('captcha', 'signInCaptcha.spec.ts');
    expect(ignoredByChromium(file)).toBe(true);
    expect(ADMIN_SPECS.test(file)).toBe(false);
    expect(CAPTCHA_SPECS.test(file)).toBe(true);
  });

  it('leaves a stack spec to the stack config', () => {
    const file = spec('stack', 'fullStack.spec.ts');
    expect(ignoredByChromium(file)).toBe(true);
    expect(ADMIN_SPECS.test(file)).toBe(false);
    expect(CAPTCHA_SPECS.test(file)).toBe(false);
  });

  it('does not take the admin helpers for specs', () => {
    expect(ADMIN_SPECS.test(spec('admin', 'stack.ts'))).toBe(false);
    expect(ADMIN_SPECS.test(spec('admin', 'fixtures', 'user.ts'))).toBe(false);
  });

  it('finds an admin spec in a nested folder', () => {
    expect(ADMIN_SPECS.test(spec('admin', 'plans', 'checkout.spec.ts'))).toBe(true);
  });
});
