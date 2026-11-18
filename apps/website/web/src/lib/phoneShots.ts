import type { ImageMetadata } from 'astro';
import manifest from '../assets/phone/manifest.json';

/**
 * One screen of the phone app, copied from the Android app's Roborazzi snapshots
 * (apps/mobile/android/app/src/test/snapshots, `source` in the manifest).
 */
export interface PhoneShot {
  name: string;
  image: ImageMetadata;
  alt: string;
}

const images = import.meta.glob<{ default: ImageMetadata }>('../assets/phone/*.png', {
  eager: true,
});

export function phoneShot(name: string): PhoneShot {
  const entry = manifest.find((shot) => shot.name === name);
  const image = images[`../assets/phone/${name}.png`]?.default;
  if (!entry || !image) throw new Error(`No phone screen named ${name} in the manifest`);
  return { name, image, alt: entry.alt };
}
