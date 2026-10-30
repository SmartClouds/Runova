const longDate = new Intl.DateTimeFormat('en-US', { dateStyle: 'long', timeZone: 'UTC' });

/** A date as it reads on a page, such as "October 30, 2026". */
export function formatLongDate(iso: string): string {
  return longDate.format(new Date(iso));
}

/** A time for `<time datetime>`, in the same UTC ISO form whatever the API wrote. */
export function isoTime(iso: string): string {
  return new Date(iso).toISOString();
}
