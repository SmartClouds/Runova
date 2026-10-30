import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';
import { FEATURE_GROUP_IDS } from './lib/features';

/** One MDX entry per feature group in the README (docs/epics/40-website.md, Features). */
const features = defineCollection({
  loader: glob({ pattern: '*.mdx', base: './src/content/features' }),
  schema: z.object({
    title: z.string(),
    /** The meta description, 70 to 160 characters. */
    description: z.string().min(70).max(160),
    /** One or two sentences for the card on the features index. */
    summary: z.string(),
    group: z.enum(FEATURE_GROUP_IDS),
    order: z.number().int(),
    /** The screenshot on the index card, a name in src/assets/screenshots/manifest.json. */
    cover: z.string(),
    /** The README feature names this entry explains, exactly as the README spells them (none for Studio). */
    covers: z.array(z.string()),
    /** Help article file names without `.md`, linked as `/help/<name>`. */
    help: z.array(z.string()).min(1),
  }),
});

export const collections = { features };
