/**
 * Everything Studio's screens take from the rest of Runova's renderer, in one place. Studio
 * code imports app UI from here only (studioBoundary.test.ts holds it to that), so if Studio ever
 * becomes an app of its own, this file is the one that gets reimplemented.
 */

export { getCliDefinition, launchPickLabel } from '@runova/core';
export { toast } from 'sonner';
export { type RunSettings, RunSettingsFields } from '@/components/cli/RunSettingsFields';
export { ErrorBoundary } from '@/components/ErrorBoundary';
export {
  ArrowDown,
  ArrowLeft,
  ArrowUp,
  Bookmark,
  Camera,
  Check,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  CircleCheck,
  Clapperboard,
  Code,
  Download,
  EllipsisVertical,
  ExternalLink,
  FileText,
  Folder,
  FolderOpen,
  FolderPlus,
  Globe,
  GripVertical,
  History,
  ImageIcon,
  Key,
  Lock,
  Microphone,
  Monitor,
  Pause,
  Pencil,
  Pin,
  Play,
  Plus,
  Redo,
  RefreshCw,
  Save,
  Send,
  SignIn,
  Sparkles,
  Spinner,
  StopCircle,
  Trash2,
  TriangleAlert,
  Undo,
  Upload,
  Video,
  VolumeHigh,
  Wand2,
  Wrench,
  X,
} from '@/components/icons';

import { lazy } from 'react';

/** Monaco is large, so the code view loads it only when it opens. */
export const MonacoEditor = lazy(() =>
  import('@/components/editor/MonacoEditor').then((m) => ({ default: m.MonacoEditor })),
);
/** Monaco's side-by-side diff, for comparing two revisions of a scene's code or two AI runs. */
export const MonacoDiffEditor = lazy(() =>
  import('@/components/editor/MonacoDiffEditor').then((m) => ({ default: m.MonacoDiffEditor })),
);
export {
  CARD_GRID,
  CatalogCardShimmer,
  Chip,
  type ChipTone,
  EmptyState,
  GLASS_CARD,
  GLASS_PANEL,
  LoadFailure,
  Notice,
  SECTION_HEADING,
  SECTION_WELL,
  SEGMENT_TRACK,
  segmentClass,
  TOOLBAR,
} from '@/components/pageKit';
export { SshVaultUnlockDialog as VaultUnlockDialog } from '@/components/remote/SshVaultUnlockDialog';
export { AgentPromptField } from '@/components/terminal/AgentPromptField';
export { Button } from '@/components/ui/button';
export { Card } from '@/components/ui/card';
export { Checkbox } from '@/components/ui/checkbox';
export { Combobox, type ComboboxOption } from '@/components/ui/combobox';
export {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
export { Input } from '@/components/ui/input';
export { Label } from '@/components/ui/label';
export { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
export { ReorderableGroup, type ReorderMotion } from '@/components/ui/ReorderableGroup';
export { SecretInput } from '@/components/ui/secret-input';
export { Skeleton } from '@/components/ui/skeleton';
export { Switch } from '@/components/ui/switch';
export { Textarea } from '@/components/ui/textarea';
export { SimpleTooltip } from '@/components/ui/tooltip';
export { queryKeys as appQueryKeys } from '@/lib/queryKeys';
export { persianTextProps } from '@/lib/rtl';
export { cn } from '@/lib/utils';
export { confirmDialog } from '@/stores/confirmStore';
export { usePageHeader } from '@/stores/pageHeaderStore';
export { useStudioAiOutputStore } from '@/stores/studioAiOutputStore';
