import DOMPurify from 'dompurify';
import { Marked } from 'marked';

// GitHub-flavored, like Markdig with the pipelines the API uses for the published page.
const marked = new Marked({ gfm: true, async: false });

/**
 * The editor's live preview of a Markdown body. The API renders and sanitizes the real page; this
 * only shows the editor what they wrote, cleaned so nothing in it runs. It renders nothing on the
 * server, where there is no DOM to clean with.
 */
export function renderPreview(markdown: string): string {
  if (typeof window === 'undefined') return '';
  return DOMPurify.sanitize(marked.parse(markdown) as string, { USE_PROFILES: { html: true } });
}
