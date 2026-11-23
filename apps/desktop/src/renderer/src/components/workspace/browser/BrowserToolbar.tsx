import { useEffect, useRef, useState } from 'react';
import {
  ArrowLeft,
  ArrowRight,
  Bug,
  Copy,
  Crosshair,
  EllipsisVertical,
  Expand,
  ExternalLink,
  Lock,
  MessageSquarePlus,
  Monitor,
  RotateCw,
  Smartphone,
  Tablet,
  X,
} from '@/components/icons';
import { Chip } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { displayUrl, isLocalUrl, normalizeAddress } from '@/lib/browser/address';
import type { BrowserNavState } from '@/lib/browser/browserRuntime';
import type { PickIntent } from '@/lib/browser/pickerMachine';
import {
  VIEWPORT_PRESETS,
  type ViewportPresetId,
  viewportPreset,
} from '@/lib/browser/viewportPresets';
import { cn } from '@/lib/utils';
import { useShortcutLabel } from '@/stores/shortcutStore';

export interface BrowserToolbarProps {
  nav: BrowserNavState;
  viewport: ViewportPresetId;
  /** Which element tool is on, if any. */
  picking: PickIntent | null;
  commentCount: number;
  /** Bumped to pull focus into the address bar (Ctrl+L). */
  focusAddressToken: number;
  onNavigate: (url: string) => void;
  onBack: () => void;
  onForward: () => void;
  onReload: (hard: boolean) => void;
  onStop: () => void;
  onPick: (intent: PickIntent) => void;
  onViewport: (viewport: ViewportPresetId) => void;
  onDevTools: () => void;
  onOpenExternal: () => void;
  onCopyUrl: () => void;
}

const PRESET_ICON: Record<ViewportPresetId, typeof Monitor> = {
  responsive: Expand,
  mobile: Smartphone,
  tablet: Tablet,
  desktop: Monitor,
};

function ToolButton({
  label,
  onClick,
  disabled,
  pressed,
  children,
  className,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label}>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'relative shrink-0',
          pressed &&
            'bg-primary/15 text-primary shadow-[inset_0_0_0_1px_hsl(var(--primary)/0.35)] hover:bg-primary/20 hover:text-primary',
          className,
        )}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

function AddressBar({
  url,
  focusToken,
  onNavigate,
}: {
  url: string;
  focusToken: number;
  onNavigate: (url: string) => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const editing = draft !== null;

  useEffect(() => {
    if (focusToken === 0) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [focusToken]);

  let secure: 'https' | 'local' | 'insecure' | null = null;
  if (url.startsWith('https:')) secure = 'https';
  else if (url.startsWith('http:')) secure = isLocalUrl(url) ? 'local' : 'insecure';

  return (
    // The search pill, like the API Client's URL bar. Its edge turns primary while it holds focus.
    <div className="search-pill flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-full px-3 transition-colors">
      {secure === 'https' && !editing ? (
        <SimpleTooltip label="Secure connection">
          <Lock className="h-2.5 w-2.5 shrink-0 text-muted-foreground" />
        </SimpleTooltip>
      ) : null}
      {secure === 'insecure' && !editing ? (
        <Chip tone="warning" className="h-[1.125rem] px-1.5 text-[10px]">
          Not secure
        </Chip>
      ) : null}
      <input
        ref={inputRef}
        aria-label="Address"
        spellCheck={false}
        autoComplete="off"
        placeholder="Search or type an address"
        value={editing ? draft : displayUrl(url)}
        onFocus={(event) => {
          setDraft(url);
          const input = event.currentTarget;
          // Select on the next frame so the click's mouseup does not undo it. By then a quick
          // typist may already have typed, and selecting that would let the next key replace it.
          requestAnimationFrame(() => {
            if (document.activeElement === input && input.value === url) input.select();
          });
        }}
        onBlur={() => setDraft(null)}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            setDraft(null);
            event.currentTarget.blur();
            return;
          }
          if (event.key !== 'Enter') return;
          event.preventDefault();
          const next = normalizeAddress(event.currentTarget.value);
          if (!next) return;
          onNavigate(next);
          setDraft(null);
          event.currentTarget.blur();
        }}
        className={cn(
          'h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70',
          editing ? 'text-foreground' : 'text-foreground/85',
        )}
      />
    </div>
  );
}

export function BrowserToolbar({
  nav,
  viewport,
  picking,
  commentCount,
  focusAddressToken,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  onPick,
  onViewport,
  onDevTools,
  onOpenExternal,
  onCopyUrl,
}: BrowserToolbarProps): React.JSX.Element {
  const hasPage = nav.url !== '';
  const preset = viewportPreset(viewport);
  const PresetIcon = PRESET_ICON[preset.id];
  const pickKey = useShortcutLabel('workspace.pickElement');

  return (
    <div className="relative flex h-10 shrink-0 items-center gap-1 px-1.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]">
      <ToolButton label="Back" onClick={onBack} disabled={!nav.canGoBack}>
        <ArrowLeft className="h-3 w-3" />
      </ToolButton>
      <ToolButton label="Forward" onClick={onForward} disabled={!nav.canGoForward}>
        <ArrowRight className="h-3 w-3" />
      </ToolButton>
      {nav.loading ? (
        <ToolButton label="Stop loading" onClick={onStop}>
          <X className="h-3 w-3" />
        </ToolButton>
      ) : (
        <ToolButton label="Reload" onClick={() => onReload(false)} disabled={!hasPage}>
          <RotateCw className="h-3 w-3" />
        </ToolButton>
      )}

      <AddressBar url={nav.url} focusToken={focusAddressToken} onNavigate={onNavigate} />

      <div className="flex items-center gap-0.5 pl-1">
        <ToolButton
          label="Pick an element to copy its details"
          onClick={() => onPick('copy')}
          disabled={!hasPage}
          pressed={picking === 'copy'}
        >
          <Crosshair className="h-3.5 w-3.5" />
        </ToolButton>
        <ToolButton
          label={`Comment on an element for your agent${pickKey ? ` (${pickKey})` : ''}`}
          onClick={() => onPick('comment')}
          disabled={!hasPage}
          pressed={picking === 'comment'}
        >
          <MessageSquarePlus className="h-3.5 w-3.5" />
          {commentCount > 0 ? (
            <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-primary px-0.5 text-[9px] font-bold leading-none text-primary-foreground">
              {commentCount}
            </span>
          ) : null}
        </ToolButton>
      </div>

      <span aria-hidden className="mx-0.5 h-4 w-px bg-foreground/10" />

      <DropdownMenu>
        <SimpleTooltip label={`Device size: ${preset.label}`}>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Device size: ${preset.label}`}
              className={cn(
                'data-[state=open]:bg-foreground/10',
                preset.id !== 'responsive' && 'text-primary',
              )}
            >
              <PresetIcon className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuLabel>Device size</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={preset.id}
            onValueChange={(value) => onViewport(value as ViewportPresetId)}
          >
            {VIEWPORT_PRESETS.map((option) => {
              const Icon = PRESET_ICON[option.id];
              return (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  <Icon className="h-3 w-3 text-muted-foreground" />
                  <span>{option.label}</span>
                  <span className="ml-auto font-mono text-[10px] text-muted-foreground">
                    {option.width ? `${option.width}×${option.height}` : 'fill'}
                  </span>
                </DropdownMenuRadioItem>
              );
            })}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <SimpleTooltip label="More">
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="More"
              className="data-[state=open]:bg-foreground/10"
            >
              <EllipsisVertical className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
        </SimpleTooltip>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem disabled={!hasPage} onSelect={onDevTools}>
            <Bug className="h-3.5 w-3.5 text-muted-foreground" />
            Open DevTools
            <DropdownMenuShortcut>F12</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasPage} onSelect={() => onReload(true)}>
            <RotateCw className="h-3.5 w-3.5 text-muted-foreground" />
            Reload without cache
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasPage} onSelect={onOpenExternal}>
            <ExternalLink className="h-3.5 w-3.5 text-muted-foreground" />
            Open in system browser
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasPage} onSelect={onCopyUrl}>
            <Copy className="h-3.5 w-3.5 text-muted-foreground" />
            Copy address
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {nav.loading ? (
        <div
          role="progressbar"
          aria-label="Loading page"
          className="browser-progress pointer-events-none absolute inset-x-0 -bottom-px h-[2px] overflow-hidden"
        />
      ) : null}
    </div>
  );
}
