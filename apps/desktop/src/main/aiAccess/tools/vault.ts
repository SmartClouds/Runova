import type { SaveVaultEntryInput, VaultEntrySummary, VaultFieldRef } from '@runova/core';
import { z } from 'zod';
import type { AiApprovalPreview } from '../../../shared/aiAccessTypes';
import { getVaultService } from '../../vault';
import type { VaultService } from '../../vault/service';
import { defineTool } from '../registry';

/**
 * Vault tools: the entries in Runova's password vault, one secret revealed on request, and adding
 * or updating an entry. Everything goes through the same VaultService the Vault page uses. The
 * agent never unlocks the vault: a locked vault is refused, and the user unlocks it in the app.
 * Exporting and importing CSV files are deliberately not offered here.
 */

const LOCKED = 'Unlock the vault in Runova first, then try again.';

const entryArg = z
  .string()
  .min(1)
  .describe('The entry, by its title (any case) or id. vault_list lists them.');

const FIELDS = ['password', 'username', 'totpSecret', 'secret', 'keyId', 'notes', 'url'] as const;
type PlainField = (typeof FIELDS)[number];

const FIELD_LABELS: Record<PlainField, string> = {
  password: 'password',
  username: 'username',
  totpSecret: 'two-factor secret',
  secret: 'secret',
  keyId: 'key id',
  notes: 'notes',
  url: 'website',
};

const KIND_LABELS: Record<VaultEntrySummary['type'], string> = {
  login: 'A login',
  apiKey: 'An API key',
  note: 'A note',
  custom: 'A custom entry',
};

/** Which plain fields each kind of entry has. Custom entries have their own fields instead. */
const FIELDS_OF: Record<VaultEntrySummary['type'], readonly PlainField[]> = {
  login: ['password', 'username', 'totpSecret', 'notes', 'url'],
  apiKey: ['secret', 'keyId', 'notes', 'url'],
  note: ['notes'],
  custom: ['notes'],
};

/** The value revealed when the agent does not say which. */
const MAIN_FIELD: Record<VaultEntrySummary['type'], PlainField> = {
  login: 'password',
  apiKey: 'secret',
  note: 'notes',
  custom: 'notes',
};

function isLockedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { code?: unknown }).code === 'locked' &&
    error.name === 'VaultError'
  );
}

/** The vault, unlocked. Never prompts: a locked vault is the user's to open. */
async function openVault(): Promise<VaultService> {
  const service = getVaultService();
  const { state } = await service.status();
  if (state === 'uninitialized') {
    throw new Error('Runova has no vault yet. The user can set one up on the Vault page.');
  }
  if (state !== 'unlocked') throw new Error(LOCKED);
  return service;
}

/** Runs `work` on the unlocked vault, turning a lock that lands meanwhile into the same refusal. */
async function withVault<T>(work: (service: VaultService) => T | Promise<T>): Promise<T> {
  const service = await openVault();
  try {
    return await work(service);
  } catch (error) {
    if (isLockedError(error)) throw new Error(LOCKED);
    throw error;
  }
}

function findEntry(service: VaultService, ref: string): VaultEntrySummary {
  const entries = service.list();
  const byId = entries.find((one) => one.id === ref);
  if (byId) return byId;
  const wanted = ref.trim().toLowerCase();
  const named = entries.filter((one) => one.title.trim().toLowerCase() === wanted);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    throw new Error(
      `${named.length} vault entries are titled ${ref}. Pass one of these ids: ${named.map((one) => one.id).join(', ')}.`,
    );
  }
  throw new Error(`No vault entry titled ${ref}. vault_list lists them.`);
}

/** The field to reveal: the one asked for, a custom field by its label, or the entry's main one. */
function fieldRefFor(
  entry: VaultEntrySummary,
  field: PlainField | undefined,
  customField: string | undefined,
): { ref: VaultFieldRef; label: string } {
  if (customField !== undefined) {
    const wanted = customField.trim().toLowerCase();
    const found = entry.fields.find((one) => one.label.trim().toLowerCase() === wanted);
    if (!found) {
      const labels = entry.fields.map((one) => one.label).join(', ') || 'none';
      throw new Error(`${entry.title} has no field called ${customField}. Its fields: ${labels}.`);
    }
    return { ref: { customFieldId: found.id }, label: found.label };
  }
  if (!field && entry.type === 'custom') {
    const concealed = entry.fields.filter((one) => one.concealed);
    const only =
      concealed.length === 1 ? concealed[0] : entry.fields.length === 1 ? entry.fields[0] : null;
    if (only) return { ref: { customFieldId: only.id }, label: only.label };
    const labels = entry.fields.map((one) => one.label).join(', ') || 'none';
    throw new Error(
      `Say which field of ${entry.title} to reveal with customField. Its fields: ${labels}.`,
    );
  }
  const chosen = field ?? MAIN_FIELD[entry.type];
  if (!FIELDS_OF[entry.type].includes(chosen)) {
    throw new Error(`${entry.title} has no ${FIELD_LABELS[chosen]}.`);
  }
  return { ref: chosen, label: FIELD_LABELS[chosen] };
}

/** What an agent may set on an entry. Any left out stays as it is. */
const valueShape = {
  username: z.string().max(1024).optional(),
  password: z
    .string()
    .max(64 * 1024)
    .optional(),
  urls: z.array(z.string().min(1).max(2048)).max(20).optional().describe('Website addresses.'),
  service: z.string().max(1024).optional().describe('API keys: the service the key is for.'),
  keyId: z.string().max(1024).optional().describe('API keys: the public key id.'),
  secret: z
    .string()
    .max(64 * 1024)
    .optional()
    .describe('API keys: the secret key.'),
  notes: z
    .string()
    .max(64 * 1024)
    .optional(),
  tags: z.array(z.string().min(1).max(40)).max(20).optional(),
};
type Values = { [K in keyof typeof valueShape]?: z.infer<(typeof valueShape)[K]> };

const VALUE_KINDS: Record<
  'username' | 'password' | 'urls' | 'service' | 'keyId' | 'secret',
  readonly VaultEntrySummary['type'][]
> = {
  username: ['login'],
  password: ['login'],
  urls: ['login', 'apiKey'],
  service: ['apiKey'],
  keyId: ['apiKey'],
  secret: ['apiKey'],
};

const VALUE_LABELS: Record<keyof typeof VALUE_KINDS, string> = {
  username: 'username',
  password: 'password',
  urls: 'website',
  service: 'service',
  keyId: 'key id',
  secret: 'secret',
};

/** Refuses a value the kind of entry cannot hold, rather than dropping it without a word. */
function checkValuesFit(kind: VaultEntrySummary['type'], values: Values): void {
  for (const key of Object.keys(VALUE_KINDS) as (keyof typeof VALUE_KINDS)[]) {
    if (values[key] !== undefined && !VALUE_KINDS[key].includes(kind)) {
      throw new Error(`${KIND_LABELS[kind]} has no ${VALUE_LABELS[key]}.`);
    }
  }
}

/** The kind-specific part of a save. Undefined values keep what is stored. */
function kindPart(
  entry: { type: VaultEntrySummary['type']; fields?: VaultEntrySummary['fields'] },
  values: Values,
) {
  switch (entry.type) {
    case 'login':
      return {
        type: 'login' as const,
        username: values.username,
        password: values.password,
        urls: values.urls,
      };
    case 'apiKey':
      return {
        type: 'apiKey' as const,
        service: values.service,
        keyId: values.keyId,
        secret: values.secret,
        urls: values.urls,
      };
    case 'note':
      return { type: 'note' as const };
    case 'custom':
      return {
        type: 'custom' as const,
        // Values left out, so each field keeps what it holds.
        fields: (entry.fields ?? []).map(({ id, label, concealed }) => ({ id, label, concealed })),
      };
  }
}

/** The approval dialog's rows for the values being set, secrets marked so they stay hidden. */
function valueFields(values: Values): NonNullable<AiApprovalPreview['fields']> {
  const rows: NonNullable<AiApprovalPreview['fields']> = [];
  if (values.username !== undefined) rows.push({ label: 'Username', value: values.username });
  if (values.password !== undefined) {
    rows.push({ label: 'Password', value: values.password, secret: true });
  }
  if (values.urls !== undefined) rows.push({ label: 'Website', value: values.urls.join(', ') });
  if (values.service !== undefined) rows.push({ label: 'Service', value: values.service });
  if (values.keyId !== undefined) rows.push({ label: 'Key id', value: values.keyId, mono: true });
  if (values.secret !== undefined)
    rows.push({ label: 'Secret', value: values.secret, secret: true });
  if (values.notes !== undefined) rows.push({ label: 'Notes', value: values.notes, secret: true });
  if (values.tags !== undefined) rows.push({ label: 'Tags', value: values.tags.join(', ') });
  return rows;
}

export const vaultTools = [
  defineTool({
    name: 'vault_list',
    area: 'vault',
    title: 'List vault entries',
    description:
      'The entries in the Runova vault: title, kind (login, apiKey, note, custom), username, websites, tags and which secrets are filled in. No passwords, secrets or notes are included. The vault must be unlocked in Runova.',
    risk: 'read',
    input: z.object({
      search: z
        .string()
        .max(200)
        .optional()
        .describe('Only entries whose title, username, service, website or tags contain this.'),
    }),
    preview: () => ({ title: 'List the vault entries' }),
    run: (args) =>
      withVault((service) => {
        const wanted = args.search?.trim().toLowerCase();
        const entries = service
          .list()
          .filter(
            (entry) =>
              !wanted ||
              [entry.title, entry.username, entry.service, ...entry.urls, ...entry.tags].some(
                (text) => text.toLowerCase().includes(wanted),
              ),
          );
        return {
          data: entries.map((entry) => ({
            id: entry.id,
            title: entry.title,
            kind: entry.type,
            username: entry.username || undefined,
            service: entry.service || undefined,
            urls: entry.urls,
            tags: entry.tags,
            favorite: entry.favorite,
            hasPassword: entry.hasPassword,
            hasTotp: entry.hasTotp,
            hasSecret: entry.hasSecret,
            hasNotes: entry.hasNotes,
            customFields: entry.fields.map((field) => field.label),
            updatedAt: new Date(entry.updatedAt).toISOString(),
          })),
        };
      }),
  }),

  defineTool({
    name: 'vault_reveal',
    area: 'vault',
    title: 'Reveal a vault secret',
    description:
      "Gives one value of a vault entry in plain text: its password, an API key's secret, a note, or the field named. Without a field it reveals the entry's main secret. Only ask when the task needs the value.",
    risk: 'sensitive',
    input: z.object({
      entry: entryArg,
      field: z.enum(FIELDS).optional(),
      customField: z
        .string()
        .max(100)
        .optional()
        .describe('Custom entries: the label of the field to reveal.'),
    }),
    preview: (args) =>
      withVault((service) => {
        const entry = findEntry(service, args.entry);
        const { label } = fieldRefFor(entry, args.field, args.customField);
        return {
          title: `Reveal the ${label} of ${entry.title}`,
          summary: 'The agent will see this value in plain text.',
        };
      }),
    run: (args) =>
      withVault((service) => {
        const entry = findEntry(service, args.entry);
        const { ref, label } = fieldRefFor(entry, args.field, args.customField);
        const value = service.reveal(entry.id, ref);
        return { text: value === '' ? `The ${label} of ${entry.title} is empty.` : value };
      }),
  }),

  defineTool({
    name: 'vault_add_entry',
    area: 'vault',
    title: 'Add a vault entry',
    description:
      'Adds a new entry to the vault: a login (username, password, websites), an API key (service, key id, secret) or a note. It never replaces an existing entry; use vault_update_entry for that.',
    risk: 'write',
    input: z.object({
      kind: z.enum(['login', 'apiKey', 'note']),
      title: z.string().trim().min(1).max(200),
      ...valueShape,
    }),
    preview(args) {
      checkValuesFit(args.kind, args);
      return {
        title: `Add ${args.title} to the vault`,
        fields: [{ label: 'Kind', value: args.kind }, ...valueFields(args)],
      };
    },
    run: (args) =>
      withVault(async (service) => {
        checkValuesFit(args.kind, args);
        const input = {
          title: args.title,
          tags: args.tags ?? [],
          favorite: false,
          notes: args.notes ?? '',
          ...kindPart({ type: args.kind }, args),
        } as SaveVaultEntryInput;
        const saved = await service.save(input);
        return { text: `Added ${saved.title} to the vault (id ${saved.id}).` };
      }),
  }),

  defineTool({
    name: 'vault_update_entry',
    area: 'vault',
    title: 'Update a vault entry',
    description:
      'Changes an existing vault entry. Only the values given are replaced; everything else stays as it is. Overwritten passwords and secrets cannot be recovered.',
    risk: 'sensitive',
    input: z.object({
      entry: entryArg,
      title: z.string().trim().min(1).max(200).optional(),
      ...valueShape,
    }),
    preview: (args) =>
      withVault((service) => {
        const entry = findEntry(service, args.entry);
        checkValuesFit(entry.type, args);
        return {
          title: `Update ${entry.title} in the vault`,
          summary: 'Only these values change. A replaced password or secret is gone for good.',
          fields: [
            ...(args.title !== undefined ? [{ label: 'Title', value: args.title }] : []),
            ...valueFields(args),
          ],
        };
      }),
    run: (args) =>
      withVault(async (service) => {
        const entry = findEntry(service, args.entry);
        checkValuesFit(entry.type, args);
        const { entry: _ref, title, ...values } = args;
        if (title === undefined && Object.values(values).every((value) => value === undefined)) {
          throw new Error('Nothing to change. Pass at least one value to set.');
        }
        const input = {
          id: entry.id,
          title: title ?? entry.title,
          tags: values.tags ?? entry.tags,
          favorite: entry.favorite,
          notes: values.notes,
          ...kindPart(entry, values),
        } as SaveVaultEntryInput;
        const saved = await service.save(input);
        return { text: `Updated ${saved.title} in the vault.` };
      }),
  }),
];
