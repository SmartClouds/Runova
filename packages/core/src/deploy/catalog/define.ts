import { z } from 'zod';
import { fillVersionLabel } from './latest.js';
import type { CatalogField, CatalogTemplate } from './types.js';

/**
 * Builds a template and checks the parts the type system cannot: the default version is listed,
 * every parameter has a field for the install sheet and no field is left over, and ids and
 * secret keys are unique. A template that fails throws when the catalog loads, so a broken one
 * never reaches the install sheet.
 */
export function defineCatalogTemplate<S extends z.ZodObject>(
  template: Omit<CatalogTemplate<z.output<S>>, 'parameters' | 'fields'> & {
    parameters: S;
    fields: Readonly<Record<keyof z.output<S> & string, CatalogField>>;
  },
): CatalogTemplate<z.output<S>> & { parameters: S } {
  const versions = template.versions.map((version) => version.id);
  if (!versions.includes(template.defaultVersion)) {
    throw new Error(
      `${template.id}: the default version ${template.defaultVersion} is not one of its versions.`,
    );
  }
  if (new Set(versions).size !== versions.length) {
    throw new Error(`${template.id}: two versions share an id.`);
  }
  const keys = Object.keys(template.parameters.shape).sort();
  const fields = Object.keys(template.fields).sort();
  const missing = keys.filter((key) => !fields.includes(key));
  const extra = fields.filter((key) => !keys.includes(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `${template.id}: fields and parameters differ (no field for ${missing.join(', ') || 'none'}, no parameter for ${extra.join(', ') || 'none'}).`,
    );
  }
  const secrets = template.secrets.map((secret) => secret.key);
  if (new Set(secrets).size !== secrets.length) {
    throw new Error(`${template.id}: two secrets share a key.`);
  }
  const labelled = {
    ...template,
    versions: template.versions.map((version) =>
      version.label.includes('{')
        ? {
            ...version,
            label: fillVersionLabel(version.label, version.images),
            labelPattern: version.label,
          }
        : version,
    ),
  };
  // S parses to z.output<S> by definition; TypeScript cannot see that for a generic S.
  return labelled as unknown as CatalogTemplate<z.output<S>> & { parameters: S };
}

const PORT_RANGE = 'Ports go from 1 to 65535.';

/** A host port, bound to 127.0.0.1. */
export function portParam(fallback: number) {
  return z
    .number({ error: 'Enter a port number.' })
    .int('A port is a whole number.')
    .min(1, PORT_RANGE)
    .max(65535, PORT_RANGE)
    .default(fallback);
}

/** A database, user or account name: safe in SQL, URLs, shells and YAML as it is. */
export function identifierParam(fallback: string) {
  return z
    .string({ error: 'Enter a name.' })
    .regex(
      /^[A-Za-z][A-Za-z0-9_]{0,62}$/,
      'Use letters, digits and underscores, starting with a letter, up to 63 characters.',
    )
    .default(fallback);
}

/** An existing Docker network to join, such as another app's `name_default`. */
export function networkParam() {
  return z
    .string({ error: 'Enter a network name.' })
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/,
      'Use the name of an existing Docker network: letters, digits, dots, dashes and underscores.',
    )
    .optional();
}

/** A host name another container answers to, such as `db` or `postgres`. */
export function hostParam(fallback: string) {
  return z
    .string({ error: 'Enter a host name.' })
    .regex(
      /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/,
      'Use a container or host name: letters, digits, dots and dashes.',
    )
    .default(fallback);
}
