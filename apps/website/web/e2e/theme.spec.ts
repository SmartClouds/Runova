import { expect, type Page, test } from '@playwright/test';

test.describe('theme', () => {
  for (const colorScheme of ['dark', 'light'] as const) {
    test(`is Dark when the system prefers ${colorScheme}`, async ({ page }) => {
      await page.emulateMedia({ colorScheme });
      await page.goto('/');
      await expect(page.locator('html')).toHaveClass(/\bdark\b/);
      expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(
        'rgb(21, 22, 25)',
      );
      await expect(page.getByRole('button', { name: /theme/i })).toHaveCount(0);
    });
  }
});

/** Every element and pseudo-element whose computed style still animates or transitions. */
function moving(page: Page) {
  return page.evaluate(() => {
    const seconds = (value: string) =>
      Math.max(...value.split(',').map((part) => Number.parseFloat(part) || 0));
    const found: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        const animates = style.animationName !== 'none' && seconds(style.animationDuration) > 0;
        const transitions =
          style.transitionProperty !== 'none' && seconds(style.transitionDuration) > 0;
        if (animates || transitions) found.push(`${element.tagName}${pseudo ?? ''}`);
      }
    }
    return found;
  });
}

test.describe('reduced motion', () => {
  test('nothing animates or transitions when the visitor asks for less motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    expect(await moving(page)).toEqual([]);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe('auto');
  });

  test('the same page does have transitions without the preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    expect((await moving(page)).length).toBeGreaterThan(0);
  });
});
