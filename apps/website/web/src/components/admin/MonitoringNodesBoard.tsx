import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { apiRequest, type Problem } from '@/lib/admin/api';
import {
  ago,
  type CreatedNode,
  type EnrollmentToken,
  emptyNodeForm,
  fromNode,
  lagLabel,
  type MonitoringNode,
  type NodeForm,
  type NodeTone,
  nodeBody,
  nodeEnv,
  nodeTone,
  summarize,
  TONE_LABELS,
  until,
} from '@/lib/admin/monitoringNodes';
import { errorsFor } from '@/lib/admin/problems';
import { cn } from '@/lib/utils';
import nodeCompose from '../../../../monitoring-node/compose.yaml?raw';
import { ConfirmButton } from './ConfirmButton';
import { Field } from './Field';

/** How often the board asks again; heartbeats come every 10 seconds. */
const REFRESH_MS = 5_000;

const DOT: Record<NodeTone, string> = {
  online: 'bg-success shadow-[0_0_0_4px_hsl(var(--success)/0.18)]',
  draining: 'bg-warning shadow-[0_0_0_4px_hsl(var(--warning)/0.18)]',
  offline: 'bg-destructive shadow-[0_0_0_4px_hsl(var(--destructive)/0.18)]',
  pending: 'bg-muted-foreground/60',
  revoked: 'bg-muted-foreground/30',
};

/**
 * Monitoring nodes for Admins (E54): a live grid of the nodes with what each is doing, a way to
 * add one (with its one-time token and the files to run it), and drain, revoke and remove.
 */
export default function MonitoringNodesBoard() {
  const [nodes, setNodes] = useState<MonitoringNode[] | null>(null);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [adding, setAdding] = useState(false);
  const [enrollment, setEnrollment] = useState<{ name: string; token: EnrollmentToken } | null>(
    null,
  );
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    const response = await apiRequest<MonitoringNode[]>('/monitoring-nodes');
    if (response.ok) {
      setNodes(response.value);
      setProblem(null);
    } else {
      setProblem(response.problem);
    }
    setNow(Date.now());
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  const counts = nodes ? summarize(nodes) : null;
  const active = nodes?.filter((n) => n.status !== 'revoked') ?? [];
  const revoked = nodes?.filter((n) => n.status === 'revoked') ?? [];

  return (
    <div className="grid gap-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        {counts ? (
          <dl className="flex flex-wrap gap-2" aria-label="Fleet">
            <Stat label="Online" value={counts.online} tone="online" />
            {counts.draining > 0 && (
              <Stat label="Draining" value={counts.draining} tone="draining" />
            )}
            <Stat label="Offline" value={counts.offline} tone="offline" />
            {counts.pending > 0 && <Stat label="Waiting" value={counts.pending} tone="pending" />}
            <Stat label="Monitors" value={counts.monitors} />
            <Stat label="Checks a minute" value={counts.checksPerMinute} />
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">Loading the nodes…</p>
        )}
        <Button type="button" onClick={() => setAdding(true)}>
          Add node
        </Button>
      </div>

      {problem && (
        <p className="font-medium text-destructive text-sm">{problem.detail || problem.title}</p>
      )}
      {message && (
        <p role="status" className="font-medium text-sm text-success">
          {message}
        </p>
      )}

      {nodes && active.length === 0 && (
        <div className="grid justify-items-start gap-2 rounded-box border border-dashed p-8">
          <h2 className="font-semibold text-lg">No nodes yet</h2>
          <p className="max-w-prose text-muted-foreground text-sm">
            Online monitors are checked by nodes: small containers on servers of yours, in the
            regions you want checks from. Add one, then run it with Docker on its server. It
            connects out to the gateway; nothing on the server needs to be open.
          </p>
        </div>
      )}

      {active.length > 0 && (
        <ul className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {active.map((node) => (
            <li key={node.id}>
              <NodeCard
                node={node}
                now={now}
                onChanged={(text) => {
                  setMessage(text);
                  void load();
                }}
                onToken={(token) => setEnrollment({ name: node.name, token })}
                onProblem={setProblem}
              />
            </li>
          ))}
        </ul>
      )}

      {revoked.length > 0 && (
        <details className="rounded-box border p-4">
          <summary className="cursor-pointer font-medium text-muted-foreground text-sm">
            {revoked.length === 1 ? '1 revoked node' : `${revoked.length} revoked nodes`}
          </summary>
          <ul className="mt-3 grid gap-2">
            {revoked.map((node) => (
              <li
                key={node.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-inner bg-muted/20 px-3 py-2 text-sm"
              >
                <span>
                  <span className="font-medium">{node.name}</span>
                  <span className="text-muted-foreground">
                    {' '}
                    · {node.region} · revoked {ago(node.revokedAt, now)}
                  </span>
                </span>
                <RemoveButton
                  node={node}
                  onRemoved={() => {
                    setMessage(`${node.name} was removed.`);
                    void load();
                  }}
                  onProblem={setProblem}
                />
              </li>
            ))}
          </ul>
        </details>
      )}

      <AddNodeDialog
        open={adding}
        onOpenChange={setAdding}
        onCreated={(created) => {
          setAdding(false);
          setEnrollment({ name: created.node.name, token: created.enrollment });
          void load();
        }}
      />
      <EnrollmentDialog enrollment={enrollment} onClose={() => setEnrollment(null)} />
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: NodeTone }) {
  return (
    <div className="flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm">
      {tone && <span aria-hidden className={cn('size-2 rounded-full', DOT[tone])} />}
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono font-semibold tabular-nums">{value.toLocaleString('en-US')}</dd>
    </div>
  );
}

interface NodeCardProps {
  node: MonitoringNode;
  now: number;
  onChanged: (message: string) => void;
  onToken: (token: EnrollmentToken) => void;
  onProblem: (problem: Problem | null) => void;
}

function NodeCard({ node, now, onChanged, onToken, onProblem }: NodeCardProps) {
  const tone = nodeTone(node);
  const [editing, setEditing] = useState(false);
  const [editProblem, setEditProblem] = useState<Problem | null>(null);
  const headingId = `node-${node.id}`;

  const patch = async (body: Record<string, unknown>, done: string) => {
    const response = await apiRequest(`/monitoring-nodes/${node.id}`, {
      method: 'PATCH',
      body,
      ifMatch: `"${node.version}"`,
    });
    if (!response.ok) {
      // A field's own error shows under it; anything else at the top of the board.
      if (editing && response.problem.status === 400) setEditProblem(response.problem);
      else onProblem(response.problem);
      return false;
    }
    setEditProblem(null);
    onProblem(null);
    onChanged(done);
    return true;
  };

  const newToken = async () => {
    const response = await apiRequest<EnrollmentToken>(
      `/monitoring-nodes/${node.id}/enrollment-tokens`,
      { method: 'POST' },
    );
    if (response.ok) onToken(response.value);
    else onProblem(response.problem);
  };

  const revoke = async () => {
    const response = await apiRequest(`/monitoring-nodes/${node.id}/revocations`, {
      method: 'POST',
    });
    if (response.ok)
      onChanged(`${node.name} was revoked. Its stream is closed and its certificate refused.`);
    else onProblem(response.problem);
  };

  return (
    <article
      aria-labelledby={headingId}
      className="grid h-full gap-4 rounded-box border bg-card p-5"
    >
      <header className="flex items-start justify-between gap-3">
        <div className="grid gap-1">
          <h2 id={headingId} className="flex items-center gap-2.5 font-semibold text-lg">
            <span aria-hidden className={cn('size-2.5 shrink-0 rounded-full', DOT[tone])} />
            {node.name}
          </h2>
          <p className="text-muted-foreground text-sm">
            <span className="sr-only">Status: </span>
            {TONE_LABELS[tone]}
            {node.status !== 'pending' && <> · seen {ago(node.lastSeenAt, now)}</>}
          </p>
        </div>
        <span className="rounded-full bg-muted/40 px-2.5 py-1 font-mono text-xs">
          {node.region}
        </span>
      </header>

      {node.status === 'pending' ? (
        <p className="rounded-inner bg-muted/20 p-3 text-sm">
          {node.enrollmentTokenExpiresAt
            ? `Its token works ${until(node.enrollmentTokenExpiresAt, now)}. Start the node with it.`
            : 'Its token ran out. Make a new one to enroll it.'}
        </p>
      ) : (
        <dl className="grid grid-cols-3 gap-2">
          <Tile label="Monitors" value={String(node.monitors)} />
          <Tile label="Checks/min" value={String(node.checksLastMinute)} />
          <Tile
            label="Waiting"
            value={String(node.queuedResults)}
            warn={node.queuedResults > 500}
          />
          <Tile label="Timing" value={lagLabel(node.lagMs)} warn={node.lagMs >= 5000} />
          <Tile label="Capacity" value={String(node.capacity)} />
          <Tile
            label="Certificate"
            value={until(node.certificateExpiresAt, now)}
            warn={tone !== 'offline' && !node.certificateExpiresAt}
          />
        </dl>
      )}

      <p className="text-muted-foreground text-xs">
        {[
          node.softwareVersion && `v${node.softwareVersion}`,
          node.remoteAddress,
          node.allowedAddresses.length > 0 &&
            `${node.allowedAddresses.length} allowed address${node.allowedAddresses.length === 1 ? '' : 'es'}`,
        ]
          .filter(Boolean)
          .join(' · ') || 'Not connected yet'}
      </p>

      {editing ? (
        <EditForm
          node={node}
          problem={editProblem}
          onCancel={() => {
            setEditProblem(null);
            setEditing(false);
          }}
          onSave={async (form) => {
            if (await patch(nodeBody(form), `${form.name.trim() || node.name} was saved.`))
              setEditing(false);
          }}
        />
      ) : (
        <div className="mt-auto flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => setEditing(true)}>
            Edit <span className="sr-only">{node.name}</span>
          </Button>
          {node.status === 'online' && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                void patch(
                  { draining: !node.draining },
                  node.draining
                    ? `${node.name} takes monitors again.`
                    : `${node.name} is draining.`,
                )
              }
            >
              {node.draining ? 'Undrain' : 'Drain'} <span className="sr-only">{node.name}</span>
            </Button>
          )}
          <Button type="button" variant="outline" size="sm" onClick={() => void newToken()}>
            New token <span className="sr-only">for {node.name}</span>
          </Button>
          {node.status === 'pending' ? (
            <RemoveButton
              node={node}
              onRemoved={() => onChanged(`${node.name} was removed.`)}
              onProblem={onProblem}
            />
          ) : (
            <ConfirmButton
              label={`Revoke ${node.name}`}
              title={`Revoke ${node.name}?`}
              description="Its stream closes at once, its certificates are refused from now on and its monitors move to the other nodes. A revoked node can not come back: add a new one instead."
              confirmLabel="Revoke"
              onConfirm={() => void revoke()}
            />
          )}
        </div>
      )}
    </article>
  );
}

function Tile({ label, value, warn = false }: { label: string; value: string; warn?: boolean }) {
  return (
    <div className="grid gap-0.5 rounded-inner bg-muted/20 px-3 py-2">
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className={cn('font-mono font-semibold text-sm tabular-nums', warn && 'text-warning')}>
        {value}
      </dd>
    </div>
  );
}

function RemoveButton({
  node,
  onRemoved,
  onProblem,
}: {
  node: MonitoringNode;
  onRemoved: () => void;
  onProblem: (p: Problem | null) => void;
}) {
  const remove = async () => {
    const response = await apiRequest(`/monitoring-nodes/${node.id}`, {
      method: 'DELETE',
      ifMatch: `"${node.version}"`,
    });
    if (response.ok) onRemoved();
    else onProblem(response.problem);
  };
  return (
    <ConfirmButton
      label={`Remove ${node.name}`}
      title={`Remove ${node.name}?`}
      description="It is taken off this list for good."
      confirmLabel="Remove"
      onConfirm={() => void remove()}
    />
  );
}

function NodeFields({
  form,
  setForm,
  problem,
  prefix,
  autoFocus = false,
}: {
  form: NodeForm;
  setForm: (form: NodeForm) => void;
  problem: Problem | null;
  prefix: string;
  autoFocus?: boolean;
}) {
  const errors = problem?.errors ?? {};
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field id={`${prefix}-name`} label="Name" errors={errorsFor(errors, 'name')}>
        {(control) => (
          <Input
            {...control}
            autoFocus={autoFocus}
            value={form.name}
            placeholder="eu-1"
            onChange={(e) => setForm({ ...form, name: e.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${prefix}-region`}
        label="Region"
        hint="Nodes in other regions confirm each other."
        errors={errorsFor(errors, 'region')}
      >
        {(control) => (
          <Input
            {...control}
            value={form.region}
            placeholder="eu-central"
            onChange={(e) => setForm({ ...form, region: e.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${prefix}-capacity`}
        label="Capacity"
        hint="100 is a normal node; 200 takes twice as many checks."
        errors={errorsFor(errors, 'capacity')}
      >
        {(control) => (
          <Input
            {...control}
            inputMode="numeric"
            value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
          />
        )}
      </Field>
      <Field
        id={`${prefix}-addresses`}
        label="Allowed addresses"
        hint="One IP address or range a line. Empty lets it connect from anywhere."
        errors={errorsFor(errors, 'allowedAddresses')}
      >
        {(control) => (
          <Textarea
            {...control}
            rows={2}
            className="font-mono"
            value={form.allowedAddresses}
            onChange={(e) => setForm({ ...form, allowedAddresses: e.target.value })}
          />
        )}
      </Field>
    </div>
  );
}

function EditForm({
  node,
  problem,
  onCancel,
  onSave,
}: {
  node: MonitoringNode;
  problem: Problem | null;
  onCancel: () => void;
  onSave: (form: NodeForm) => Promise<void>;
}) {
  const [form, setForm] = useState(() => fromNode(node));
  return (
    <form
      className="grid gap-4 rounded-inner border p-4"
      onSubmit={(event) => {
        event.preventDefault();
        void onSave(form);
      }}
    >
      <NodeFields
        form={form}
        setForm={setForm}
        problem={problem}
        prefix={`edit-${node.id}`}
        autoFocus
      />
      <div className="flex gap-2">
        <Button type="submit" size="sm">
          Save
        </Button>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

function AddNodeDialog({
  open,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (created: CreatedNode) => void;
}) {
  const [form, setForm] = useState<NodeForm>(emptyNodeForm);
  const [problem, setProblem] = useState<Problem | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setForm(emptyNodeForm);
      setProblem(null);
    }
  }, [open]);

  const create = async () => {
    setBusy(true);
    const response = await apiRequest<CreatedNode>('/monitoring-nodes', {
      method: 'POST',
      body: nodeBody(form),
    });
    setBusy(false);
    if (!response.ok) {
      setProblem(response.problem);
      return;
    }
    onCreated(response.value);
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="sm:max-w-2xl">
        <form
          className="grid gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            void create();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Add a monitoring node</AlertDialogTitle>
            <AlertDialogDescription>
              You get a one-time token to start it with. It works once, within 24 hours.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <NodeFields form={form} setForm={setForm} problem={problem} prefix="new-node" autoFocus />
          {problem && problem.status !== 400 && (
            <p className="font-medium text-destructive text-sm">
              {problem.detail || problem.title}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel type="button">Cancel</AlertDialogCancel>
            <Button type="submit" disabled={busy}>
              Add node
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function EnrollmentDialog({
  enrollment,
  onClose,
}: {
  enrollment: { name: string; token: EnrollmentToken } | null;
  onClose: () => void;
}) {
  return (
    <AlertDialog open={enrollment !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <AlertDialogHeader>
          <AlertDialogTitle>Start {enrollment?.name}</AlertDialogTitle>
          <AlertDialogDescription>
            This token is shown once. On the node's server, save the two files below in one folder
            and run <code className="font-mono text-foreground">docker compose up -d</code>. The
            node enrolls, then connects out to the gateway; it opens no port.
          </AlertDialogDescription>
        </AlertDialogHeader>
        {enrollment && (
          <div className="grid gap-4">
            <Snippet
              label=".env"
              value={nodeEnv(enrollment.token)}
              note={`The token works until ${new Date(enrollment.token.expiresAt).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' })}, once.`}
            />
            <Snippet label="compose.yaml" value={nodeCompose} />
          </div>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel>Done</AlertDialogCancel>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** A block of text to copy whole. When the browser will not copy, the text is selected instead. */
function Snippet({ label, value, note }: { label: string; value: string; note?: string }) {
  const area = useRef<HTMLTextAreaElement>(null);
  const [status, setStatus] = useState<string | null>(null);
  const id = `snippet-${label.replace(/\W/g, '')}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setStatus(`${label} copied.`);
    } catch {
      area.current?.focus();
      area.current?.select();
      setStatus('The browser would not copy it. The text is selected: copy it by hand.');
    }
  };
  return (
    <div className="grid gap-2">
      <div className="flex items-center justify-between gap-2">
        <label htmlFor={id} className="font-medium font-mono text-sm">
          {label}
        </label>
        <Button type="button" variant="outline" size="sm" onClick={() => void copy()}>
          Copy <span className="sr-only">{label}</span>
        </Button>
      </div>
      <Textarea
        id={id}
        ref={area}
        readOnly
        spellCheck={false}
        rows={Math.min(14, value.split('\n').length)}
        value={value}
        className="font-mono text-xs"
        onFocus={(event) => event.target.select()}
      />
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
      <p role="status" className={cn('text-sm', !status && 'sr-only')}>
        {status}
      </p>
    </div>
  );
}
