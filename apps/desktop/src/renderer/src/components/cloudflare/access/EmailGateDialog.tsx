import {
  DEFAULT_EMAIL_GATE_SESSION,
  EMAIL_GATE_SESSIONS,
  emailGatePreview,
  peopleCount,
} from '@shared/cloudflare/emailGate';
import type {
  CloudflareZone,
  EmailGateHost,
  EmailGatePeople,
  EmailGateSession,
} from '@shared/cloudflareTypes';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { toast } from 'sonner';
import { ArrowRight, Inbox, Key, Lock, Monitor, Spinner } from '@/components/icons';
import { Notice } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { cloudflareFailureText } from '@/lib/cloudflare/feedback';
import { SegmentedChoice } from '../fields';
import { PeopleChips } from './PeopleChips';
import { confirmTurnOff, EMAIL_GATE_KEY, roleText } from './parts';

/** Where the last list of people used is kept, per viewer, to start the next gate from. */
export const LAST_PEOPLE_KEY = 'runova:email-gate-last-people';

function readLastPeople(): EmailGatePeople | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(LAST_PEOPLE_KEY) ?? 'null') as unknown;
    const people = parsed as Partial<EmailGatePeople> | null;
    if (!people || !Array.isArray(people.emails) || !Array.isArray(people.emailDomains)) {
      return null;
    }
    const strings = (list: unknown[]) =>
      list.filter((item): item is string => typeof item === 'string');
    const result = { emails: strings(people.emails), emailDomains: strings(people.emailDomains) };
    return peopleCount(result) > 0 ? result : null;
  } catch {
    return null;
  }
}

function rememberPeople(people: EmailGatePeople): void {
  try {
    localStorage.setItem(LAST_PEOPLE_KEY, JSON.stringify(people));
  } catch {
    // A convenience only: the next gate simply starts empty.
  }
}

const STEPS = [
  { icon: Lock, text: 'They open the name' },
  { icon: Inbox, text: 'Cloudflare mails a code' },
  { icon: Key, text: 'The code lets them in' },
] as const;

/** What a visitor goes through, in three steps, so the gate is clear before it goes on. */
function VisitorSteps(): React.JSX.Element {
  return (
    <ol aria-label="What a visitor sees" className="grid grid-cols-3 gap-2">
      {STEPS.map((step, index) => {
        const Icon = step.icon;
        return (
          <li
            key={step.text}
            className="relative flex flex-col items-center gap-1.5 rounded-xl bg-foreground/[0.03] px-2 pb-2.5 pt-3 text-center text-xs text-foreground/80 ring-1 ring-inset ring-foreground/[0.06]"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/12 text-primary">
              <Icon className="h-3.5 w-3.5" />
            </span>
            <span>
              <span className="sr-only">Step {index + 1}: </span>
              {step.text}
            </span>
            {index < STEPS.length - 1 && (
              <ArrowRight
                aria-hidden
                className="absolute -right-[0.6rem] top-1/2 z-10 h-3 w-3 -translate-y-1/2 text-muted-foreground"
              />
            )}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Turns the email code gate on for a name, or changes it (E96): who may ask for a code, how long
 * they stay in, and a sentence that says it back. A new gate starts from the last list used; an
 * existing one shows its own. On the core domain it says that this computer keeps its own pass.
 */
export function EmailGateDialog({
  open,
  zone,
  host,
  onOpenChange,
}: {
  open: boolean;
  zone: CloudflareZone;
  host: EmailGateHost;
  onOpenChange: (open: boolean) => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const existing = host.gate.kind === 'on' ? host.gate : null;
  const [last] = useState(() => (existing ? null : readLastPeople()));
  const [people, setPeople] = useState<EmailGatePeople>(
    existing
      ? { emails: existing.emails, emailDomains: existing.emailDomains }
      : (last ?? { emails: [], emailDomains: [] }),
  );
  const [session, setSession] = useState<EmailGateSession>(
    existing?.session ?? DEFAULT_EMAIL_GATE_SESSION,
  );
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const fieldId = useId();
  const hintId = useId();
  const sessionId = useId();
  const count = peopleCount(people);
  const role = roleText(host);

  async function turnOff(): Promise<void> {
    if (!(await confirmTurnOff(host))) return;
    setSaving(true);
    setProblem(null);
    try {
      await window.runova.cloudflareEmailGate.remove({ zoneId: zone.id, hostname: host.hostname });
      await queryClient.invalidateQueries({ queryKey: EMAIL_GATE_KEY });
      toast.success(`${host.hostname} is open to everyone again.`);
      onOpenChange(false);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setSaving(false);
    }
  }

  async function save(): Promise<void> {
    setSaving(true);
    setProblem(null);
    try {
      await window.runova.cloudflareEmailGate.save({
        zoneId: zone.id,
        hostname: host.hostname,
        emails: people.emails,
        emailDomains: people.emailDomains,
        session,
      });
      rememberPeople(people);
      await queryClient.invalidateQueries({ queryKey: EMAIL_GATE_KEY });
      if (existing) {
        toast.success(`Saved the email code for ${host.hostname}.`);
      } else {
        toast.success(`${host.hostname} now asks for an email code.`, {
          description:
            'Try it in a private window: Cloudflare mails the code to the address you type.',
          action: {
            label: 'Open',
            onClick: () => void window.runova.shell.openExternal(`https://${host.hostname}`),
          },
        });
      }
      onOpenChange(false);
    } catch (error) {
      setProblem(cloudflareFailureText(error, queryClient));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent className="flex max-w-lg flex-col">
        {/* A column, not the dialog's three-row grid, so no empty rows pad the bottom. */}
        <form
          className="-m-1 flex min-h-0 flex-col gap-4 overflow-y-auto p-1"
          onSubmit={(event) => {
            event.preventDefault();
            if (count > 0 && !saving) void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {existing ? `Email code for ${host.hostname}` : 'Ask for an email code'}
            </DialogTitle>
            <DialogDescription>
              {existing ? (
                'Change who can get a code and how long they stay in.'
              ) : (
                <>
                  Before <span className="font-mono text-foreground">{host.hostname}</span> opens,
                  Cloudflare asks for an email address and mails a code to it. Only the people you
                  list get one.
                </>
              )}
              {role && <span className="mt-1 block text-xs">{role}</span>}
            </DialogDescription>
          </DialogHeader>

          {!existing && <VisitorSteps />}

          <div className="space-y-1.5">
            <Label htmlFor={fieldId}>Who can get a code</Label>
            <PeopleChips id={fieldId} value={people} onChange={setPeople} describedBy={hintId} />
            <p id={hintId} className="text-xs text-muted-foreground">
              {last && people === last ? 'Filled in from the last list you used. ' : ''}
              Press Enter after each one. A domain like @company.com lets in everyone there.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2">
            <span id={sessionId} className="text-sm font-medium text-foreground">
              Stay in for
            </span>
            <SegmentedChoice
              labelledBy={sessionId}
              layoutId={`email-gate-session-${host.hostname}`}
              options={EMAIL_GATE_SESSIONS}
              value={session}
              disabled={saving}
              onChange={setSession}
            />
          </div>

          <Notice tone={count > 0 ? 'primary' : 'neutral'} icon={Lock} size="sm" aria-live="polite">
            {emailGatePreview({ ...people, session }, host.hostname)}
          </Notice>

          {!host.serverId && (
            <Notice tone="warning" size="sm">
              The app can't see the server behind this name, so it can't check that only Cloudflare
              reaches it. If that server answers anyone, people who find its address skip the gate.
            </Notice>
          )}

          {host.role === 'core' && (
            <Notice tone="neutral" icon={Monitor} size="sm">
              {host.thisComputerPass
                ? 'This computer has its own pass, so the app keeps reaching the core without a code.'
                : 'This computer gets its own pass, so the app keeps reaching the core without a code.'}{' '}
              Another computer gets one with Let this computer through.
            </Notice>
          )}

          {problem && (
            <p role="alert" className="text-sm text-destructive">
              {problem}
            </p>
          )}

          <DialogFooter>
            {existing && (
              <Button
                type="button"
                variant="ghost"
                disabled={saving}
                className="text-destructive hover:text-destructive sm:mr-auto"
                onClick={() => void turnOff()}
              >
                Turn off
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={count === 0 || saving}>
              {saving && <Spinner className="h-3.5 w-3.5" />}
              {existing ? 'Save' : 'Turn on email code'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
