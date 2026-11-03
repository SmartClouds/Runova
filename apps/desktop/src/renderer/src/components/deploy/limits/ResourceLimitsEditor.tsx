import { describeLimits, formatMemoryMb, LIMIT_BOUNDS, type ServiceLimits } from '@runova/core';
import { useEffect, useId, useRef, useState } from 'react';
import { Copy, Cpu, HardDrive, MemoryStick } from '@/components/icons';
import { Chip, FilterChip, GLASS_CARD, Notice, SECTION_WELL } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  copyToAll,
  cpuDefaults,
  cpuTimeText,
  diskDefault,
  type LimitsHostFacts,
  limitFor,
  memoryDefault,
  memoryPresets,
  memoryWarnings,
  setLimit,
} from '@/lib/deploy/limits/editor';
import { cn } from '@/lib/utils';

/**
 * How much of the server each container may use: a card per service with CPU, memory and disk,
 * each Unlimited until it is switched on. Used before an App Store install and to edit an app or
 * a container afterwards. The value lists only the services that have a cap.
 */

export interface ResourceLimitsEditorProps {
  services: readonly string[];
  value: readonly ServiceLimits[];
  onChange: (next: ServiceLimits[]) => void;
  host: LimitsHostFacts;
  /** What the app needs to run well, from its template. */
  minMemoryMb?: number;
  /** What each service uses now, for the warning before a cap that would stop it. */
  usage?: Readonly<Record<string, { memoryMb?: number }>>;
  /** The service the editor was opened for, scrolled to and marked. */
  focus?: string;
  /** A live edit of a standalone container: CPU and memory only, since disk needs a new container. */
  cpuOnlyLive?: boolean;
}

const DISK_FALLBACK_NOTE = "Docker on this server can't cap a container's disk.";

/** Memory moves in 128 MB steps on the slider; the field takes any whole number. */
const MEMORY_STEP_MB = 128;

export function ResourceLimitsEditor({
  services,
  value,
  onChange,
  host,
  minMemoryMb,
  usage,
  focus,
  cpuOnlyLive = false,
}: ResourceLimitsEditorProps): React.JSX.Element {
  return (
    <div className="space-y-3">
      {services.map((service) => (
        <ServiceCard
          key={service}
          limit={limitFor(value, service)}
          host={host}
          minMemoryMb={minMemoryMb}
          usageMb={usage?.[service]?.memoryMb}
          focused={focus === service}
          cpuOnlyLive={cpuOnlyLive}
          onChange={(next) => onChange(setLimit(value, services, next))}
          onCopy={services.length > 1 ? () => onChange(copyToAll(value, services, service)) : null}
        />
      ))}
    </div>
  );
}

function ServiceCard({
  limit,
  host,
  minMemoryMb,
  usageMb,
  focused,
  cpuOnlyLive,
  onChange,
  onCopy,
}: {
  limit: ServiceLimits;
  host: LimitsHostFacts;
  minMemoryMb?: number;
  usageMb?: number;
  focused: boolean;
  cpuOnlyLive: boolean;
  onChange: (next: ServiceLimits) => void;
  onCopy: (() => void) | null;
}): React.JSX.Element {
  const { service } = limit;
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focused) ref.current?.scrollIntoView?.({ block: 'nearest' });
  }, [focused]);
  const change = (next: Partial<ServiceLimits>) => onChange({ ...limit, ...next });
  const cpuOn = typeof limit.cpuCores === 'number' || typeof limit.cpuPercent === 'number';
  const memoryOn = typeof limit.memoryMb === 'number';
  const diskOn = typeof limit.diskGb === 'number';
  const cores = limit.cpuCores ?? 1;
  const share = limit.cpuPercent ?? 100;
  const warnings = memoryWarnings(limit, minMemoryMb, usageMb);
  const summary = describeLimits(limit);

  return (
    <section
      ref={ref}
      aria-label={service}
      data-focused={focused ? 'true' : undefined}
      className={cn(GLASS_CARD, 'space-y-3 p-4', focused && 'ring-2 ring-primary/40')}
    >
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <h3 className="truncate font-mono text-sm font-semibold">{service}</h3>
          <Chip tone={summary === 'No limits' ? 'neutral' : 'primary'}>{summary}</Chip>
        </div>
        {onCopy && (
          <Button type="button" variant="ghost" size="xs" onClick={onCopy}>
            <Copy /> Use these limits for every service
          </Button>
        )}
      </header>

      <Resource
        icon={<Cpu />}
        title="CPU"
        resource="CPU"
        service={service}
        on={cpuOn}
        onToggle={(next) => change(next ? cpuDefaults(host) : { cpuCores: null, cpuPercent: null })}
      >
        <SliderRow
          label={`CPU cores for ${service}`}
          caption="Cores"
          value={Math.min(cores, host.cores)}
          min={1}
          max={Math.max(1, host.cores)}
          step={1}
          text={`${cores} of ${host.cores} ${host.cores === 1 ? 'core' : 'cores'}`}
          onValueChange={(cpuCores) => change({ cpuCores, cpuPercent: share })}
        />
        <SliderRow
          label={`Max CPU usage for ${service}`}
          caption="Max usage"
          value={share}
          min={LIMIT_BOUNDS.minCpuPercent}
          max={LIMIT_BOUNDS.maxCpuPercent}
          step={5}
          text={`${share}%`}
          onValueChange={(cpuPercent) => change({ cpuCores: cores, cpuPercent })}
        />
        <p className="text-xs text-muted-foreground">{cpuTimeText(limit)}</p>
      </Resource>

      <Resource
        icon={<MemoryStick />}
        title="Memory"
        resource="memory"
        service={service}
        on={memoryOn}
        onToggle={(next) => change({ memoryMb: next ? memoryDefault(host, minMemoryMb) : null })}
      >
        {memoryOn && (
          <>
            <div
              className="flex flex-wrap gap-1.5"
              role="group"
              aria-label={`Memory presets for ${service}`}
            >
              {memoryPresets(host.memoryMb).map((mb) => (
                <FilterChip
                  key={mb}
                  active={limit.memoryMb === mb}
                  onClick={() => change({ memoryMb: mb })}
                >
                  {formatMemoryMb(mb)}
                </FilterChip>
              ))}
            </div>
            <div className="flex items-center gap-3">
              <Slider
                aria-label={`Memory for ${service}`}
                className="flex-1"
                value={Math.max(MEMORY_STEP_MB, Math.min(limit.memoryMb ?? 0, host.memoryMb))}
                min={MEMORY_STEP_MB}
                max={Math.max(MEMORY_STEP_MB, host.memoryMb)}
                step={MEMORY_STEP_MB}
                valueLabel={formatMemoryMb(limit.memoryMb ?? 0)}
                onValueChange={(memoryMb) => change({ memoryMb })}
              />
              <WholeNumberField
                label={`Memory in MB for ${service}`}
                unit="MB"
                value={limit.memoryMb ?? 0}
                min={LIMIT_BOUNDS.minMemoryMb}
                max={host.memoryMb}
                onCommit={(memoryMb) => change({ memoryMb })}
              />
              <span className="shrink-0 text-xs text-muted-foreground">
                of {formatMemoryMb(host.memoryMb)}
              </span>
            </div>
            {warnings.map((warning) => (
              <Notice key={warning} tone="warning" size="sm" role="status">
                {warning}
              </Notice>
            ))}
          </>
        )}
      </Resource>

      {!cpuOnlyLive && (
        <Resource
          icon={<HardDrive />}
          title="Disk"
          resource="disk"
          service={service}
          on={diskOn}
          disabled={!host.diskLimits && !diskOn}
          note={host.diskLimits ? null : (host.diskNote ?? DISK_FALLBACK_NOTE)}
          onToggle={(next) => change({ diskGb: next ? diskDefault() : null })}
        >
          {diskOn && (
            <div className="flex items-center gap-3">
              <WholeNumberField
                label={`Disk in GB for ${service}`}
                unit="GB"
                value={limit.diskGb ?? 0}
                min={LIMIT_BOUNDS.minDiskGb}
                onCommit={(diskGb) => change({ diskGb })}
              />
              <span className="text-xs text-muted-foreground">
                for files the container writes outside its volumes
              </span>
            </div>
          )}
        </Resource>
      )}
    </section>
  );
}

/** One resource: its title and an Unlimited switch, with the controls once it is capped. */
function Resource({
  icon,
  title,
  resource,
  service,
  on,
  disabled = false,
  note = null,
  onToggle,
  children,
}: {
  icon: React.ReactNode;
  title: string;
  resource: string;
  service: string;
  on: boolean;
  disabled?: boolean;
  note?: string | null;
  onToggle: (capped: boolean) => void;
  children: React.ReactNode;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className={cn(SECTION_WELL, 'space-y-2.5')}>
      <div className="flex items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm font-medium [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
          {icon}
          {title}
        </span>
        <span className="flex items-center gap-2">
          <Label htmlFor={id} className="text-xs text-muted-foreground">
            Unlimited
          </Label>
          <Switch
            id={id}
            aria-label={`Unlimited ${resource} for ${service}`}
            checked={!on}
            disabled={disabled}
            onCheckedChange={(unlimited) => onToggle(!unlimited)}
          />
        </span>
      </div>
      {note && <p className="text-xs text-muted-foreground">{note}</p>}
      {on && children}
    </div>
  );
}

function SliderRow({
  label,
  caption,
  value,
  min,
  max,
  step,
  text,
  onValueChange,
}: {
  label: string;
  caption: string;
  value: number;
  min: number;
  max: number;
  step: number;
  text: string;
  onValueChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <div className="grid grid-cols-[5.5rem_1fr_6.5rem] items-center gap-3">
      <span className="text-xs text-muted-foreground">{caption}</span>
      <Slider
        aria-label={label}
        value={value}
        min={min}
        max={max}
        step={step}
        valueLabel={text}
        onValueChange={onValueChange}
      />
      <span className="text-right text-xs tabular-nums">{text}</span>
    </div>
  );
}

/**
 * A whole number typed in: each keystroke that makes a number in range is taken at once, and
 * anything else waits, then goes back to the last good value when the field loses focus.
 */
function WholeNumberField({
  label,
  unit,
  value,
  min,
  max,
  onCommit,
}: {
  label: string;
  unit: string;
  value: number;
  min: number;
  max?: number;
  onCommit: (value: number) => void;
}): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const [editing, setEditing] = useState(false);
  const shown = editing ? text : String(value);
  return (
    <span className="flex shrink-0 items-center gap-1.5">
      <Input
        type="number"
        aria-label={label}
        className="w-28"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={shown}
        onFocus={() => {
          setText(String(value));
          setEditing(true);
        }}
        onBlur={() => setEditing(false)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          setEditing(true);
          const number = Number(next);
          if (
            next !== '' &&
            Number.isInteger(number) &&
            number >= min &&
            (max === undefined || number <= max)
          ) {
            onCommit(number);
          }
        }}
      />
      <span className="text-xs text-muted-foreground">{unit}</span>
    </span>
  );
}
