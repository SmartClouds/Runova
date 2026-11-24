import type { SymbolEntry } from '../../shared/symbolIndex';
import type { SymbolKind } from '../../shared/symbolKinds';

/**
 * Finds declarations for the workspace search's `t:` and `m:` filters by their shape on a line,
 * the way ctags does, rather than by parsing. ripgrep narrows a project to the lines one of
 * these rules could match (see `prefilterFor`), and only those come through here.
 *
 * Each rule is a pattern with a named group `n` for the name, and optionally `c` for a type
 * the line names itself (a Go receiver, `Widget::draw`), `k` for the keyword that decides the
 * kind, and `t` for a return type that must not turn out to be `return` or `new`.
 *
 * What a member belongs to comes from indentation: a declaration sits inside the nearest one
 * above it that is indented less. That is right for nearly all real code, and the rules that
 * could catch an ordinary statement only count inside a type's body.
 *
 * The patterns are written so ripgrep's regex engine accepts them too: no lookaround, no
 * backreferences.
 */

export type Language =
  | 'ts'
  | 'python'
  | 'go'
  | 'rust'
  | 'csharp'
  | 'java'
  | 'kotlin'
  | 'swift'
  | 'php'
  | 'cpp';

export const LANGUAGE_EXTENSIONS: Record<Language, readonly string[]> = {
  ts: ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'],
  python: ['py', 'pyi'],
  go: ['go'],
  rust: ['rs'],
  csharp: ['cs'],
  java: ['java'],
  kotlin: ['kt', 'kts'],
  swift: ['swift'],
  php: ['php'],
  cpp: ['c', 'h', 'cc', 'cpp', 'cxx', 'hh', 'hpp', 'hxx'],
};

const LANGUAGE_OF_EXTENSION = new Map<string, Language>(
  Object.entries(LANGUAGE_EXTENSIONS).flatMap(([lang, extensions]) =>
    extensions.map((extension) => [extension, lang as Language] as const),
  ),
);

export function languageOf(path: string): Language | null {
  const dot = path.lastIndexOf('.');
  if (dot === -1 || dot < path.lastIndexOf('/')) return null;
  return LANGUAGE_OF_EXTENSION.get(path.slice(dot + 1).toLowerCase()) ?? null;
}

type Groups = Record<string, string | undefined>;

interface Rule {
  re: RegExp;
  kind: SymbolKind | ((groups: Groups) => SymbolKind);
  /** Starts a type whose body holds members. */
  opens?: boolean;
  /** A body members belong to, without being a symbol itself (Rust `impl`, Swift `extension`). */
  containerOnly?: boolean;
  /** Only counts directly inside a type. */
  member?: boolean;
  /** Could be an ordinary statement too, so it must also line up with the type's other members. */
  weak?: boolean;
  /** A declaration without a body, which only counts where bodies are optional. */
  signature?: boolean | ((groups: Groups, text: string) => boolean);
  /** Deeper than this is a local variable, not a property. */
  maxIndent?: number;
  /** A constructor has the name of its type. Anything else on this pattern is not one. */
  constructorOf?: 'parent' | 'c';
}

/** Words a pattern can land on that are never a name. */
const KEYWORDS = new Set([
  'if',
  'else',
  'elif',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'catch',
  'try',
  'finally',
  'return',
  'throw',
  'throws',
  'yield',
  'await',
  // Not `new`: Rust constructors are conventionally called that.
  'delete',
  'typeof',
  'sizeof',
  'void',
  'with',
  'using',
  'lock',
  'goto',
  'when',
  'match',
  'in',
  'is',
  'as',
  'not',
  'and',
  'or',
  'import',
  'export',
  'require',
  'super',
  'this',
  'self',
  'func',
  'fun',
  'fn',
  'var',
  'val',
  'let',
  'const',
  'defined',
  'operator',
]);

/** Words that can sit where a return type goes without being one. */
const NOT_TYPES = new Set([
  'return',
  'throw',
  'yield',
  'await',
  'new',
  'delete',
  'else',
  'case',
  'goto',
  'using',
  'typeof',
  'sizeof',
  'in',
  'is',
  'as',
  'if',
  'while',
  'for',
  'foreach',
  'switch',
  'lock',
  'do',
  'co_return',
  'co_await',
  'co_yield',
  'typedef',
]);

const ID = '[A-Za-z_$][\\w$]*';

function rx(source: string): RegExp {
  return new RegExp(source, 'd');
}

const TS_METHOD_MODS =
  '(?:(?:public|private|protected|static|readonly|async|override|declare|accessor)\\s+)';
const TS_PROPERTY_MODS =
  '(?:(?:public|private|protected|static|readonly|declare|override|abstract|accessor)\\s+)';

const TS: Rule[] = [
  {
    re: rx(`^\\s*(?:(?:export|default|declare|abstract)\\s+)*class\\s+(?<n>${ID})`),
    kind: 'class',
    opens: true,
  },
  {
    re: rx(`^\\s*(?:(?:export|declare)\\s+)*interface\\s+(?<n>${ID})`),
    kind: 'interface',
    opens: true,
  },
  {
    re: rx(`^\\s*(?:(?:export|declare|const)\\s+)*enum\\s+(?<n>${ID})`),
    kind: 'enum',
    opens: true,
  },
  { re: rx(`^\\s*(?:(?:export|declare)\\s+)*type\\s+(?<n>${ID})\\s*(?:<.*>)?\\s*=`), kind: 'type' },
  {
    re: rx(`^\\s*(?:(?:export|declare)\\s+)*(?:namespace|module)\\s+(?<n>${ID}(?:\\.${ID})*)`),
    kind: 'namespace',
  },
  {
    re: rx(`^\\s*(?:(?:export|default|declare|async)\\s+)*function\\s*\\*?\\s*(?<n>${ID})`),
    kind: 'function',
  },
  {
    re: rx(
      `^(?:export\\s+)?(?:const|let|var)\\s+(?<n>${ID})\\s*(?::[^=]+)?=\\s*(?:async\\s+)?(?:function\\b|.*=>)`,
    ),
    kind: 'function',
  },
  { re: rx(`^(?:export\\s+)?const\\s+(?<n>${ID})\\s*(?::[^=]+)?=`), kind: 'const' },
  {
    re: rx('^\\s+(?:(?:public|private|protected)\\s+)?(?<n>constructor)\\s*\\('),
    kind: 'constructor',
    member: true,
  },
  {
    re: rx(`^\\s+${TS_PROPERTY_MODS}*(?:get|set)\\s+(?<n>#?${ID})\\s*\\(`),
    kind: 'property',
    member: true,
  },
  {
    re: rx(
      `^\\s+${TS_METHOD_MODS}*abstract\\s+${TS_METHOD_MODS}*(?<n>#?${ID})\\??\\s*(?:<[^>]*>)?\\s*\\(`,
    ),
    kind: 'method',
    member: true,
  },
  {
    re: rx(`^\\s+${TS_METHOD_MODS}+\\*?(?<n>#?${ID})\\??\\s*(?:<[^>]*>)?\\s*\\(`),
    kind: 'method',
    member: true,
  },
  {
    re: rx(
      `^\\s+\\*?(?<n>#?${ID})\\??\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*(?::\\s*[^;=]+?)?\\s*\\{.*$`,
    ),
    kind: 'method',
    member: true,
    weak: true,
  },
  {
    re: rx(`^\\s+(?<n>#?${ID})\\??\\s*(?:<[^>]*>)?\\s*\\([^;]*\\)\\s*:\\s*[^;=]+;\\s*$`),
    kind: 'method',
    member: true,
    weak: true,
    signature: true,
  },
  {
    re: rx(`^\\s+${TS_PROPERTY_MODS}+(?<n>#?${ID})[?!]?\\s*[:=;]`),
    kind: 'property',
    member: true,
  },
  {
    re: rx(`^\\s+(?<n>#?${ID})\\s*=\\s*(?:async\\s+)?(?:\\([^)]*\\)|${ID})\\s*(?::[^=]+)?=>`),
    kind: 'method',
    member: true,
    weak: true,
  },
  {
    re: rx(`^\\s+(?<n>#?${ID})[?!]?\\s*:\\s*[^=;]+;\\s*$`),
    kind: 'property',
    member: true,
    weak: true,
  },
  { re: rx(`^\\s+(?<n>#${ID})\\s*[=;]`), kind: 'property', member: true, weak: true },
];

const PYTHON: Rule[] = [
  { re: rx('^\\s*class\\s+(?<n>\\w+)'), kind: 'class', opens: true },
  { re: rx('^\\s*(?:async\\s+)?def\\s+(?<n>\\w+)'), kind: 'function' },
  { re: rx('^(?<n>[A-Z][A-Z0-9_]*)\\s*(?::[^=]+)?=[^=]'), kind: 'const' },
];

const GO: Rule[] = [
  {
    re: rx('^type\\s+(?<n>\\w+)(?:\\[[^\\]]*\\])?\\s+(?<k>struct|interface)\\b'),
    kind: (groups) => (groups.k === 'interface' ? 'interface' : 'struct'),
    opens: true,
  },
  { re: rx('^type\\s+(?<n>\\w+)'), kind: 'type' },
  {
    re: rx('^func\\s*\\(\\s*\\w*\\s*\\*?\\s*(?<c>\\w+)(?:\\[[^\\]]*\\])?\\s*\\)\\s*(?<n>\\w+)'),
    kind: 'method',
  },
  { re: rx('^func\\s+(?<n>\\w+)'), kind: 'function' },
  {
    re: rx('^\\s+(?<n>[A-Za-z_]\\w*)\\s*\\(.*\\)'),
    kind: 'method',
    member: true,
    signature: true,
  },
  { re: rx('^const\\s+(?<n>\\w+)'), kind: 'const' },
];

const RUST_VIS = '(?:pub(?:\\([^)]*\\))?\\s+)?';

const RUST: Rule[] = [
  {
    re: rx(`^\\s*${RUST_VIS}(?:unsafe\\s+)?(?<k>struct|enum|trait|union|type)\\s+(?<n>\\w+)`),
    kind: (groups) =>
      groups.k === 'union' ? 'struct' : (groups.k as 'struct' | 'enum' | 'trait' | 'type'),
    opens: true,
  },
  {
    re: rx('^\\s*(?:unsafe\\s+)?impl(?:<.*?>)?\\s+(?:.*?\\s+for\\s+)?(?<n>\\w+)'),
    kind: 'struct',
    containerOnly: true,
  },
  { re: rx(`^\\s*${RUST_VIS}mod\\s+(?<n>\\w+)`), kind: 'namespace' },
  {
    re: rx(
      `^\\s*${RUST_VIS}(?:(?:const|async|unsafe|extern(?:\\s+"[^"]*")?)\\s+)*fn\\s+(?<n>\\w+)`,
    ),
    kind: 'function',
  },
  {
    re: rx(`^\\s*${RUST_VIS}(?:const|static)\\s+(?:mut\\s+)?(?<n>[A-Z_][A-Z0-9_]*)\\s*:`),
    kind: 'const',
  },
];

/** A type name as C#, Java and C++ write one: dotted, generic, nullable or an array. */
const CTYPE = '[\\w.?\\[\\]]+(?:<[^()]*>)?[\\w.?\\[\\]]*';

/** A declaration ending in `;` with no body, unless it is an expression-bodied member. */
function endsWithoutBody(_groups: Groups, text: string): boolean {
  const trimmed = text.trimEnd();
  return trimmed.endsWith(';') && !trimmed.includes('=>');
}

const CS_MODS =
  '(?:(?:public|private|protected|internal|static|abstract|sealed|partial|readonly|unsafe|new|virtual|override|async|extern|file|required|const|volatile|ref)\\s+)*';

/** Attributes written on the declaration's own line: `[Fact] public void Works()`. */
const CS_ATTRS = '(?:\\[[^\\]]*\\]\\s*)*';
const CS_START = `^\\s*${CS_ATTRS}${CS_MODS}`;
/** A return type, a tuple included: `(int Count, string Name) Totals()`. */
const CS_RETURN = `${CTYPE}|\\([^()]*\\)`;

const CSHARP: Rule[] = [
  {
    re: rx(
      `${CS_START}(?<k>class|interface|struct|enum|record(?:\\s+(?:struct|class))?)\\s+(?<n>\\w+)`,
    ),
    kind: (groups) =>
      groups.k?.startsWith('record')
        ? 'record'
        : (groups.k as 'class' | 'interface' | 'struct' | 'enum'),
    opens: true,
  },
  { re: rx('^\\s*namespace\\s+(?<n>[\\w.]+)'), kind: 'namespace' },
  {
    re: rx(`${CS_START}delegate\\s+(?<t>${CS_RETURN})\\s+(?<n>\\w+)\\s*(?:<[^()]*>)?\\s*\\(`),
    kind: 'type',
  },
  {
    re: rx(`${CS_START}event\\s+(?<t>${CTYPE})\\s+(?<n>\\w+)\\s*(?:[;={]|$)`),
    kind: 'field',
    member: true,
  },
  {
    re: rx(
      `^\\s*${CS_ATTRS}(?:(?:public|private|protected|internal|static)\\s+)+(?<n>\\w+)\\s*\\(`,
    ),
    kind: 'constructor',
    member: true,
    constructorOf: 'parent',
  },
  {
    re: rx(`${CS_START}(?<t>${CS_RETURN})\\s+(?<n>\\w+)\\s*(?:<[^()]*>)?\\s*\\(`),
    kind: 'method',
    member: true,
    signature: endsWithoutBody,
  },
  {
    re: rx(
      `${CS_START}(?<t>${CTYPE})\\s+(?<n>\\w+)\\s*(?:\\{\\s*(?:get|set|init|private|protected|internal)|=>)`,
    ),
    kind: 'property',
    member: true,
  },
  {
    re: rx(
      `^\\s*${CS_ATTRS}(?<m>(?:(?:public|private|protected|internal|static|readonly|const|volatile|required|new)\\s+)+)(?<t>${CTYPE})\\s+(?<n>\\w+)\\s*(?:=|;)`,
    ),
    kind: (groups) => (/\bconst\b/.test(groups.m ?? '') ? 'const' : 'field'),
    member: true,
  },
];

const JAVA_MODS =
  '(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|sealed|non-sealed|strictfp|transient|volatile)\\s+)*';

const JAVA: Rule[] = [
  {
    re: rx(`^\\s*${JAVA_MODS}(?<k>class|interface|enum|record|@interface)\\s+(?<n>\\w+)`),
    kind: (groups) =>
      groups.k === '@interface'
        ? 'interface'
        : (groups.k as 'class' | 'interface' | 'enum' | 'record'),
    opens: true,
  },
  {
    re: rx('^\\s*(?:(?:public|private|protected)\\s+)+(?<n>\\w+)\\s*\\('),
    kind: 'constructor',
    member: true,
    constructorOf: 'parent',
  },
  {
    re: rx(`^\\s*${JAVA_MODS}(?:<[^>]+>\\s+)?(?<t>${CTYPE})\\s+(?<n>\\w+)\\s*\\(`),
    kind: 'method',
    member: true,
    signature: endsWithoutBody,
  },
  {
    re: rx(
      `^\\s*(?<m>(?:(?:public|private|protected|static|final|transient|volatile)\\s+)+)(?<t>${CTYPE})\\s+(?<n>\\w+)\\s*(?:=|;)`,
    ),
    kind: (groups) =>
      /\bstatic\b/.test(groups.m ?? '') && /\bfinal\b/.test(groups.m ?? '') ? 'const' : 'field',
    member: true,
  },
];

const KOTLIN_MODS =
  '(?:(?:public|private|internal|protected|open|abstract|sealed|data|enum|annotation|inner|value|inline|override|suspend|operator|infix|tailrec|external|const|lateinit|final|expect|actual)\\s+)*';

const KOTLIN: Rule[] = [
  {
    re: rx(`^\\s*(?<m>${KOTLIN_MODS})(?<k>class|interface|object)\\s+(?<n>\\w+)`),
    kind: (groups) =>
      groups.k === 'interface' ? 'interface' : /\benum\b/.test(groups.m ?? '') ? 'enum' : 'class',
    opens: true,
  },
  {
    re: rx(`^\\s*${KOTLIN_MODS}fun\\s+(?:<[^>]*>\\s*)?(?:[\\w.<>]+\\.)?(?<n>\\w+)\\s*\\(`),
    kind: 'function',
  },
  { re: rx(`^\\s*${KOTLIN_MODS}typealias\\s+(?<n>\\w+)`), kind: 'type' },
  {
    re: rx(`^\\s*(?<m>${KOTLIN_MODS})(?:val|var)\\s+(?<n>\\w+)`),
    kind: (groups) => (/\bconst\b/.test(groups.m ?? '') ? 'const' : 'property'),
    maxIndent: 4,
  },
];

const SWIFT_MODS =
  '(?:(?:public|private|fileprivate|internal|open|final|static|class|override|mutating|nonmutating|lazy|weak|unowned|convenience|required|dynamic|indirect|nonisolated|@\\w+(?:\\([^)]*\\))?)\\s+)*';

const SWIFT: Rule[] = [
  {
    re: rx(`^\\s*${SWIFT_MODS}(?<k>class|struct|enum|protocol|actor)\\s+(?<n>\\w+)`),
    kind: (groups) =>
      groups.k === 'protocol'
        ? 'interface'
        : groups.k === 'actor'
          ? 'class'
          : (groups.k as 'class' | 'struct' | 'enum'),
    opens: true,
  },
  { re: rx(`^\\s*${SWIFT_MODS}extension\\s+(?<n>\\w+)`), kind: 'class', containerOnly: true },
  { re: rx(`^\\s*${SWIFT_MODS}func\\s+(?<n>\\w+)`), kind: 'function' },
  { re: rx(`^\\s*${SWIFT_MODS}(?<n>init)[?!]?\\s*[(<]`), kind: 'constructor', member: true },
  { re: rx(`^\\s*${SWIFT_MODS}typealias\\s+(?<n>\\w+)`), kind: 'type' },
  { re: rx(`^\\s*${SWIFT_MODS}(?:var|let)\\s+(?<n>\\w+)`), kind: 'property', maxIndent: 4 },
];

const PHP: Rule[] = [
  {
    re: rx(
      '^\\s*(?:(?:abstract|final|readonly)\\s+)*(?<k>class|interface|trait|enum)\\s+(?<n>\\w+)',
    ),
    kind: (groups) => groups.k as 'class' | 'interface' | 'trait' | 'enum',
    opens: true,
  },
  { re: rx('^\\s*namespace\\s+(?<n>[\\w\\\\]+)'), kind: 'namespace' },
  {
    re: rx(
      '^\\s*(?:(?:public|private|protected|static|abstract|final)\\s+)*function\\s+&?(?<n>\\w+)',
    ),
    kind: 'function',
  },
  { re: rx('^\\s*(?:(?:public|private|protected|final)\\s+)*const\\s+(?<n>\\w+)'), kind: 'const' },
  {
    re: rx(
      '^\\s*(?:(?:public|private|protected|static|readonly|var)\\s+)+(?:\\??[\\w\\\\|]+\\s+)?\\$(?<n>\\w+)',
    ),
    kind: 'property',
    member: true,
  },
];

const CPP_MODS =
  '(?:(?:static|inline|virtual|extern|constexpr|explicit|friend|unsigned|signed|const|struct|enum)\\s+)*';
const CPP_AFTER_PARAMS =
  '\\s*(?:const\\s*)?(?:noexcept\\s*)?(?:override\\s*)?(?:final\\s*)?(?<end>[;{].*)?$';

const CPP: Rule[] = [
  { re: rx('^\\s*namespace\\s+(?<n>[\\w:]+)\\s*\\{?\\s*$'), kind: 'namespace' },
  {
    re: rx(
      '^\\s*(?:typedef\\s+)?(?:template\\s*<.*>\\s*)?(?<k>class|struct|union|enum(?:\\s+class|\\s+struct)?)\\s+(?:[A-Z_][A-Z0-9_]*\\s+)?(?<n>\\w+)\\s*(?:final\\s*)?(?::[^;{]*)?(?:\\{.*)?$',
    ),
    kind: (groups) =>
      groups.k === 'class' ? 'class' : groups.k?.startsWith('enum') ? 'enum' : 'struct',
    opens: true,
  },
  { re: rx('^\\s*typedef\\s+[^;(]*?\\b(?<n>\\w+)\\s*;\\s*$'), kind: 'type' },
  {
    re: rx('^(?:[\\w:<>,*&\\s]+?\\s+[*&]*)?(?<c>\\w+)::(?<n>~?\\w+)\\s*\\('),
    kind: 'method',
    constructorOf: 'c',
  },
  {
    re: rx(
      '^\\s+(?:(?:explicit|virtual|inline)\\s+)*(?<n>~?\\w+)\\s*\\([^)]*\\)\\s*(?:=\\s*\\w+\\s*)?[;{:]',
    ),
    kind: 'constructor',
    member: true,
    constructorOf: 'parent',
  },
  {
    re: rx(
      `^${CPP_MODS}(?<t>[\\w:<>,]+[*&]*)\\s+[*&]*(?<n>\\w+)\\s*\\([^;]*?\\)${CPP_AFTER_PARAMS}`,
    ),
    kind: 'function',
  },
  {
    re: rx(
      `^\\s+${CPP_MODS}(?<t>[\\w:<>,]+[*&]*)\\s+[*&]*(?<n>\\w+)\\s*\\([^;]*?\\)${CPP_AFTER_PARAMS}`,
    ),
    kind: 'method',
    member: true,
    signature: (groups) => groups.end?.startsWith(';') ?? false,
  },
];

const RULES: Record<Language, Rule[]> = {
  ts: TS,
  python: PYTHON,
  go: GO,
  rust: RUST,
  csharp: CSHARP,
  java: JAVA,
  kotlin: KOTLIN,
  swift: SWIFT,
  php: PHP,
  cpp: CPP,
};

/** Types whose members may be declared without a body. */
const SIGNATURE_HOLDERS: Record<Language, ReadonlySet<SymbolKind>> = {
  ts: new Set(['interface']),
  python: new Set(),
  go: new Set(['interface']),
  rust: new Set(['trait']),
  csharp: new Set(['interface']),
  java: new Set(['interface']),
  kotlin: new Set(['interface']),
  swift: new Set(['interface']),
  php: new Set(['interface']),
  cpp: new Set(['class', 'struct']),
};

const FUNCTION_KINDS: ReadonlySet<SymbolKind> = new Set(['function', 'method', 'constructor']);

/**
 * One pattern for ripgrep that matches any line a rule of this language could, so only
 * those lines leave ripgrep. The named groups go, since one pattern cannot repeat a name.
 */
export function prefilterFor(lang: Language): string {
  return RULES[lang].map((rule) => rule.re.source.replace(/\(\?<\w+>/g, '(?:')).join('|');
}

/** Lines longer than this are generated code or data, not declarations. */
const MAX_LINE = 400;

function indentOf(text: string): number {
  let width = 0;
  for (const char of text) {
    if (char === ' ') width += 1;
    else if (char === '\t') width += 4;
    else break;
  }
  return width;
}

interface Scope {
  name: string;
  kind: SymbolKind;
  indent: number;
  isType: boolean;
  /** Where this type's members sit, learned from the first one. */
  memberIndent: number | null;
}

/**
 * The declarations in one file, from its candidate lines in order. Lines ripgrep did not pass
 * along simply never come through, which is fine: nesting only needs the declarations.
 */
export function buildFileSymbols(
  lang: Language,
  path: string,
  lines: readonly { line: number; text: string }[],
): SymbolEntry[] {
  const rules = RULES[lang];
  const holders = SIGNATURE_HOLDERS[lang];
  const stack: Scope[] = [];
  const found: SymbolEntry[] = [];

  for (const { line, text } of lines) {
    if (text.length > MAX_LINE) continue;
    const indent = indentOf(text);
    for (const rule of rules) {
      const match = rule.re.exec(text);
      const groups = match?.groups;
      const name = groups?.n;
      if (!match || !groups || !name) continue;
      if (KEYWORDS.has(name) || (groups.t && NOT_TYPES.has(groups.t))) continue;

      let depth = stack.length;
      while (depth > 0 && stack[depth - 1].indent >= indent) depth -= 1;
      const parent = depth > 0 ? stack[depth - 1] : null;
      const typeParent = parent?.isType ? parent : null;

      if (rule.member && !typeParent) continue;
      if (rule.weak && typeParent?.memberIndent != null && typeParent.memberIndent !== indent) {
        continue;
      }
      if (rule.maxIndent !== undefined && indent > rule.maxIndent) continue;
      const signature =
        typeof rule.signature === 'function' ? rule.signature(groups, text) : rule.signature;
      if (signature && !(typeParent && holders.has(typeParent.kind))) continue;

      let kind = typeof rule.kind === 'function' ? rule.kind(groups) : rule.kind;
      if (rule.constructorOf) {
        const owner = rule.constructorOf === 'c' ? groups.c : parent?.name;
        if (name === owner) kind = 'constructor';
        else if (name === `~${owner}`) kind = 'method';
        else if (rule.constructorOf === 'parent') continue;
      }
      if (kind === 'function' && (groups.c || typeParent)) kind = 'method';
      if (lang === 'python' && kind === 'method' && name === '__init__') kind = 'constructor';

      stack.length = depth;
      if (typeParent && typeParent.memberIndent === null && rule.member) {
        typeParent.memberIndent = indent;
      }
      if (!rule.containerOnly) {
        const start = match.indices?.groups?.n?.[0] ?? 0;
        found.push({
          name,
          kind,
          container: groups.c ?? parent?.name ?? '',
          path,
          line,
          column: start + 1,
        });
      }
      if (rule.opens || rule.containerOnly) {
        stack.push({ name, kind, indent, isType: true, memberIndent: null });
      } else if (FUNCTION_KINDS.has(kind) && !signature) {
        stack.push({ name, kind, indent, isType: false, memberIndent: null });
      }
      break;
    }
  }
  return found;
}
