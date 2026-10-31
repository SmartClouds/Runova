/** The id in an editor's path, such as `42` in `/admin/news/42`, or null when it is not one. */
export function itemId(param: string | undefined): number | null {
  if (!param || !/^[1-9]\d{0,15}$/.test(param)) return null;
  const id = Number(param);
  return Number.isSafeInteger(id) ? id : null;
}
