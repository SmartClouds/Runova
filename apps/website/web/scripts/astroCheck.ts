// `astro check` on TypeScript 6. The site's TypeScript is 7, but Astro refuses to run the check
// on it, and @astrojs/check and Volar need the compiler API, which TypeScript 7 does not
// ship. So this script sends every `typescript` import in the process to TypeScript 6 from
// @typescript/typescript6, then does what `astro check` does: syncs the generated types and runs
// @astrojs/check. Go back to `astro check` once @astrojs/check works with TypeScript 7.
//
// Run it with Node (`node scripts/astroCheck.ts`): the hook below is Node's module API.
import { createRequire, registerHooks } from 'node:module';
import { pathToFileURL } from 'node:url';

const typescript6 = pathToFileURL(
  createRequire(import.meta.url).resolve('@typescript/typescript6'),
).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === 'typescript')
      return { url: typescript6, format: 'commonjs', shortCircuit: true };
    return nextResolve(specifier, context);
  },
});

process.env.NODE_ENV ??= 'production';

const { sync } = await import('astro');
const { check, parseArgsAsCheckConfig } = await import('@astrojs/check');

const config = parseArgsAsCheckConfig(process.argv);
await sync({ root: config.root });
const failed = await check(config);
if (!config.watch) process.exit(failed ? 1 : 0);
