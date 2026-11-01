/**
 * A soft light that follows the pointer inside `[data-spotlight]` cards. The script only sets
 * `--spot-x` and `--spot-y`; global.css draws the light and fades it in on hover. Touch and pen
 * input are ignored, so it only appears for a mouse.
 *
 * Same idea as the hover spotlight cards in beUI (https://github.com/starc007/ui-components,
 * Saurabh Chauhan), written from scratch. No code is copied and nothing is added as a dependency.
 */
export function setUpSpotlight(root: ParentNode = document) {
  for (const card of root.querySelectorAll<HTMLElement>('[data-spotlight]')) {
    card.addEventListener('pointermove', (event) => {
      if (event.pointerType !== 'mouse') return;
      const box = card.getBoundingClientRect();
      card.style.setProperty('--spot-x', `${event.clientX - box.left}px`);
      card.style.setProperty('--spot-y', `${event.clientY - box.top}px`);
    });
  }
}
