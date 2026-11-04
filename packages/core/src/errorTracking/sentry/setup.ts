/**
 * Setting up a new Sentry project: the scope a token needs to make one, the name Sentry will
 * take, and the snippet that puts its DSN to work in the app it belongs to. The snippets are the
 * minimum each SDK's own guide starts with; the guide link has the rest.
 */

/** The scope that lets a token create projects. `project:admin` covers it too. */
export const SENTRY_CREATE_SCOPE = 'project:write';

/** Sentry's limit on a project name. */
export const SENTRY_PROJECT_NAME_MAX = 50;

/** True or false from the token's scopes, or null when the provider did not report them. */
export function canCreateProjects(scopes: readonly string[] | null): boolean | null {
  if (scopes === null) return null;
  return scopes.includes(SENTRY_CREATE_SCOPE) || scopes.includes('project:admin');
}

export type SentryProjectNameCheck = { ok: true; value: string } | { ok: false; reason: string };

export function validateSentryProjectName(input: string): SentryProjectNameCheck {
  const value = input.trim();
  if (!value) return { ok: false, reason: 'Enter a name.' };
  if (value.length > SENTRY_PROJECT_NAME_MAX) {
    return { ok: false, reason: `Use ${SENTRY_PROJECT_NAME_MAX} characters or fewer.` };
  }
  if (!/[\p{L}\p{N}]/u.test(value)) {
    return { ok: false, reason: 'Use at least one letter or digit.' };
  }
  return { ok: true, value };
}

export type SentrySnippetLanguage =
  | 'javascript'
  | 'python'
  | 'csharp'
  | 'go'
  | 'php'
  | 'ruby'
  | 'dart'
  | 'shell';

export interface SentryPlatform {
  /** Runova's id for the snippet, which is also the platform sent to Sentry unless `other`. */
  id: string;
  label: string;
  /** What Sentry calls the platform, or null to let Sentry pick. */
  sentryPlatform: string | null;
  docsUrl: string;
  language: SentrySnippetLanguage;
  install: string;
  /** Where the init code goes, in a few words. */
  where: string;
  init: (dsn: string) => string;
}

/** A DSN as a double-quoted string literal, which every language below reads the same way. */
const quoted = (dsn: string): string => JSON.stringify(dsn);

const DOCS = 'https://docs.sentry.io/platforms';

export const SENTRY_PLATFORMS: readonly SentryPlatform[] = [
  {
    id: 'javascript-react',
    label: 'React',
    sentryPlatform: 'javascript-react',
    docsUrl: `${DOCS}/javascript/guides/react/`,
    language: 'javascript',
    install: 'npm install --save @sentry/react',
    where: 'At the top of your entry file, before the app renders',
    init: (dsn) =>
      `import * as Sentry from "@sentry/react";\n\nSentry.init({\n  dsn: ${quoted(dsn)},\n});`,
  },
  {
    id: 'javascript-nextjs',
    label: 'Next.js',
    sentryPlatform: 'javascript-nextjs',
    docsUrl: `${DOCS}/javascript/guides/nextjs/`,
    language: 'javascript',
    install: 'npx @sentry/wizard@latest -i nextjs',
    where: 'The wizard writes the config files; check that they use this DSN',
    init: (dsn) =>
      `import * as Sentry from "@sentry/nextjs";\n\nSentry.init({\n  dsn: ${quoted(dsn)},\n});`,
  },
  {
    id: 'javascript',
    label: 'Browser JavaScript',
    sentryPlatform: 'javascript',
    docsUrl: `${DOCS}/javascript/`,
    language: 'javascript',
    install: 'npm install --save @sentry/browser',
    where: 'As early as possible in your page script',
    init: (dsn) =>
      `import * as Sentry from "@sentry/browser";\n\nSentry.init({\n  dsn: ${quoted(dsn)},\n});`,
  },
  {
    id: 'node',
    label: 'Node.js',
    sentryPlatform: 'node',
    docsUrl: `${DOCS}/javascript/guides/node/`,
    language: 'javascript',
    install: 'npm install --save @sentry/node',
    where: 'In instrument.js, loaded before anything else',
    init: (dsn) =>
      `const Sentry = require("@sentry/node");\n\nSentry.init({\n  dsn: ${quoted(dsn)},\n});`,
  },
  {
    id: 'python',
    label: 'Python',
    sentryPlatform: 'python',
    docsUrl: `${DOCS}/python/`,
    language: 'python',
    install: 'pip install --upgrade sentry-sdk',
    where: 'When your app starts, before the framework loads',
    init: (dsn) => `import sentry_sdk\n\nsentry_sdk.init(\n    dsn=${quoted(dsn)},\n)`,
  },
  {
    id: 'dotnet',
    label: '.NET (ASP.NET Core)',
    sentryPlatform: 'dotnet-aspnetcore',
    docsUrl: `${DOCS}/dotnet/guides/aspnetcore/`,
    language: 'csharp',
    install: 'dotnet add package Sentry.AspNetCore',
    where: 'In Program.cs, on the web host builder',
    init: (dsn) =>
      `builder.WebHost.UseSentry(options =>\n{\n    options.Dsn = ${quoted(dsn)};\n});`,
  },
  {
    id: 'go',
    label: 'Go',
    sentryPlatform: 'go',
    docsUrl: `${DOCS}/go/`,
    language: 'go',
    install: 'go get github.com/getsentry/sentry-go',
    where: 'At the start of main',
    init: (dsn) =>
      `err := sentry.Init(sentry.ClientOptions{\n\tDsn: ${quoted(dsn)},\n})\nif err != nil {\n\tlog.Fatalf("sentry.Init: %s", err)\n}\ndefer sentry.Flush(2 * time.Second)`,
  },
  {
    id: 'php',
    label: 'PHP',
    sentryPlatform: 'php',
    docsUrl: `${DOCS}/php/`,
    language: 'php',
    install: 'composer require sentry/sentry',
    where: 'As early as possible in your bootstrap',
    init: (dsn) => `\\Sentry\\init([\n    'dsn' => ${quoted(dsn)},\n]);`,
  },
  {
    id: 'ruby',
    label: 'Ruby',
    sentryPlatform: 'ruby',
    docsUrl: `${DOCS}/ruby/`,
    language: 'ruby',
    install: 'bundle add sentry-ruby',
    where: 'In an initializer, such as config/initializers/sentry.rb',
    init: (dsn) => `Sentry.init do |config|\n  config.dsn = ${quoted(dsn)}\nend`,
  },
  {
    id: 'react-native',
    label: 'React Native',
    sentryPlatform: 'react-native',
    docsUrl: `${DOCS}/react-native/`,
    language: 'javascript',
    install: 'npx @sentry/wizard@latest -i reactNative',
    where: 'In App.js, before the app is registered',
    init: (dsn) =>
      `import * as Sentry from "@sentry/react-native";\n\nSentry.init({\n  dsn: ${quoted(dsn)},\n});`,
  },
  {
    id: 'flutter',
    label: 'Flutter',
    sentryPlatform: 'flutter',
    docsUrl: `${DOCS}/dart/guides/flutter/`,
    language: 'dart',
    install: 'flutter pub add sentry_flutter',
    where: 'In main.dart, wrapping runApp',
    init: (dsn) =>
      `Future<void> main() async {\n  await SentryFlutter.init(\n    (options) => options.dsn = ${quoted(dsn)},\n    appRunner: () => runApp(const MyApp()),\n  );\n}`,
  },
  {
    id: 'other',
    label: 'Other',
    sentryPlatform: null,
    docsUrl: `${DOCS}/`,
    language: 'shell',
    install: '',
    where: 'Most Sentry SDKs read the DSN from this environment variable',
    init: (dsn) => `SENTRY_DSN=${quoted(dsn)}`,
  },
];

const OTHER = SENTRY_PLATFORMS.at(-1) as SentryPlatform;

export function sentryPlatform(id: string | null | undefined): SentryPlatform {
  return SENTRY_PLATFORMS.find((one) => one.id === id) ?? OTHER;
}

/** Framework guides Sentry names after their language, pointed at the snippet for it. */
const PLATFORM_PREFIXES: [prefix: string, id: string][] = [
  ['javascript-nextjs', 'javascript-nextjs'],
  ['javascript-react', 'javascript-react'],
  ['react-native', 'react-native'],
  ['javascript', 'javascript'],
  ['node', 'node'],
  ['python', 'python'],
  ['dotnet', 'dotnet'],
  ['csharp', 'dotnet'],
  ['go', 'go'],
  ['php', 'php'],
  ['ruby', 'ruby'],
  ['flutter', 'flutter'],
  ['dart', 'flutter'],
];

/** The snippet to show first for a project Sentry says is on `platform`. */
export function suggestSentryPlatform(platform: string | null | undefined): string {
  if (!platform) return OTHER.id;
  const exact = SENTRY_PLATFORMS.find(
    (one) => one.id === platform || one.sentryPlatform === platform,
  );
  if (exact) return exact.id;
  const prefixed = PLATFORM_PREFIXES.find(
    ([prefix]) => platform === prefix || platform.startsWith(`${prefix}-`),
  );
  return prefixed?.[1] ?? OTHER.id;
}

export interface SentrySetup {
  platform: SentryPlatform;
  install: string;
  code: string;
  language: SentrySnippetLanguage;
  env: string;
}

export function buildSentrySetup(platformId: string, dsn: string): SentrySetup {
  const platform = sentryPlatform(platformId);
  return {
    platform,
    install: platform.install,
    code: platform.init(dsn),
    language: platform.language,
    env: `SENTRY_DSN=${dsn}`,
  };
}

/** The project's Client Keys settings page on the connected host. */
export function sentryKeysPageUrl(host: string, orgSlug: string, projectSlug: string): string {
  const base = host.replace(/\/+$/, '');
  return `${base}/settings/${encodeURIComponent(orgSlug)}/projects/${encodeURIComponent(projectSlug)}/keys/`;
}
