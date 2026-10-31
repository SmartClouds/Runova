import type userEvent from '@testing-library/user-event';

/**
 * Puts the whole text in a field as one paste. Typing it a key at a time re-renders the editor
 * on every character, which under a full parallel run is slow enough to pass the test timeout.
 * Keep `user.type` for tests about what happens as you type.
 */
export async function enter(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  text: string,
) {
  await user.click(field);
  await user.paste(text);
}
