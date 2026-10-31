import { useEffect, useRef, useState } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { NativeSelect } from '@/components/ui/native-select';
import { apiRequest, type Problem } from '@/lib/admin/api';
import type { ItemStatus } from '@/lib/admin/publishing';
import type { Category, Severity } from '@/lib/news/api';
import { CATEGORY_LABELS, SEVERITY_LABELS } from '@/lib/news/page';
import { ErrorSummary } from './ErrorSummary';
import { Field } from './Field';

const PAGE_SIZE = 20;

/** What the list shows: the live items (anything not archived), or one status. */
type Filter = 'live' | ItemStatus;

const FILTERS: { value: Filter; label: string }[] = [
  { value: 'live', label: 'Drafts, scheduled and published' },
  { value: 'draft', label: 'Drafts' },
  { value: 'scheduled', label: 'Scheduled' },
  { value: 'published', label: 'Published' },
  { value: 'archived', label: 'Archived' },
];

const STATUS_LABELS: Record<ItemStatus, string> = {
  draft: 'Draft',
  scheduled: 'Scheduled',
  published: 'Published',
  archived: 'Archived',
};

/** The fields of `NewsListItemDto` and `PostListItemDto` the list reads. */
interface ListItem {
  id: number;
  title: string;
  publishedAt: string | null;
  category?: Category;
  severity?: Severity;
  tags: (string | { name: string })[];
}

interface Page {
  items: ListItem[];
  page: number;
  totalPages: number;
}

const KINDS = {
  news: { resource: '/news', adminPath: '/admin/news', title: 'News', newLabel: 'New news item' },
  posts: {
    resource: '/posts',
    adminPath: '/admin/blog',
    title: 'Blog posts',
    newLabel: 'New post',
  },
} as const;

const isFilter = (value: string | null): value is Filter =>
  FILTERS.some((each) => each.value === value);

function readAddress(): { filter: Filter; page: number } {
  const query = new URLSearchParams(window.location.search);
  const status = query.get('status');
  const page = Number(query.get('page'));
  return {
    filter: isFilter(status) ? status : 'live',
    page: Number.isInteger(page) && page > 1 ? page : 1,
  };
}

function writeAddress(filter: Filter, page: number) {
  const query = new URLSearchParams();
  if (filter !== 'live') query.set('status', filter);
  if (page > 1) query.set('page', String(page));
  const search = query.toString();
  window.history.replaceState(null, '', `${window.location.pathname}${search ? `?${search}` : ''}`);
}

/**
 * A list item has no status, so with several statuses listed it comes from the time: none is a
 * draft, a future one is scheduled.
 */
function statusOf(item: ListItem, filter: Filter): ItemStatus {
  if (filter !== 'live') return filter;
  if (!item.publishedAt) return 'draft';
  return new Date(item.publishedAt).getTime() > Date.now() ? 'scheduled' : 'published';
}

// The paging buttons at either end are aria-disabled, not disabled, so focus stays on them.
const EDGE = 'aria-disabled:cursor-not-allowed aria-disabled:opacity-50';

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** The admin list of news items or posts, by status, a page at a time. */
export default function ItemList({ kind }: { kind: keyof typeof KINDS }) {
  const { resource, adminPath, title, newLabel } = KINDS[kind];
  const [{ filter, page }, setQuery] = useState(readAddress);
  const [list, setList] = useState<Page | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    const query = new URLSearchParams();
    const statuses = filter === 'live' ? ['draft', 'scheduled', 'published'] : [filter];
    for (const status of statuses) query.append('status', status);
    query.set('page', String(page));
    query.set('pageSize', String(PAGE_SIZE));
    apiRequest<Page>(`${resource}?${query}`).then((response) => {
      if (!current) return;
      if (response.ok) {
        setList(response.value);
        setProblem(null);
      } else {
        setProblem(response.problem);
      }
    });
    return () => {
      current = false;
    };
  }, [resource, filter, page]);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  const go = (next: { filter: Filter; page: number }) => {
    setQuery(next);
    writeAddress(next.filter, next.page);
  };

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="font-display font-extrabold text-3xl tracking-tight">{title}</h1>
        <a className={buttonVariants()} href={`${adminPath}/new`}>
          {newLabel}
        </a>
      </div>
      <Field id={`${kind}-status`} label="Status" className="max-w-xs">
        {(control) => (
          <NativeSelect
            {...control}
            value={filter}
            onChange={(event) => go({ filter: event.target.value as Filter, page: 1 })}
          >
            {FILTERS.map((each) => (
              <option key={each.value} value={each.value}>
                {each.label}
              </option>
            ))}
          </NativeSelect>
        )}
      </Field>
      <ErrorSummary problem={problem} summaryRef={summary} />
      {!list && !problem && <p className="text-muted-foreground">Loading.</p>}
      {list && list.items.length === 0 && (
        <p className="text-muted-foreground">Nothing here yet.</p>
      )}
      {list && list.items.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[36rem] text-left text-sm">
            <caption className="sr-only">{title}</caption>
            <thead className="border-b text-muted-foreground">
              <tr>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Title
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  Status
                </th>
                <th scope="col" className="py-2 pe-4 font-medium">
                  {kind === 'news' ? 'Category' : 'Tags'}
                </th>
                <th scope="col" className="py-2 font-medium">
                  Publish time
                </th>
              </tr>
            </thead>
            <tbody>
              {list.items.map((item) => (
                <tr key={item.id} className="border-b">
                  <th scope="row" className="py-3 pe-4 font-medium">
                    <a
                      className="underline-offset-4 hover:underline"
                      href={`${adminPath}/${item.id}`}
                    >
                      {item.title}
                    </a>
                  </th>
                  <td className="py-3 pe-4">{STATUS_LABELS[statusOf(item, filter)]}</td>
                  <td className="py-3 pe-4">
                    {item.category && item.severity
                      ? `${CATEGORY_LABELS[item.category]}, ${SEVERITY_LABELS[item.severity]}`
                      : item.tags
                          .map((tag) => (typeof tag === 'string' ? tag : tag.name))
                          .join(', ')}
                  </td>
                  <td className="py-3">
                    {item.publishedAt ? (
                      <time dateTime={item.publishedAt}>
                        {dateTime.format(new Date(item.publishedAt))}
                      </time>
                    ) : (
                      'Not set'
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list && list.totalPages > 1 && (
        <nav aria-label="Pages" className="flex flex-wrap items-center gap-4">
          <Button
            type="button"
            variant="outline"
            className={EDGE}
            aria-disabled={list.page <= 1}
            onClick={() => list.page > 1 && go({ filter, page: list.page - 1 })}
          >
            Previous page
          </Button>
          <span className="text-sm">
            Page {list.page} of {list.totalPages}
          </span>
          <Button
            type="button"
            variant="outline"
            className={EDGE}
            aria-disabled={list.page >= list.totalPages}
            onClick={() => list.page < list.totalPages && go({ filter, page: list.page + 1 })}
          >
            Next page
          </Button>
        </nav>
      )}
    </div>
  );
}
