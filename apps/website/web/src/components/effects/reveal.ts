/**
 * Fades `[data-reveal]` elements up the first time they scroll into view, once per page
 * (design.md, Motion). Elements already on screen when the page opens are left alone, so nothing
 * that is visible ever blinks out. Without JavaScript, or with reduced motion, everything just
 * shows. The look is in global.css under `[data-reveal]`.
 *
 * Same idea as the scroll reveals on React Bits (https://reactbits.dev, David Haz), written from
 * scratch in plain TypeScript. No code is copied and nothing is added as a dependency.
 */
export function setUpReveal(root: ParentNode = document) {
  const elements = [...root.querySelectorAll<HTMLElement>('[data-reveal]')];
  if (elements.length === 0) return;
  if (!('IntersectionObserver' in window)) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const seen = new WeakSet<Element>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        const first = !seen.has(element);
        seen.add(element);
        if (entry.isIntersecting) {
          // On screen at load: keep it as it is. Otherwise it was waiting, so let it rise in.
          if (!first) element.dataset.reveal = 'shown';
          observer.unobserve(element);
        } else if (first) {
          element.dataset.reveal = 'waiting';
        }
      }
    },
    { rootMargin: '0px 0px -10% 0px' },
  );
  for (const element of elements) observer.observe(element);
}
