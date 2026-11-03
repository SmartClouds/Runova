import type { z } from 'zod';

/**
 * The shapes of the app catalog: what an app template declares, and what it builds from the
 * parameters someone picked in the install sheet. Rendering turns a build into compose YAML and
 * an env map (render.ts); the templates themselves live in templates/.
 */

export type CatalogCategory =
  | 'database'
  | 'website'
  | 'ai'
  | 'automation'
  | 'monitoring'
  | 'storage'
  | 'developer'
  | 'search'
  | 'messaging';

/** Who publishes an image. Only these two kinds make it into the catalog. */
export type CatalogImageSource = 'docker-official' | 'vendor';

export interface PinnedImage {
  /** Fully qualified repository, such as docker.io/library/postgres. */
  repository: string;
  /** The tag the digest was resolved from, such as 18.6. */
  tag: string;
  /** Digest of the multi-platform image index. */
  digest: `sha256:${string}`;
  /** Platforms the index was checked to carry. */
  platforms: readonly string[];
  source: CatalogImageSource;
  /** Who publishes it: "Docker Official Images" or the vendor's name. */
  publisher: string;
  /** The day the digest was resolved, YYYY-MM-DD. */
  resolvedAt: string;
  /**
   * How many leading numbers of the tag a newer release keeps (latest.ts): 1, the default, moves
   * within the major version; 2 holds a database to its minor line, such as MariaDB 11.4 LTS.
   */
  track?: number;
}

export interface CatalogVersion {
  /** Stable id of the release line, such as "18". Stored with an install. */
  id: string;
  /** What the store shows, such as "Ollama 0.35.0 with Open WebUI 0.11.4". */
  label: string;
  /**
   * The label with `{role}` where each image's version goes. A template writes its label this
   * way; defineCatalogTemplate fills it in and keeps the pattern here, so a newer release from
   * the registry gets a label that names what it runs (latest.ts).
   */
  labelPattern?: string;
  /** The images this line runs, by role (the template's own names, such as "app" or "db"). */
  images: Readonly<Record<string, PinnedImage>>;
}

export type CatalogSecretKind = 'password' | 'hex';

export interface CatalogSecretSpec {
  /** The env key the secret is stored under. */
  key: string;
  label: string;
  kind: CatalogSecretKind;
  /** Characters for a password, bytes for a hex key. */
  length: number;
}

export type CatalogFieldInput = 'text' | 'number' | 'toggle' | 'port';

export interface CatalogField {
  label: string;
  help: string;
  input: CatalogFieldInput;
}

/** A value for a service's environment: written as is, or read from a secret in the .env. */
export type CatalogEnvValue = string | { secret: string };

export interface CatalogPort {
  /** What the port is for, such as "Web interface" or "PostgreSQL". */
  label: string;
  target: number;
  /** The host port. Always bound to 127.0.0.1; public access goes through the proxy. */
  published: number;
  protocol?: 'tcp' | 'udp';
}

export interface CatalogHealthcheck {
  /** Compose's test form: ["CMD", ...] or ["CMD-SHELL", "..."]. `$$` reaches the container as `$`. */
  test: readonly string[];
  interval?: string;
  timeout?: string;
  retries?: number;
  startPeriod?: string;
}

export interface CatalogServiceSpec {
  /** A role from the version's images. */
  image: string;
  hostname?: string;
  user?: string;
  command?: readonly string[];
  environment?: Readonly<Record<string, CatalogEnvValue>>;
  ports?: readonly CatalogPort[];
  /** Named volumes, mounted at the target. */
  volumes?: readonly { volume: string; target: string }[];
  healthcheck: CatalogHealthcheck;
  dependsOn?: readonly string[];
  /** External Docker networks to join besides the app's own. */
  externalNetworks?: readonly string[];
  /** Reserve every NVIDIA GPU for the service. */
  gpu?: boolean;
  stopGracePeriod?: string;
}

export interface CatalogFact {
  id: string;
  label: string;
  value: string;
  /** It holds a secret: show it masked until asked, and never log it. */
  sensitive: boolean;
}

/** A fact as rendered, with every secret in it replaced by asterisks for showing and logging. */
export interface RenderedCatalogFact extends CatalogFact {
  masked: string;
}

export interface CatalogBuild {
  /** In the order they are written to the compose file. */
  services: Readonly<Record<string, CatalogServiceSpec>>;
  /** The service and container port the proxy points at when the app goes on a domain. */
  web: { service: string; port: number } | null;
  facts: readonly CatalogFact[];
}

export interface CatalogBuildContext<P> {
  version: CatalogVersion;
  params: P;
  /** The secret's value, for facts such as connection strings. */
  secret: (key: string) => string;
  /** `https://domain` when the app goes on a domain, else null. */
  publicUrl: string | null;
}

export interface CatalogAcknowledgment {
  /** The risk id from the compose linter. */
  id: string;
  /** Why the template needs it, reviewed when it was added. */
  reason: string;
}

export interface CatalogTemplate<P = Record<string, unknown>> {
  id: string;
  name: string;
  description: string;
  category: CatalogCategory;
  homepage: string;
  /** Newest first. */
  versions: readonly CatalogVersion[];
  defaultVersion: string;
  parameters: z.ZodType<P>;
  fields: Readonly<Record<string, CatalogField>>;
  secrets: readonly CatalogSecretSpec[];
  /** Whether a secret is used with these parameters. Unused ones stay out of the env. */
  secretInUse?: (key: string, params: P) => boolean;
  /** Memory the app needs to run comfortably, in MB. */
  minMemoryMb: number;
  /** The first person to open the app creates the admin account. */
  firstVisitorSetup: boolean;
  /** Something to know before putting the app on a domain, or null. */
  exposureNote: string | null;
  acknowledgments: readonly CatalogAcknowledgment[];
  build: (context: CatalogBuildContext<P>) => CatalogBuild;
}

/** Any template, with its parameter type erased, as the catalog lists them. */
// biome-ignore lint/suspicious/noExplicitAny: the catalog holds templates with different parameters.
export type AnyCatalogTemplate = CatalogTemplate<any>;
