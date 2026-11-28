import {
  bodySection,
  RELAY_ITEM_SPECS,
  RELAY_LEVELS,
  type RelayItem,
  type RelayItemKind,
} from '@runova/core';
import type { RelayItemInput } from '@shared/relayTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Spinner } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { queryKeys } from '@/lib/queryKeys';

type FieldKey = keyof NonNullable<RelayItemInput['fields']>;

/** The front matter fields each kind of record shows, with their labels. */
const KIND_FIELDS: Record<RelayItemKind, { key: FieldKey; label: string; placeholder?: string }[]> =
  {
    milestone: [{ key: 'target', label: 'Target date', placeholder: 'YYYY-MM-DD' }],
    decision: [{ key: 'task', label: 'From task', placeholder: 'T001' }],
    workaround: [
      { key: 'dependency', label: 'Package it waits on', placeholder: 'zod' },
      { key: 'ecosystem', label: 'Ecosystem', placeholder: 'npm, cargo, nuget, pip...' },
      { key: 'waitingFor', label: 'Version with the fix', placeholder: '4.7.0' },
      { key: 'revisitBy', label: 'Look again by', placeholder: 'YYYY-MM-DD' },
      { key: 'task', label: 'From task', placeholder: 'T001' },
    ],
    risk: [
      { key: 'likelihood', label: 'Likelihood' },
      { key: 'impact', label: 'Impact' },
      { key: 'owner', label: 'Owner' },
    ],
    question: [{ key: 'task', label: 'From task', placeholder: 'T001' }],
  };

const LEVEL_FIELDS: ReadonlySet<FieldKey> = new Set(['likelihood', 'impact']);
const DATE_FIELDS: ReadonlySet<FieldKey> = new Set(['target', 'revisitBy']);

function fieldValue(item: RelayItem | null, key: FieldKey): string {
  return (item?.[key] as string | null | undefined) ?? '';
}

/**
 * Adds or edits one record of the plan (E122): a milestone, decision, workaround, risk or
 * question, with its status, its fields and its sections.
 */
export function RelayItemDialog({
  open,
  onOpenChange,
  projectId,
  kind,
  item,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  kind: RelayItemKind;
  /** The record to edit, or null to add one. */
  item: RelayItem | null;
}): React.JSX.Element {
  const spec = RELAY_ITEM_SPECS[kind];
  const queryClient = useQueryClient();
  const [title, setTitle] = useState('');
  const [status, setStatus] = useState(spec.statuses[0]);
  const [fields, setFields] = useState<Partial<Record<FieldKey, string>>>({});
  const [sections, setSections] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTitle(item?.title ?? '');
    setStatus(item?.status ?? spec.statuses[0]);
    setFields(
      Object.fromEntries(
        KIND_FIELDS[kind].map((field) => [field.key, fieldValue(item, field.key)]),
      ),
    );
    setSections(
      Object.fromEntries(
        spec.sections.map((section) => [
          section.heading,
          item ? bodySection(item.body, section.heading) : '',
        ]),
      ),
    );
  }, [open, item, kind, spec]);

  async function save(): Promise<void> {
    if (!title.trim()) return;
    setSaving(true);
    const cleaned = Object.fromEntries(
      Object.entries(fields).map(([key, value]) => [key, value?.trim() ? value.trim() : null]),
    ) as RelayItemInput['fields'];
    try {
      await window.runova.relay.saveItem(projectId, {
        kind,
        ...(item ? { id: item.id } : {}),
        title: title.trim(),
        status,
        fields: cleaned,
        sections,
      });
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayPlanPack(projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.relayRevisits(projectId) });
      onOpenChange(false);
    } catch (error) {
      toast.error(`Could not save the ${spec.label.toLowerCase()}`, {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }

  const select = 'h-8 w-full rounded-md border border-input bg-background px-2 text-xs';
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[88vh] max-w-xl flex-col">
        <DialogHeader>
          <DialogTitle>
            {item ? `${item.id} ${spec.label}` : `New ${spec.label.toLowerCase()}`}
          </DialogTitle>
          <DialogDescription>
            Kept as a file in the {spec.folder} folder next to the tasks, so it is in the
            project&apos;s history.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">
          <div className="grid grid-cols-[1fr_9rem] gap-3">
            <div className="space-y-1">
              <Label htmlFor="item-title" className="text-xs text-muted-foreground">
                Title
              </Label>
              <Input
                id="item-title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="h-8 text-sm"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="item-status" className="text-xs text-muted-foreground">
                Status
              </Label>
              <select
                id="item-status"
                className={select}
                value={status}
                onChange={(event) => setStatus(event.target.value)}
              >
                {spec.statuses.map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {KIND_FIELDS[kind].map((field) => {
              const id = `item-${field.key}`;
              const value = fields[field.key] ?? '';
              const change = (next: string) =>
                setFields((current) => ({ ...current, [field.key]: next }));
              return (
                <div key={field.key} className="space-y-1">
                  <Label htmlFor={id} className="text-xs text-muted-foreground">
                    {field.label}
                  </Label>
                  {LEVEL_FIELDS.has(field.key) ? (
                    <select
                      id={id}
                      className={select}
                      value={value}
                      onChange={(event) => change(event.target.value)}
                    >
                      <option value="">Not set</option>
                      {RELAY_LEVELS.map((level) => (
                        <option key={level} value={level}>
                          {level}
                        </option>
                      ))}
                    </select>
                  ) : (
                    <Input
                      id={id}
                      type={DATE_FIELDS.has(field.key) ? 'date' : 'text'}
                      placeholder={field.placeholder}
                      value={value}
                      onChange={(event) => change(event.target.value)}
                      className="h-8 text-xs"
                    />
                  )}
                </div>
              );
            })}
          </div>
          {spec.sections.map((section) => {
            const id = `item-section-${section.heading.replace(/\s+/g, '-').toLowerCase()}`;
            return (
              <div key={section.heading} className="space-y-1">
                <Label htmlFor={id} className="text-xs text-muted-foreground">
                  {section.heading}
                </Label>
                <Textarea
                  id={id}
                  placeholder={section.hint}
                  value={sections[section.heading] ?? ''}
                  onChange={(event) =>
                    setSections((current) => ({
                      ...current,
                      [section.heading]: event.target.value,
                    }))
                  }
                  className="min-h-20 text-xs"
                />
              </div>
            );
          })}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={saving || !title.trim()}
            onClick={() => void save()}
          >
            {saving ? <Spinner className="animate-spin" /> : null}
            {item ? 'Save' : `Add ${spec.label.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
