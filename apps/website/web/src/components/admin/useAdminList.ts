import { useEffect, useRef, useState } from 'react';
import { apiRequest, type Problem } from '@/lib/admin/api';

export const PAGE_SIZE = 20;

export interface ListPage<T> {
  items: T[];
  page: number;
  totalPages: number;
}

/** One page of an admin list from the API, loaded again whenever the path changes. */
export function useAdminList<T>(path: string) {
  const [list, setList] = useState<ListPage<T> | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const summary = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let current = true;
    apiRequest<ListPage<T>>(path).then((response) => {
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
  }, [path]);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  return { list, problem, summary };
}

const dateTime = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });

/** A date and time in the reader's own format, or the given word when there is none. */
export const formatTime = (time: string | null, none = 'Never') =>
  time ? dateTime.format(new Date(time)) : none;
