/** How an editor publishes a news item or a post, and the status and time the API gets for it. */

export type ItemStatus = 'draft' | 'scheduled' | 'published' | 'archived';
export type PublishMode = 'draft' | 'published' | 'scheduled';

export interface Publishing {
  mode: PublishMode;
  /** The `datetime-local` value of a scheduled time, in the editor's own time zone. */
  scheduledAt: string;
  /** When a published item went live, kept so a save does not move it. */
  publishedAt: string | null;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** An RFC 3339 time as a `datetime-local` value in the browser's time zone. */
export function toLocalInput(time: string | null): string {
  if (!time) return '';
  const date = new Date(time);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function publishingFrom(status: ItemStatus, publishedAt: string | null): Publishing {
  if (status === 'published') return { mode: 'published', scheduledAt: '', publishedAt };
  if (status === 'scheduled') {
    return { mode: 'scheduled', scheduledAt: toLocalInput(publishedAt), publishedAt: null };
  }
  return { mode: 'draft', scheduledAt: '', publishedAt: null };
}

export const NEW_PUBLISHING: Publishing = { mode: 'draft', scheduledAt: '', publishedAt: null };

/**
 * The `status` and `publishedAt` of a write. Publishing now sends no time (the API takes the
 * current one) unless the item was already live; scheduling sends the picked local time in UTC.
 */
export function publishingFields(publishing: Publishing): {
  status: PublishMode;
  publishedAt: string | null;
} {
  switch (publishing.mode) {
    case 'draft':
      return { status: 'draft', publishedAt: null };
    case 'published':
      return { status: 'published', publishedAt: publishing.publishedAt };
    case 'scheduled': {
      const date = new Date(publishing.scheduledAt);
      return {
        status: 'scheduled',
        publishedAt: Number.isNaN(date.getTime()) ? null : date.toISOString(),
      };
    }
  }
}

/** A slug from a title: lowercase a-z, 0-9 and single hyphens, at most 120 characters. */
export function slugify(title: string): string {
  return title
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120)
    .replace(/-+$/, '');
}

/** Comma, space or line separated entries, with the empty ones dropped. */
export function splitList(value: string, separators = /[\s,]+/): string[] {
  return value
    .split(separators)
    .map((each) => each.trim())
    .filter((each) => each !== '');
}
