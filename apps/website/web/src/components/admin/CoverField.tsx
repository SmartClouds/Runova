import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiRequest } from '@/lib/admin/api';
import type { Cover, Media } from '@/lib/admin/posts';
import { errorsFor, type FieldErrors } from '@/lib/admin/problems';
import { Field } from './Field';

interface CoverFieldProps {
  id: string;
  value: Cover | null;
  /** A new cover with its media id, or null when the editor removes it. */
  onChange: (cover: (Cover & { mediaId: number }) | null) => void;
  /** Errors from the post save, such as an unknown `coverMediaId`. */
  errors: string[];
}

const ACCEPT = 'image/png,image/jpeg,image/webp,image/avif';

/** The post's cover: what it is now, and an upload to `POST /api/v1/media` with its alt text. */
export function CoverField({ id, value, onChange, errors }: CoverFieldProps) {
  const fileInput = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [alt, setAlt] = useState('');
  const [uploadErrors, setUploadErrors] = useState<FieldErrors>({});
  const [uploading, setUploading] = useState(false);

  const upload = async () => {
    if (uploading) return;
    const local: FieldErrors = {};
    if (!file) local.file = ['Choose an image to upload.'];
    if (alt.trim() === '') local.alt = ['Describe the image for people who cannot see it.'];
    setUploadErrors(local);
    if (!file || Object.keys(local).length > 0) return;

    const parts = new FormData();
    parts.append('file', file);
    parts.append('alt', alt.trim());
    setUploading(true);
    const response = await apiRequest<Media>('/media', { method: 'POST', body: parts });
    setUploading(false);

    if (!response.ok) {
      const { problem } = response;
      setUploadErrors(
        Object.keys(problem.errors).length > 0
          ? problem.errors
          : { file: [problem.detail || problem.title] },
      );
      return;
    }
    const media = response.value;
    onChange({ url: media.url, alt: media.alt, mediaId: media.id });
    setFile(null);
    setAlt('');
    if (fileInput.current) fileInput.current.value = '';
  };

  return (
    <fieldset className="grid gap-4">
      <legend className="mb-2 font-medium text-sm">Cover image</legend>
      {errors.length > 0 && (
        <div className="grid gap-1 font-medium text-destructive text-sm">
          {errors.map((message) => (
            <p key={message}>{message}</p>
          ))}
        </div>
      )}
      {value ? (
        <div className="flex flex-wrap items-end gap-4">
          <img
            src={value.url}
            alt={value.alt}
            className="aspect-[1200/630] w-64 rounded-md border object-cover"
          />
          <Button type="button" variant="outline" onClick={() => onChange(null)}>
            Remove cover
          </Button>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">No cover yet.</p>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          id={`${id}-file`}
          label="Cover image file"
          hint="PNG, JPEG, WebP or AVIF, up to 5 MB. 1200 by 630 pixels fits best."
          errors={errorsFor(uploadErrors, 'file')}
        >
          {(control) => (
            <Input
              {...control}
              ref={fileInput}
              type="file"
              accept={ACCEPT}
              onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            />
          )}
        </Field>
        <Field
          id={`${id}-alt`}
          label="Alt text"
          hint="What the image shows, for people who cannot see it."
          errors={errorsFor(uploadErrors, 'alt')}
        >
          {(control) => (
            <Input {...control} value={alt} onChange={(event) => setAlt(event.target.value)} />
          )}
        </Field>
      </div>
      <div className="flex items-center gap-3">
        <Button type="button" variant="outline" onClick={upload}>
          Upload cover
        </Button>
        {uploading && <span className="text-muted-foreground text-sm">Uploading.</span>}
      </div>
    </fieldset>
  );
}
