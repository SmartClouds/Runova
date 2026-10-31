import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import {
  NEW_POST_FORM,
  type PostAdmin,
  type PostForm,
  postFormFrom,
  postWriteDto,
} from '@/lib/admin/posts';
import { errorsFor, errorsUnder, unplacedErrors } from '@/lib/admin/problems';
import { slugify } from '@/lib/admin/publishing';
import { CoverField } from './CoverField';
import { EditorShell } from './EditorShell';
import { Field } from './Field';
import { MarkdownField } from './MarkdownField';
import { PublishingFields, publishingFieldNames } from './PublishingFields';
import { useItemEditor } from './useItemEditor';

const FIELDS = ['slug', 'title', 'excerpt', 'bodyMarkdown', 'coverMediaId', 'tags'];

/** The blog post editor: a new post when there is no `id`, else the post with that id. */
export default function PostEditor({ id }: { id?: number }) {
  const editor = useItemEditor<PostAdmin, PostForm>({
    resource: '/posts',
    adminPath: '/admin/blog',
    id,
    empty: NEW_POST_FORM,
    fromItem: postFormFrom,
    writeBody: postWriteDto,
    update: 'PATCH',
  });
  const { form, setForm, errors } = editor;
  const change = (patch: Partial<PostForm>) => setForm((current) => ({ ...current, ...patch }));
  const shown = [...FIELDS, ...publishingFieldNames(form.publishing)];

  return (
    <EditorShell
      editor={editor}
      title={id === undefined ? 'New post' : 'Edit post'}
      unplaced={unplacedErrors(errors, shown)}
    >
      <Field id="post-title" label="Title" errors={errorsFor(errors, 'title')}>
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
        id="post-slug"
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
      <Field id="post-excerpt" label="Excerpt" errors={errorsFor(errors, 'excerpt')}>
        {(control) => (
          <Textarea
            {...control}
            value={form.excerpt}
            onChange={(event) => change({ excerpt: event.target.value })}
          />
        )}
      </Field>
      <Field
        id="post-tags"
        label="Tags"
        hint="Separate them with commas. A tag that does not exist yet is created."
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

      <CoverField
        id="post-cover"
        value={form.cover}
        onChange={(cover) =>
          change(
            cover
              ? { cover: { url: cover.url, alt: cover.alt }, coverMediaId: cover.mediaId }
              : { cover: null, coverMediaId: null },
          )
        }
        errors={errorsFor(errors, 'coverMediaId')}
      />

      <MarkdownField
        id="post-body"
        value={form.bodyMarkdown}
        onChange={(bodyMarkdown) => change({ bodyMarkdown })}
        errors={errorsFor(errors, 'bodyMarkdown')}
      />

      <PublishingFields
        id="post-publishing"
        value={form.publishing}
        onChange={(publishing) => change({ publishing })}
        errors={errors}
      />
    </EditorShell>
  );
}
