import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { apiRequest } from '@/lib/admin/api';
import type { Technology, TechnologyRow } from '@/lib/admin/news';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import { Field } from './Field';

interface TechnologiesPickerProps {
  id: string;
  value: TechnologyRow[];
  onChange: (value: TechnologyRow[]) => void;
  errors: FieldErrors;
}

type Loaded = { state: 'loading' } | { state: 'failed' } | { state: 'ready'; list: Technology[] };

/** The technologies an item names, picked from `GET /api/v1/technologies`, with their versions. */
export function TechnologiesPicker({ id, value, onChange, errors }: TechnologiesPickerProps) {
  const [technologies, setTechnologies] = useState<Loaded>({ state: 'loading' });
  const [choice, setChoice] = useState('');
  /** The control to focus once the rows have rendered: a new row's range, or the picker. */
  const [focusNext, setFocusNext] = useState<string | null>(null);

  useEffect(() => {
    let current = true;
    apiRequest<Technology[]>('/technologies').then((response) => {
      if (!current) return;
      setTechnologies(response.ok ? { state: 'ready', list: response.value } : { state: 'failed' });
    });
    return () => {
      current = false;
    };
  }, []);

  useEffect(() => {
    if (!focusNext) return;
    document.getElementById(focusNext)?.focus();
    setFocusNext(null);
  }, [focusNext]);

  const rowId = (index: number, part: string) => `${id}-${index}-${part}`;
  const pickerId = `${id}-add`;
  const ownErrors = [
    ...errorsFor(errors, 'technologies'),
    ...value.flatMap((row, index) =>
      [
        ...errorsFor(errors, `technologies[${index}]`),
        ...errorsFor(errors, `technologies[${index}].technology`),
      ].map((message) => `${row.name}: ${message}`),
    ),
  ];

  const update = (index: number, change: Partial<TechnologyRow>) =>
    onChange(value.map((row, each) => (each === index ? { ...row, ...change } : row)));

  const add = () => {
    if (technologies.state !== 'ready') return;
    const technology = technologies.list.find((each) => each.slug === choice);
    if (!technology) return;
    onChange([
      ...value,
      { technology: technology.slug, name: technology.name, versionRange: '*', fixedIn: '' },
    ]);
    setChoice('');
    setFocusNext(rowId(value.length, 'range'));
  };

  const remove = (index: number) => {
    onChange(value.filter((_, each) => each !== index));
    setFocusNext(pickerId);
  };

  const available =
    technologies.state === 'ready'
      ? technologies.list.filter((each) => !value.some((row) => row.technology === each.slug))
      : [];

  return (
    <fieldset className="grid gap-4">
      <legend className="mb-2 font-medium text-sm">Technologies</legend>
      {value.length > 0 && (
        <ul className="grid gap-4">
          {value.map((row, index) => (
            <li
              key={row.technology}
              className="grid gap-3 rounded-md border p-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end"
            >
              <Field
                id={rowId(index, 'range')}
                label={
                  <>
                    Affected versions<span className="sr-only"> of {row.name}</span>
                  </>
                }
                errors={errorsFor(errors, `technologies[${index}].versionRange`)}
              >
                {(control) => (
                  <Input
                    {...control}
                    className="font-mono"
                    value={row.versionRange}
                    onChange={(event) => update(index, { versionRange: event.target.value })}
                  />
                )}
              </Field>
              <Field
                id={rowId(index, 'fixed')}
                label={
                  <>
                    Fixed in<span className="sr-only"> for {row.name}</span>
                  </>
                }
                errors={errorsFor(errors, `technologies[${index}].fixedIn`)}
              >
                {(control) => (
                  <Input
                    {...control}
                    className="font-mono"
                    value={row.fixedIn}
                    onChange={(event) => update(index, { fixedIn: event.target.value })}
                  />
                )}
              </Field>
              <div className="flex items-center justify-between gap-3 sm:block">
                <span className="font-medium text-sm sm:hidden">{row.name}</span>
                <Button
                  type="button"
                  variant="outline"
                  aria-label={`Remove ${row.name}`}
                  onClick={() => remove(index)}
                >
                  Remove <span className="hidden sm:inline">{row.name}</span>
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {technologies.state === 'loading' && (
        <p className="text-muted-foreground text-sm">Loading the technology list.</p>
      )}
      {technologies.state === 'failed' && (
        <p className="text-destructive text-sm">
          The technology list could not be loaded. Reload the page to try again.
        </p>
      )}
      {technologies.state === 'ready' && (
        <div className="flex flex-wrap items-end gap-3">
          <Field
            id={pickerId}
            label="Technology to add"
            errors={ownErrors}
            hint="Ranges look like >=2.40.0 <2.47.1, and * means every version."
            className="min-w-56 flex-1"
          >
            {(control) => (
              <NativeSelect
                {...control}
                value={choice}
                onChange={(event) => setChoice(event.target.value)}
              >
                <option value="">Choose a technology</option>
                {available.map((each) => (
                  <option key={each.slug} value={each.slug}>
                    {each.name}
                  </option>
                ))}
              </NativeSelect>
            )}
          </Field>
          <Button type="button" variant="outline" onClick={add}>
            Add technology
          </Button>
        </div>
      )}
    </fieldset>
  );
}
