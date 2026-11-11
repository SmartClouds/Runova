/// <reference types="vitest/config" />
import { getViteConfig } from 'astro/config';

// getViteConfig loads astro.config.mjs, so .astro files and the Astro container work in tests.
export default getViteConfig({
  test: {
    include: ['tests/**/*.test.{ts,tsx}'],
    environment: 'node',
    // The admin forms are tested by typing into them a key at a time, and every key re-renders
    // the form. That is well under a second here, but on the busy Linux runner three of them
    // went past the 5 s default in one run.
    testTimeout: 20_000,
  },
});
