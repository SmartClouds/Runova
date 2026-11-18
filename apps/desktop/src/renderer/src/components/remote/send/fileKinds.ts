import {
  Archive,
  File,
  FileCode,
  FileText,
  Folder,
  type IconProps,
  ImageIcon,
  Video,
  VolumeHigh,
} from '@/components/icons';

export type FileKind = 'image' | 'video' | 'audio' | 'archive' | 'code' | 'document' | 'other';

const BY_EXTENSION: Record<string, FileKind> = {};
const add = (kind: FileKind, list: string) => {
  for (const ext of list.split(' ')) BY_EXTENSION[ext] = kind;
};
add(
  'image',
  'jpg jpeg png gif webp heic heif avif bmp tif tiff svg ico raw cr2 cr3 nef arw dng psd',
);
add('video', 'mp4 mov mkv avi webm m4v wmv flv mts');
add('audio', 'mp3 wav flac aac m4a ogg opus wma aiff');
add('archive', 'zip rar 7z tar gz tgz bz2 xz zst iso dmg apk aab msi');
add(
  'code',
  'ts tsx js jsx mjs cjs json py rb go rs java kt swift c h cpp cs php sh ps1 sql yml yaml toml xml html css scss md',
);
add('document', 'pdf doc docx xls xlsx ppt pptx odt ods odp rtf txt csv key pages numbers epub');

/** What kind of file a name is, by its extension, for the tile it is drawn with. */
export function fileKind(name: string): FileKind {
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return 'other';
  return BY_EXTENSION[name.slice(dot + 1).toLowerCase()] ?? 'other';
}

/** Each kind's icon and tint, drawn from the theme so it reads in every theme. */
export const KIND_LOOK: Record<
  FileKind | 'folder',
  { Icon: React.ForwardRefExoticComponent<IconProps>; tile: string; label: string }
> = {
  folder: { Icon: Folder, tile: 'bg-primary/12 text-primary', label: 'Folder' },
  image: { Icon: ImageIcon, tile: 'bg-severity-low/15 text-severity-low', label: 'Image' },
  video: { Icon: Video, tile: 'bg-severity-high/15 text-severity-high', label: 'Video' },
  audio: { Icon: VolumeHigh, tile: 'bg-severity-medium/15 text-severity-medium', label: 'Audio' },
  archive: { Icon: Archive, tile: 'bg-warning/15 text-warning', label: 'Archive' },
  code: { Icon: FileCode, tile: 'bg-success/15 text-success', label: 'Code' },
  document: { Icon: FileText, tile: 'bg-foreground/[0.08] text-foreground/80', label: 'Document' },
  other: { Icon: File, tile: 'bg-foreground/[0.06] text-muted-foreground', label: 'File' },
};

/** A person as one or two letters, for their avatar. */
export function initials(name: string): string {
  return (
    name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase())
      .join('') || '?'
  );
}
