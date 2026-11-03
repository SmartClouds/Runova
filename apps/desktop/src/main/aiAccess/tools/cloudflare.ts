import { z } from 'zod';
import {
  CLOUDFLARE_RECORD_TYPES,
  isCloudflareId,
  recordName,
} from '../../../shared/cloudflare/dns';
import { cloudflareErrorMessage } from '../../../shared/cloudflareErrors';
import type {
  CloudflareDnsRecord,
  CloudflareRecordInput,
  CloudflareZone,
} from '../../../shared/cloudflareTypes';
import { liveDeployService } from '../../deploy/liveServices';
import { recordInput } from '../../ipc/cloudflare';
import { defineTool } from '../registry';

/**
 * Cloudflare tools: the zones and DNS records of the connected accounts, as the Cloudflare dialog
 * shows them, and adding, changing or removing a record. They call the dialog's own service, so a
 * record is checked by the same rules the record editor uses. A DNS change goes live for everyone
 * at once, so every change is sensitive. The API token never leaves the service.
 */

const zoneArg = z
  .string()
  .min(1)
  .max(253)
  .describe('The zone, by its domain (example.com) or its id. cloudflare_zones lists them.');

const recordIdArg = z
  .string()
  .regex(/^[0-9a-f]{32}$/)
  .describe('The record id, from cloudflare_dns_records.');

function cloudflare() {
  return liveDeployService('cloudflare');
}

/** Runs a service call, passing on what went wrong without the code tag the page reads. */
async function call<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    throw new Error(cloudflareErrorMessage(error));
  }
}

async function findZone(ref: string): Promise<CloudflareZone> {
  const zones = await call(() => cloudflare().allZones());
  const wanted = ref.trim().toLowerCase().replace(/\.$/, '');
  const found = isCloudflareId(wanted)
    ? zones.find((zone) => zone.id === wanted)
    : zones.find((zone) => zone.name.toLowerCase() === wanted);
  if (!found) {
    throw new Error(
      `${ref} is not a zone in the connected Cloudflare accounts. cloudflare_zones lists them.`,
    );
  }
  return found;
}

async function findRecord(zone: CloudflareZone, recordId: string): Promise<CloudflareDnsRecord> {
  const records = await call(() => cloudflare().listRecords(zone.id));
  const found = records.find((record) => record.id === recordId);
  if (!found) throw new Error(`${zone.name} has no record with the id ${recordId}.`);
  return found;
}

function shapeRecord(record: CloudflareDnsRecord) {
  return {
    id: record.id,
    type: record.type,
    name: record.name,
    content: record.content,
    ttl: record.ttl === 1 ? 'auto' : record.ttl,
    proxied: record.proxied,
    ...(record.priority === undefined ? {} : { priority: record.priority }),
    ...(record.caa ? { caa: record.caa } : {}),
    ...(record.srv ? { srv: record.srv } : {}),
    ...(record.comment ? { comment: record.comment } : {}),
    editable: record.editable,
  };
}

/** What a record holds, in a line, for the approval dialog. */
function recordValue(record: {
  type: string;
  content?: string;
  priority?: number;
  caa?: { flags: number; tag: string; value: string };
  srv?: { priority: number; weight: number; port: number; target: string };
  proxied?: boolean;
}): string {
  if (record.caa) return `${record.caa.flags} ${record.caa.tag} "${record.caa.value}"`;
  if (record.srv) {
    const { priority, weight, port, target } = record.srv;
    return `${priority} ${weight} ${port} ${target}`;
  }
  const value =
    record.priority === undefined ? record.content : `${record.priority} ${record.content}`;
  return `${value ?? ''}${record.proxied ? ' (proxied)' : ''}`;
}

const saveInput = z.object({
  zone: zoneArg,
  recordId: recordIdArg
    .optional()
    .describe('The record to change, from cloudflare_dns_records. Leave it out to add a new one.'),
  type: z.enum(CLOUDFLARE_RECORD_TYPES as [string, ...string[]]),
  name: z
    .string()
    .min(1)
    .max(253)
    .describe('The record name: @ for the zone itself, a short name like www, or the full name.'),
  content: z
    .string()
    .max(4096)
    .optional()
    .describe('The address, target or text. Needed for A, AAAA, CNAME, TXT and MX.'),
  ttl: z
    .number()
    .int()
    .optional()
    .describe('Seconds from 60 to 86400, or 1 for automatic (the default).'),
  proxied: z
    .boolean()
    .optional()
    .describe("A, AAAA and CNAME only: send traffic through Cloudflare's proxy. Off by default."),
  priority: z.number().int().optional().describe('MX only: the priority.'),
  caa: z
    .object({
      flags: z.number().int(),
      tag: z.enum(['issue', 'issuewild', 'iodef']),
      value: z.string(),
    })
    .optional()
    .describe('CAA only.'),
  srv: z
    .object({
      priority: z.number().int(),
      weight: z.number().int(),
      port: z.number().int(),
      target: z.string(),
    })
    .optional()
    .describe('SRV only.'),
  comment: z.string().max(500).optional(),
});

type SaveArgs = z.infer<typeof saveInput>;

/** The record as the editor would send it, with its full name, checked by the editor's rules. */
function recordOf(args: SaveArgs, zone: CloudflareZone): CloudflareRecordInput {
  const name = recordName(args.name, zone.name);
  if (!name) throw new Error(`${args.name} cannot be used as a name in ${zone.name}.`);
  const proxiable = args.type === 'A' || args.type === 'AAAA' || args.type === 'CNAME';
  return recordInput({
    type: args.type,
    name,
    content: args.content,
    ttl: args.ttl ?? 1,
    ...(proxiable ? { proxied: args.proxied ?? false } : {}),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.caa ? { caa: args.caa } : {}),
    ...(args.srv ? { srv: args.srv } : {}),
    ...(args.comment === undefined ? {} : { comment: args.comment }),
  });
}

export const cloudflareTools = [
  defineTool({
    name: 'cloudflare_zones',
    area: 'cloudflare',
    title: 'List Cloudflare zones',
    description:
      'The domains (zones) in every connected Cloudflare account, with their status, plan and name servers.',
    risk: 'read',
    input: z.object({}),
    preview: () => ({ title: 'List the Cloudflare zones' }),
    async run() {
      const [zones, status] = await Promise.all([
        call(() => cloudflare().allZones()),
        cloudflare().status(),
      ]);
      const labels = new Map(status.accounts.map((account) => [account.id, account.label]));
      return {
        data: zones.map((zone) => ({
          id: zone.id,
          name: zone.name,
          status: zone.status,
          paused: zone.paused,
          plan: zone.plan,
          nameServers: zone.nameServers,
          account: labels.get(zone.accountId) ?? zone.accountId,
        })),
      };
    },
  }),

  defineTool({
    name: 'cloudflare_dns_records',
    area: 'cloudflare',
    title: 'List DNS records',
    description:
      'The DNS records of a Cloudflare zone. Filter by type or by a name it contains. Records marked editable can be changed with cloudflare_dns_save.',
    risk: 'read',
    input: z.object({
      zone: zoneArg,
      type: z.string().max(16).optional().describe('Only records of this type, like A or TXT.'),
      name: z.string().max(253).optional().describe('Only records whose name contains this.'),
    }),
    preview: (args) => ({ title: `List the DNS records of ${args.zone}` }),
    async run(args) {
      const zone = await findZone(args.zone);
      const records = await call(() => cloudflare().listRecords(zone.id));
      const type = args.type?.toUpperCase();
      const name = args.name?.toLowerCase();
      return {
        data: records
          .filter((record) => !type || record.type === type)
          .filter((record) => !name || record.name.toLowerCase().includes(name))
          .map(shapeRecord),
      };
    },
  }),

  defineTool({
    name: 'cloudflare_dns_save',
    area: 'cloudflare',
    title: 'Add or change a DNS record',
    description:
      'Adds a DNS record to a Cloudflare zone, or with recordId changes one. The change is live at once. Runova edits A, AAAA, CNAME, TXT, MX, CAA and SRV records.',
    risk: 'sensitive',
    input: saveInput,
    async preview(args) {
      const zone = await findZone(args.zone);
      const name = recordName(args.name, zone.name) ?? args.name;
      const next = recordValue({ ...args, proxied: args.proxied ?? false });
      if (!args.recordId) {
        return {
          title: `Add the ${args.type} record ${name}`,
          summary: `It goes live in ${zone.name} as soon as Cloudflare saves it.`,
          fields: [{ label: 'Value', value: next, mono: true }],
        };
      }
      const current = await findRecord(zone, args.recordId);
      return {
        title: `Change the ${current.type} record ${current.name}`,
        summary: `The change is live in ${zone.name} as soon as Cloudflare saves it.`,
        fields: [
          {
            label: 'Now',
            value: `${current.type} ${current.name} ${recordValue(current)}`,
            mono: true,
          },
          { label: 'After', value: `${args.type} ${name} ${next}`, mono: true },
        ],
      };
    },
    async run(args) {
      const zone = await findZone(args.zone);
      const record = recordOf(args, zone);
      if (args.recordId) {
        await findRecord(zone, args.recordId);
        const saved = await call(() =>
          cloudflare().updateRecord(zone.id, args.recordId as string, record),
        );
        return { data: shapeRecord(saved) };
      }
      const saved = await call(() => cloudflare().createRecord(zone.id, record));
      return { data: shapeRecord(saved) };
    },
  }),

  defineTool({
    name: 'cloudflare_dns_remove',
    area: 'cloudflare',
    title: 'Remove a DNS record',
    description: 'Removes a DNS record from a Cloudflare zone. The name stops resolving at once.',
    risk: 'sensitive',
    input: z.object({ zone: zoneArg, recordId: recordIdArg }),
    async preview(args) {
      const zone = await findZone(args.zone);
      const record = await findRecord(zone, args.recordId);
      return {
        title: `Remove the ${record.type} record ${record.name}`,
        summary: `It stops resolving in ${zone.name} as soon as Cloudflare removes it.`,
        fields: [{ label: 'Value', value: recordValue(record), mono: true }],
      };
    },
    async run(args) {
      const zone = await findZone(args.zone);
      const record = await findRecord(zone, args.recordId);
      await call(() => cloudflare().deleteRecord(zone.id, record.id));
      return { text: `Removed the ${record.type} record ${record.name} from ${zone.name}.` };
    },
  }),
];
