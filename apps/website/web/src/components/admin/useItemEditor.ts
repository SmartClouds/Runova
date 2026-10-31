import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, type Problem } from '@/lib/admin/api';
import type { FieldErrors } from '@/lib/admin/problems';

/** What the news and post editors share: loading, saving with If-Match, and the 412 conflict. */
export interface ItemEditorOptions<Item extends { id: number }, Form> {
  /** The API collection, such as `/news`. */
  resource: string;
  /** The admin list the editor belongs to, such as `/admin/news`. */
  adminPath: string;
  /** The item to edit, or none for a new one. */
  id?: number;
  empty: Form;
  fromItem: (item: Item) => Form;
  /** The body of a save; an existing item goes by `update`, a new one by POST. */
  writeBody: (form: Form) => unknown;
  update: 'PUT' | 'PATCH';
}

export type EditorPhase = 'loading' | 'ready' | 'failed';

/** The 412 problem's `currentVersion` comes bare (`14`), and If-Match needs the ETag (`"14"`). */
const asEtag = (version: string) => (/^(?:W\/)?"/.test(version) ? version : `"${version}"`);

export function useItemEditor<Item extends { id: number }, Form>(
  options: ItemEditorOptions<Item, Form>,
) {
  const { resource, adminPath, empty, fromItem, writeBody, update } = options;
  const [phase, setPhase] = useState<EditorPhase>(options.id === undefined ? 'ready' : 'loading');
  const [id, setId] = useState<number | null>(options.id ?? null);
  const [etag, setEtag] = useState<string | null>(null);
  const [form, setForm] = useState<Form>(empty);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** The version someone else saved, while the conflict dialog is open. */
  const [conflict, setConflict] = useState<string | null>(null);
  const saving = useRef(false);
  const saveButton = useRef<HTMLButtonElement>(null);
  const summary = useRef<HTMLDivElement>(null);

  const showProblem = useCallback((next: Problem) => {
    setProblem(next);
    setMessage(null);
  }, []);

  useEffect(() => {
    if (problem) summary.current?.focus();
  }, [problem]);

  const load = useCallback(
    async (itemId: number) => {
      const response = await apiRequest<Item>(`${resource}/${itemId}`);
      if (!response.ok) return response.problem;
      setForm(fromItem(response.value));
      setEtag(response.etag);
      return null;
    },
    [resource, fromItem],
  );

  useEffect(() => {
    if (options.id === undefined) return;
    let current = true;
    load(options.id).then((failure) => {
      if (!current) return;
      if (failure) showProblem(failure);
      setPhase(failure ? 'failed' : 'ready');
    });
    return () => {
      current = false;
    };
  }, [options.id, load, showProblem]);

  /** Saves the form; `ifMatch` replaces the ETag when the editor chose to overwrite. */
  const save = useCallback(
    async (ifMatch?: string) => {
      if (saving.current) return;
      saving.current = true;
      setMessage(null);
      const response = await apiRequest<Item>(id === null ? resource : `${resource}/${id}`, {
        method: id === null ? 'POST' : update,
        body: writeBody(form),
        ifMatch: id === null ? undefined : (ifMatch ?? etag ?? undefined),
      });
      saving.current = false;

      if (!response.ok) {
        if (response.problem.status === 412) {
          setProblem(null);
          setConflict(response.problem.currentVersion ?? '');
        } else {
          showProblem(response.problem);
        }
        return;
      }
      const item = response.value;
      setProblem(null);
      setForm(fromItem(item));
      setEtag(response.etag);
      setMessage('Saved.');
      if (id === null) {
        setId(item.id);
        window.history.replaceState(null, '', `${adminPath}/${item.id}`);
      }
    },
    [id, resource, update, writeBody, form, etag, fromItem, adminPath, showProblem],
  );

  const conflictActions = {
    open: conflict !== null,
    /** Throws the editor's changes away for the version that is saved now. */
    loadTheirs: async () => {
      setConflict(null);
      if (id === null) return;
      const failure = await load(id);
      if (failure) showProblem(failure);
      else setMessage('Loaded the newer version. Your changes were not saved.');
    },
    overwrite: () => {
      const version = conflict;
      setConflict(null);
      void save(version ? asEtag(version) : undefined);
    },
    cancel: () => setConflict(null),
  };

  /** The field errors of the last failed save; a taken slug counts as one. */
  const errors: FieldErrors =
    problem?.type === 'conflict'
      ? { slug: [problem.detail || 'That slug is taken.'] }
      : (problem?.errors ?? {});

  return {
    phase,
    id,
    form,
    setForm,
    problem,
    errors,
    message,
    save,
    conflict: conflictActions,
    saveButton,
    summary,
  };
}
