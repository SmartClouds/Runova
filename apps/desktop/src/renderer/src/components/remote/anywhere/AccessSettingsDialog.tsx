import { MANAGE_GRANTABLE_SCOPES, type ManageScope } from '@runova/protocol';
import type { AnywherePermissions, AnywhereSettingsPatch, AnywhereState } from '@shared/anywhere';
import { passwordProblem, passwordStrength } from '@shared/anywherePassword';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { Key, Monitor, Power, Route, Users, X } from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { TrustedPhones } from './TrustedPhones';

const STRENGTH = ['', 'Weak', 'Fair', 'Good', 'Strong'] as const;

/**
 * Who may reach this computer and how (E61). Everything starts off; each way in is turned on
 * here on purpose, and the defaults for a new session can be narrowed before anyone connects.
 */
export function AccessSettingsDialog({
  state,
  open,
  onOpenChange,
}: {
  state: AnywhereState;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const settings = state.settings;
  const update = (patch: AnywhereSettingsPatch) =>
    void window.runova.anywhere
      .updateSettings(patch)
      .catch((error: unknown) => toast.error(String(error)));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Who can connect to this computer</DialogTitle>
          <DialogDescription>
            Nothing is allowed until you turn it on. Whoever connects shows at the top of the
            screen, and you can end it any time.
          </DialogDescription>
        </DialogHeader>

        {/* One body row: the dialog is a header, body and footer grid. */}
        <div className="-mr-3 min-h-0 space-y-4 overflow-y-auto pr-3">
          <Section title="Ways in">
            <ToggleRow
              label="Allow connections to this computer"
              description="Off declines every request, whatever else is on below."
              checked={settings.acceptConnections}
              onChange={(acceptConnections) => update({ acceptConnections })}
            />
            <ToggleRow
              label="My other computers connect without asking"
              description="Computers signed in to your own Runova account."
              checked={settings.allowOwnDevices}
              onChange={(allowOwnDevices) => update({ allowOwnDevices })}
            />
          </Section>

          <Section title="Teammates who can ask" icon={Users}>
            {state.teams.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                You are not in a team yet. Make one or accept an invitation on the Account page.
              </p>
            ) : (
              <div className="space-y-2">
                {state.teams.map((team) => {
                  const id = `anywhere-team-${team.id}`;
                  const checked = settings.teamIds.includes(team.id);
                  return (
                    <div key={team.id} className="flex items-center gap-2">
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={(value) =>
                          update({
                            teamIds:
                              value === true
                                ? [...settings.teamIds, team.id]
                                : settings.teamIds.filter((t) => t !== team.id),
                          })
                        }
                      />
                      <Label htmlFor={id} className="text-[13px] font-normal">
                        {team.name}
                      </Label>
                    </div>
                  );
                })}
                <p className="text-xs text-muted-foreground">
                  Members see this computer and can ask. Someone here accepts each time.
                </p>
              </div>
            )}
            {settings.alwaysAllow.length > 0 ? (
              <div className="space-y-1.5 pt-2">
                <div className="text-[12px] font-medium">Let in without asking</div>
                <ul className="flex flex-wrap gap-1.5">
                  {settings.alwaysAllow.map((person) => (
                    <li
                      key={person.userId}
                      className="inline-flex h-7 items-center gap-1 rounded-full bg-foreground/[0.06] pl-3 pr-1 text-xs"
                    >
                      {person.displayName || `Account ${person.userId}`}
                      <button
                        type="button"
                        aria-label={`Stop letting ${person.displayName || `account ${person.userId}`} in without asking`}
                        onClick={() => update({ removeAlwaysAllow: [person.userId] })}
                        className="flex h-5 w-5 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
          </Section>

          <Section title="Unattended access" icon={Key}>
            <PasswordSetting set={settings.passwordSet} canKeepSecrets={settings.canKeepSecrets} />
          </Section>

          <Section title="When no one is signed in" icon={Power}>
            <AgentSetting state={state} />
          </Section>

          <Section title="A new session may">
            <PermissionToggles
              value={settings.defaultPermissions}
              onChange={(defaultPermissions) => update({ defaultPermissions })}
            />
          </Section>

          <Section title="Phones" icon={Monitor}>
            <TrustedPhones phones={state.trustedPhones} />
          </Section>

          <Section title="Privacy" icon={Route}>
            <ToggleRow
              label="Always connect through the Runova relay"
              description="Slower, but the other computer never learns this computer's network address. Still encrypted end to end."
              checked={settings.alwaysRelay}
              onChange={(alwaysRelay) => update({ alwaysRelay })}
            />
          </Section>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export function PermissionToggles({
  value,
  onChange,
}: {
  value: AnywherePermissions;
  onChange: (value: AnywherePermissions) => void;
}): React.JSX.Element {
  return (
    <>
      <ToggleRow
        label="Use the mouse and keyboard"
        description="Off makes it view only."
        checked={value.control}
        onChange={(control) => onChange({ ...value, control })}
      />
      <ToggleRow
        label="Share the clipboard"
        checked={value.clipboard}
        onChange={(clipboard) => onChange({ ...value, clipboard })}
      />
      <ToggleRow
        label="Send and receive files"
        checked={value.files}
        onChange={(files) => onChange({ ...value, files })}
      />
    </>
  );
}

const SCOPE_LABELS: Record<ManageScope, { label: string; description: string }> = {
  core: { label: 'Basics', description: 'See this computer and its projects.' },
  terminal: { label: 'Terminals and CLIs', description: 'See them and send them commands.' },
  git: { label: 'Git', description: 'See changes, commit and push.' },
  vault: { label: 'The Vault', description: 'Open saved secrets after unlocking it.' },
  deploy: {
    label: 'Deploy and servers',
    description: 'See servers and restart what runs on them.',
  },
  ops: { label: 'Monitoring and pipelines', description: 'See checks and CI, and start runs.' },
  control: { label: 'Control the screen', description: 'See the screen and use the mouse.' },
  files: { label: 'Files', description: 'Send and receive files.' },
};

/** What a phone may do on this computer, always written in the same order. */
export function ManageScopeToggles({
  value,
  onChange,
}: {
  value: ManageScope[];
  onChange: (value: ManageScope[]) => void;
}): React.JSX.Element {
  const toggle = (scope: ManageScope, on: boolean) =>
    onChange(MANAGE_GRANTABLE_SCOPES.filter((s) => (s === scope ? on : value.includes(s))));
  return (
    <>
      {MANAGE_GRANTABLE_SCOPES.map((scope) => (
        <ToggleRow
          key={scope}
          label={SCOPE_LABELS[scope].label}
          description={SCOPE_LABELS[scope].description}
          checked={value.includes(scope)}
          onChange={(on) => toggle(scope, on)}
        />
      ))}
    </>
  );
}

/** The background service that keeps the computer reachable on the lock and sign-in screens (E64). */
function AgentSetting({ state }: { state: AnywhereState }): React.JSX.Element {
  const { installed, unavailableReason } = state.settings.agent;
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();

  async function run(action: () => Promise<void>, done: string): Promise<void> {
    setBusy(true);
    try {
      await action();
      setAsking(false);
      setPassword('');
      toast.success(done);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  function toggle(on: boolean): void {
    if (!on) {
      void run(() => window.runova.anywhere.disableAgent(), 'Background service turned off');
    } else if (state.settings.passwordSet) {
      setAsking(true);
    } else {
      void run(() => window.runova.anywhere.enableAgent(undefined), 'Background service turned on');
    }
  }

  return (
    <div className="space-y-2.5">
      <ToggleRow
        label="Keep this computer reachable while no one is signed in"
        description="A small service that starts with this computer answers on its sign-in screen, for your own computers, teammates you always let in, and the password. Your computer asks for permission to set it up."
        checked={installed || asking}
        disabled={!!unavailableReason || busy}
        onChange={toggle}
      />
      {unavailableReason ? (
        <p className="text-xs text-muted-foreground">{unavailableReason}</p>
      ) : null}
      {asking ? (
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (password)
              void run(
                () => window.runova.anywhere.enableAgent(password),
                'Background service turned on',
              );
          }}
        >
          <Input
            id={id}
            aria-label="Password, for the background service"
            type="password"
            autoComplete="off"
            placeholder="This computer's unattended-access password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button type="submit" shape="pill" disabled={!password || busy}>
            Turn on
          </Button>
        </form>
      ) : null}
    </div>
  );
}

function PasswordSetting({
  set,
  canKeepSecrets,
}: {
  set: boolean;
  canKeepSecrets: boolean;
}): React.JSX.Element {
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const id = useId();
  const problem = password ? passwordProblem(password) : null;
  const strength = passwordStrength(password);

  async function save(next: string | null): Promise<void> {
    setBusy(true);
    try {
      await window.runova.anywhere.setPassword(next);
      setPassword('');
      toast.success(next ? 'Password set' : 'Password removed');
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2.5">
      <p className="text-xs text-muted-foreground">
        Anyone signed in to Runova who has this computer's ID and the password can connect without
        anyone here accepting. The password never leaves this computer.
      </p>
      {set ? (
        <div className="flex items-center justify-between gap-3 rounded-xl bg-success/8 px-3 py-2 ring-1 ring-success/25">
          <span className="text-[13px] font-medium">A password is set</span>
          <Button
            size="sm"
            variant="danger"
            shape="pill"
            disabled={busy}
            onClick={() => void save(null)}
          >
            Remove password
          </Button>
        </div>
      ) : null}
      {canKeepSecrets ? null : (
        <p className="text-xs text-warning">
          This computer has no keychain to keep the password secret in, so no password can be set
          here.
        </p>
      )}
      <form
        className="space-y-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (!problem && password) void save(password);
        }}
      >
        <Label htmlFor={id}>{set ? 'Change to' : 'New password'}</Label>
        <div className="flex gap-2">
          <Input
            id={id}
            aria-label="New password"
            type="password"
            autoComplete="new-password"
            value={password}
            disabled={!canKeepSecrets}
            onChange={(event) => setPassword(event.target.value)}
          />
          <Button
            type="submit"
            shape="pill"
            disabled={!password || !!problem || busy || !canKeepSecrets}
          >
            {set ? 'Change password' : 'Set password'}
          </Button>
        </div>
        {password ? (
          <div className="flex items-center gap-2">
            <div
              role="meter"
              aria-label="Password strength"
              aria-valuemin={0}
              aria-valuemax={4}
              aria-valuenow={strength}
              className="flex flex-1 gap-1"
            >
              {[1, 2, 3, 4].map((bar) => (
                <span
                  key={bar}
                  className={cn(
                    'h-1 flex-1 rounded-full transition-colors',
                    bar <= strength
                      ? strength <= 1
                        ? 'bg-destructive'
                        : strength === 2
                          ? 'bg-warning'
                          : 'bg-success'
                      : 'bg-foreground/10',
                  )}
                />
              ))}
            </div>
            <span className="w-12 text-right text-[11px] text-muted-foreground">
              {STRENGTH[strength]}
            </span>
          </div>
        ) : null}
        {problem ? <p className="text-xs text-destructive">{problem}</p> : null}
      </form>
    </div>
  );
}

function Section({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-2.5 border-t border-foreground/[0.06] pt-4 first-of-type:border-t-0 first-of-type:pt-0">
      <h3 className={cn(SECTION_HEADING, 'flex items-center gap-1.5')}>
        {Icon ? <Icon className="h-3 w-3" /> : null}
        {title}
      </h3>
      {children}
    </section>
  );
}

function ToggleRow({
  label,
  description,
  checked,
  disabled = false,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-4">
      <div className="space-y-0.5">
        <Label htmlFor={id} className="text-[13px] font-medium">
          {label}
        </Label>
        {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      </div>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  );
}
