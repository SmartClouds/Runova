import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { NativeSelect } from '@/components/ui/native-select';
import { Textarea } from '@/components/ui/textarea';
import {
  allowedSeverities,
  cvssSeverity,
  NEW_NEWS_FORM,
  type NewsForm,
  type NewsItemAdmin,
  newsFormFrom,
  newsWriteDto,
  withCategory,
} from '@/lib/admin/news';
import { errorsFor, errorsUnder, unplacedErrors } from '@/lib/admin/problems';
import { slugify } from '@/lib/admin/publishing';
import { CATEGORIES, type Category, type Severity } from '@/lib/news/api';
import { CATEGORY_LABELS, SEVERITY_LABELS } from '@/lib/news/page';
import { EditorShell } from './EditorShell';
import { Field } from './Field';
import { MarkdownField } from './MarkdownField';
import { PublishingFields, publishingFieldNames } from './PublishingFields';
import { TechnologiesPicker } from './TechnologiesPicker';
import { useItemEditor } from './useItemEditor';

const FIELDS = [
  'slug',
  'title',
  'summary',
  'bodyMarkdown',
  'category',
  'severity',
  'technologies',
  'cveIds',
  'cvssScore',
  'tags',
];

/** The news editor: a new item when there is no `id`, else the item with that id. */
export default function NewsEditor({ id }: { id?: number }) {
  const editor = useItemEditor<NewsItemAdmin, NewsForm>({
    resource: '/news',
    adminPath: '/admin/news',
    id,
    empty: NEW_NEWS_FORM,
    fromItem: newsFormFrom,
    writeBody: newsWriteDto,
    update: 'PUT',
  });
  const { form, setForm, errors } = editor;
  const change = (patch: Partial<NewsForm>) => setForm((current) => ({ ...current, ...patch }));
  const security = form.category === 'security';
  const suggested = security ? cvssSeverity(form.cvssScore) : null;
  const shown = [...FIELDS, ...publishingFieldNames(form.publishing)];

  return (
    <EditorShell
      editor={editor}
      title={id === undefined ? 'New news item' : 'Edit news item'}
      unplaced={unplacedErrors(errors, shown)}
    >
      <Field id="news-title" label="Title" errors={errorsFor(errors, 'title')}>
        {(control) => (
          <Input
            {...control}
            value={form.title}
            onChange={(event) => {
              const title = event.target.value;
              setForm((current) => ({
                ...current,
                title,
                ...(!current.slugEdited && { slug: slugify(title) }),
              }));
            }}
          />
        )}
      </Field>
      <Field
        id="news-slug"
        label="Slug"
        hint="The last part of the address: lowercase letters, digits and hyphens."
        errors={errorsFor(errors, 'slug')}
      >
        {(control) => (
          <Input
            {...control}
            className="font-mono"
            value={form.slug}
            onChange={(event) => change({ slug: event.target.value, slugEdited: true })}
          />
        )}
      </Field>
      <Field id="news-summary" label="Summary" errors={errorsFor(errors, 'summary')}>
        {(control) => (
          <Textarea
            {...control}
            value={form.summary}
            onChange={(event) => change({ summary: event.target.value })}
          />
        )}
      </Field>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id="news-category" label="Category" errors={errorsFor(errors, 'category')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.category}
              onChange={(event) =>
                setForm((current) => withCategory(current, event.target.value as Category))
              }
            >
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {CATEGORY_LABELS[category]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
        <Field id="news-severity" label="Severity" errors={errorsFor(errors, 'severity')}>
          {(control) => (
            <NativeSelect
              {...control}
              value={form.severity}
              onChange={(event) => change({ severity: event.target.value as Severity })}
            >
              {allowedSeverities(form.category).map((severity) => (
                <option key={severity} value={severity}>
                  {SEVERITY_LABELS[severity]}
                </option>
              ))}
            </NativeSelect>
          )}
        </Field>
      </div>

      {security && (
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="news-cvss"
            label="CVSS score"
            errors={errorsFor(errors, 'cvssScore')}
            hint={
              suggested && (
                <span className="flex flex-wrap items-center gap-2">
                  A score of {form.cvssScore} is {SEVERITY_LABELS[suggested]}.
                  {suggested !== form.severity && (
                    <Button
                      type="button"
                      variant="link"
                      size="sm"
                      className="h-auto px-0"
                      onClick={() => change({ severity: suggested })}
                    >
                      Use {SEVERITY_LABELS[suggested]}
                    </Button>
                  )}
                </span>
              )
            }
          >
            {(control) => (
              <Input
                {...control}
                type="number"
                inputMode="decimal"
                min={0}
                max={10}
                step={0.1}
                value={form.cvssScore}
                onChange={(event) => change({ cvssScore: event.target.value })}
              />
            )}
          </Field>
          <Field
            id="news-cves"
            label="CVE ids"
            hint="Separate them with commas or spaces."
            errors={errorsUnder(errors, 'cveIds')}
          >
            {(control) => (
              <Input
                {...control}
                className="font-mono"
                value={form.cveIds}
                onChange={(event) => change({ cveIds: event.target.value })}
              />
            )}
          </Field>
        </div>
      )}

      <TechnologiesPicker
        id="news-technologies"
        value={form.technologies}
        onChange={(technologies) => change({ technologies })}
        errors={errors}
      />

      <Field
        id="news-tags"
        label="Tags"
        hint="Lowercase words with hyphens, separated by commas."
        errors={errorsUnder(errors, 'tags')}
      >
        {(control) => (
          <Input
            {...control}
            value={form.tags}
            onChange={(event) => change({ tags: event.target.value })}
          />
        )}
      </Field>

      <MarkdownField
        id="news-body"
        value={form.bodyMarkdown}
        onChange={(bodyMarkdown) => change({ bodyMarkdown })}
        errors={errorsFor(errors, 'bodyMarkdown')}
      />

      <PublishingFields
        id="news-publishing"
        value={form.publishing}
        onChange={(publishing) => change({ publishing })}
        errors={errors}
      />
    </EditorShell>
  );
}
