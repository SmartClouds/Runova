import type { ImageMetadata } from 'astro';
import manifest from '../assets/screenshots/manifest.json';

/** One app screenshot from T012/T013: the image for astro:assets and its alt text. */
export interface Screenshot {
  name: string;
  image: ImageMetadata;
  alt: string;
}

const images = import.meta.glob<{ default: ImageMetadata }>('../assets/screenshots/*.png', {
  eager: true,
});

export function screenshot(name: string): Screenshot {
  const entry = manifest.find((shot) => shot.name === name);
  const image = images[`../assets/screenshots/${name}.png`]?.default;
  if (!entry || !image) throw new Error(`No screenshot named ${name} in the manifest`);
  return { name, image, alt: entry.alt };
}
