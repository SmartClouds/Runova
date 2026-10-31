import type { DbEngine, StatementClass, StatementKind } from './types.js';

/**
 * Tells reads from writes, schema changes and admin actions, so a query an AI wrote, or one typed
 * into a read-only connection, can be held for approval. It works on the text alone and errs
 * toward "write": anything it does not recognize needs approval.
 *
 * This is a gate for the user's attention, not the only guard. Reads an AI asks to run also go
 * through a read-only transaction where the engine has one.
 */

const RANK: Readonly<Record<StatementKind, number>> = { read: 0, write: 1, ddl: 2, admin: 3 };

const READ: StatementClass = { kind: 'read', destructive: false };

function worst(classes: readonly StatementClass[]): StatementClass {
  let kind: StatementKind = 'read';
  let destructive = false;
  for (const item of classes) {
    if (RANK[item.kind] > RANK[kind]) kind = item.kind;
    destructive ||= item.destructive;
  }
  return { kind, destructive };
}

// ---------------------------------------------------------------------------------------------
// Splitting SQL into statements, with strings and comments masked out.

interface ScannedStatement {
  /** The statement as typed, trimmed. */
  text: string;
  /** The same statement in lower case with comments gone and quoted text blanked. */
  code: string;
}

/** Splits one batch of SQL (or CQL) on semicolons that are outside quotes and comments. */
function scanSql(engine: DbEngine, text: string): ScannedStatement[] {
  const backslashEscapes = engine === 'mysql' || engine === 'mariadb';
  const out: ScannedStatement[] = [];
  let start = 0;
  let code = '';
  let i = 0;
  const push = (end: number) => {
    const piece = text.slice(start, end).trim();
    const masked = code.trim();
    if (piece && masked) out.push({ text: piece, code: masked.toLowerCase() });
    code = '';
  };
  while (i < text.length) {
    const ch = text[i] as string;
    const next = text[i + 1];
    if (ch === '-' && next === '-') {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      code += ' ';
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      code += ' ';
      continue;
    }
    if (ch === '#' && backslashEscapes) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end;
      code += ' ';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`' || (ch === '[' && engine === 'mssql')) {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      while (j < text.length) {
        const c = text[j];
        if (c === '\\' && backslashEscapes && ch !== '`') {
          j += 2;
          continue;
        }
        if (c === close) {
          if (text[j + 1] === close) {
            j += 2;
            continue;
          }
          break;
        }
        j++;
      }
      // Quoted text keeps its place but loses its words, so "update" in a string is not a write.
      code += ch === "'" ? " '' " : ' x ';
      i = j + 1;
      continue;
    }
    if (ch === '$' && engine === 'postgres') {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i));
      if (tag) {
        const end = text.indexOf(tag[0], i + tag[0].length);
        i = end < 0 ? text.length : end + tag[0].length;
        code += " '' ";
        continue;
      }
    }
    if (ch === ';') {
      push(i);
      start = i + 1;
      i++;
      continue;
    }
    code += ch;
    i++;
  }
  push(text.length);
  return out;
}

function scan(engine: DbEngine, text: string): ScannedStatement[] {
  if (engine === 'redis') {
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
      .map((line) => ({ text: line, code: line.toLowerCase() }));
  }
  if (engine === 'mongodb') {
    const trimmed = text.trim();
    return trimmed ? [{ text: trimmed, code: maskJs(trimmed) }] : [];
  }
  if (engine === 'mssql') {
    return text.split(/^[ \t]*go[ \t]*$/im).flatMap((batch) => scanSql(engine, batch));
  }
  return scanSql(engine, text);
}

/** The statements in a query, as typed, for running one at a time. */
export function splitStatements(engine: DbEngine, text: string): string[] {
  return scan(engine, text).map((statement) => statement.text);
}

// ---------------------------------------------------------------------------------------------
// SQL and CQL.

const NEUTRAL = new Set([
  'begin',
  'commit',
  'rollback',
  'start',
  'end',
  'savepoint',
  'release',
  'consistency',
  'tracing',
  'paging',
  'expand',
]);
const READ_STARTS = new Set([
  'select',
  'with',
  'show',
  'explain',
  'describe',
  'desc',
  'values',
  'table',
  'use',
  'list',
  'help',
  'pragma',
]);
const WRITE_STARTS = new Set([
  'insert',
  'update',
  'delete',
  'merge',
  'replace',
  'upsert',
  'copy',
  'load',
]);
const DDL_STARTS = new Set(['create', 'alter', 'drop', 'rename', 'comment', 'truncate']);
const ADMIN_STARTS = new Set([
  'grant',
  'revoke',
  'set',
  'reset',
  'vacuum',
  'analyze',
  'analyse',
  'reindex',
  'cluster',
  'checkpoint',
  'kill',
  'shutdown',
  'backup',
  'restore',
  'exec',
  'execute',
  'call',
  'do',
  'flush',
  'optimize',
  'repair',
  'purge',
  'install',
  'uninstall',
  'lock',
  'unlock',
  'notify',
  'listen',
  'dbcc',
  'reconfigure',
  'attach',
  'detach',
  'handler',
  'import',
  'security',
  'prepare',
  'deallocate',
  'discard',
  'refresh',
  'cache',
  'change',
  'stop',
  'xa',
]);
const ACCOUNT_OBJECTS = new Set(['user', 'role', 'login', 'system', 'group', 'server']);
const WRITE_WORDS = /\b(insert|update|delete|merge|replace|upsert)\b/;
/** Functions that change state or reach outside the database even inside a SELECT. */
const RISKY_FUNCTIONS =
  /\b(pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_stat_file|lo_import|lo_export|lo_unlink|set_config|nextval|setval|dblink\w*|pg_advisory\w*|pg_switch_wal|pg_create\w*|pg_drop\w*|pg_promote|load_file|sleep|benchmark|xp_\w+|sp_\w+)\s*\(/;

function words(code: string): string[] {
  return code.match(/[a-z_][a-z0-9_$]*/g) ?? [];
}

function classifySql(statement: ScannedStatement): StatementClass | null {
  const code = statement.code.replace(/^[\s(]+/, '');
  const tokens = words(code);
  const head = tokens[0];
  if (!head) return null;

  if (head === 'begin' && (tokens[1] === 'batch' || tokens[2] === 'batch')) {
    return { kind: 'write', destructive: false };
  }
  if (NEUTRAL.has(head)) return null;

  if (head === 'explain') {
    const options = new Set([
      'analyze',
      'analyse',
      'verbose',
      'costs',
      'buffers',
      'format',
      'true',
      'on',
      'off',
      'false',
      'json',
      'text',
      'query',
      'plan',
      'extended',
      'settings',
      'wal',
      'timing',
      'summary',
    ]);
    let index = 1;
    let analyzes = false;
    while (index < tokens.length && options.has(tokens[index] as string)) {
      if (tokens[index] === 'analyze' || tokens[index] === 'analyse') analyzes = true;
      index++;
    }
    if (!analyzes) return READ;
    const rest = tokens.slice(index).join(' ');
    return classifySql({ text: rest, code: rest }) ?? READ;
  }

  if (head === 'pragma') {
    return code.includes('=') ? { kind: 'admin', destructive: false } : READ;
  }

  if (READ_STARTS.has(head)) {
    if (RISKY_FUNCTIONS.test(code)) return { kind: 'admin', destructive: false };
    if (head === 'select' || head === 'with' || head === 'values' || head === 'table') {
      if (WRITE_WORDS.test(code) || tokens.includes('into')) {
        return { kind: 'write', destructive: false };
      }
    }
    return READ;
  }

  if (WRITE_STARTS.has(head)) {
    const destructive = (head === 'update' || head === 'delete') && !tokens.includes('where');
    return { kind: 'write', destructive };
  }

  if (DDL_STARTS.has(head)) {
    const object = tokens[1] === 'or' ? tokens[3] : tokens[1];
    if (head !== 'comment' && head !== 'truncate' && ACCOUNT_OBJECTS.has(object ?? '')) {
      return { kind: 'admin', destructive: head === 'drop' };
    }
    const destructive =
      head === 'drop' || head === 'truncate' || (head === 'alter' && tokens.includes('drop'));
    return { kind: 'ddl', destructive };
  }

  if (ADMIN_STARTS.has(head)) return { kind: 'admin', destructive: head === 'shutdown' };

  return { kind: 'write', destructive: false };
}

// ---------------------------------------------------------------------------------------------
// Mongo shell queries.

/** Blanks the inside of JavaScript strings so method names in them are not read as calls. */
function maskJs(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const ch = text[i] as string;
    if (ch === "'" || ch === '"' || ch === '`') {
      let j = i + 1;
      while (j < text.length && text[j] !== ch) j += text[j] === '\\' ? 2 : 1;
      out += `${ch}${ch}`;
      i = j + 1;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

const MONGO_DB_READ = new Set([
  'getcollectionnames',
  'getcollectioninfos',
  'listcollections',
  'getname',
  'stats',
  'version',
  'serverstatus',
  'getusers',
  'getuser',
  'getroles',
  'getrole',
  'hostinfo',
  'currentop',
  'ismaster',
  'hello',
  'getprofilingstatus',
  'getlogcomponents',
  'printcollectionstats',
  'getsiblingdb',
  'getmongo',
  'serverbuildinfo',
  'serverCmdLineOpts'.toLowerCase(),
  'getreplicationinfo',
]);
const MONGO_DB_DDL = new Set(['createcollection', 'createview', 'dropdatabase']);
const MONGO_DB_ADMIN = new Set([
  'createuser',
  'updateuser',
  'dropuser',
  'dropallusers',
  'grantrolestouser',
  'revokerolesfromuser',
  'createrole',
  'updaterole',
  'droprole',
  'dropallroles',
  'grantprivilegestorole',
  'revokeprivilegesfromrole',
  'runcommand',
  'admincommand',
  'killop',
  'shutdownserver',
  'setprofilinglevel',
  'fsynclock',
  'fsyncunlock',
  'eval',
  'changeuserpassword',
  'setloglevel',
]);
const MONGO_READ = new Set([
  'find',
  'findone',
  'aggregate',
  'countdocuments',
  'estimateddocumentcount',
  'count',
  'distinct',
  'getindexes',
  'stats',
  'datasize',
  'storagesize',
  'totalsize',
  'totalindexsize',
  'watch',
  'listsearchindexes',
  'getsharddistribution',
  'explain',
  'isCapped'.toLowerCase(),
  'latencystats',
]);
const MONGO_WRITE = new Set([
  'insertone',
  'insertmany',
  'insert',
  'updateone',
  'updatemany',
  'update',
  'replaceone',
  'deleteone',
  'deletemany',
  'remove',
  'findoneandupdate',
  'findoneanddelete',
  'findoneandreplace',
  'findandmodify',
  'bulkwrite',
  'save',
]);
const MONGO_EVERY_ROW = new Set(['updatemany', 'deletemany', 'remove', 'update']);
const MONGO_DDL = new Set([
  'createindex',
  'createindexes',
  'ensureindex',
  'dropindex',
  'dropindexes',
  'drop',
  'renamecollection',
  'createsearchindex',
  'dropsearchindex',
  'updatesearchindex',
  'hideindex',
  'unhideindex',
]);
const MONGO_DDL_DESTRUCTIVE = new Set(['dropindex', 'dropindexes', 'drop', 'dropsearchindex']);

const WRITE_UNKNOWN: StatementClass = { kind: 'write', destructive: false };

function classifyMongo(statement: ScannedStatement): StatementClass {
  const code = statement.code;
  if (/^show\s+\w+\s*;?\s*$/i.test(code)) return READ;
  if (/^use\s+\S+\s*;?\s*$/i.test(code)) return READ;

  const dbLevel = /^db\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(code);
  if (dbLevel && dbLevel[1] !== 'getCollection') {
    const method = (dbLevel[1] as string).toLowerCase();
    if (MONGO_DB_READ.has(method)) return READ;
    if (MONGO_DB_DDL.has(method)) return { kind: 'ddl', destructive: method === 'dropdatabase' };
    if (MONGO_DB_ADMIN.has(method)) return { kind: 'admin', destructive: false };
    return WRITE_UNKNOWN;
  }

  const onCollection =
    /^db\s*(?:\.\s*getCollection\s*\([^)]*\)|\[[^\]]*\]|\.\s*[A-Za-z_$][\w$]*)\s*\.\s*([A-Za-z_$][\w$]*)\s*\(/.exec(
      code,
    );
  if (!onCollection) return WRITE_UNKNOWN;
  const method = (onCollection[1] as string).toLowerCase();
  const args = code.slice(onCollection.index + onCollection[0].length);
  if (method === 'aggregate') {
    return /\$(out|merge)\b/.test(statement.text) ? WRITE_UNKNOWN : READ;
  }
  if (MONGO_READ.has(method)) return READ;
  if (MONGO_WRITE.has(method)) {
    const everyRow = MONGO_EVERY_ROW.has(method) && /^\s*(\{\s*\}\s*)?[,)]/.test(args);
    return { kind: 'write', destructive: everyRow };
  }
  if (MONGO_DDL.has(method)) return { kind: 'ddl', destructive: MONGO_DDL_DESTRUCTIVE.has(method) };
  return WRITE_UNKNOWN;
}

// ---------------------------------------------------------------------------------------------
// Redis commands.

const REDIS_READ = new Set([
  'get',
  'mget',
  'getrange',
  'strlen',
  'exists',
  'type',
  'ttl',
  'pttl',
  'expiretime',
  'keys',
  'scan',
  'sscan',
  'hscan',
  'zscan',
  'randomkey',
  'dbsize',
  'info',
  'ping',
  'echo',
  'time',
  'hget',
  'hmget',
  'hgetall',
  'hkeys',
  'hvals',
  'hlen',
  'hexists',
  'hstrlen',
  'hrandfield',
  'lrange',
  'llen',
  'lindex',
  'lpos',
  'smembers',
  'scard',
  'sismember',
  'smismember',
  'srandmember',
  'sinter',
  'sunion',
  'sdiff',
  'sintercard',
  'zrange',
  'zrangebyscore',
  'zrevrange',
  'zrevrangebyscore',
  'zrangebylex',
  'zcard',
  'zscore',
  'zmscore',
  'zrank',
  'zrevrank',
  'zcount',
  'zlexcount',
  'zrandmember',
  'xrange',
  'xrevrange',
  'xlen',
  'xread',
  'xinfo',
  'xpending',
  'pfcount',
  'getbit',
  'bitcount',
  'bitpos',
  'geopos',
  'geodist',
  'geohash',
  'georadius_ro',
  'geosearch',
  'object',
  'dump',
  'lastsave',
  'role',
  'command',
  'select',
  'json.get',
  'json.type',
  'json.mget',
  'json.objkeys',
  'json.strlen',
  'json.arrlen',
  'ft.search',
  'ft.info',
  'ft._list',
  'ft.aggregate',
  'ts.get',
  'ts.range',
  'ts.info',
  'touch',
]);
const REDIS_ADMIN = new Set([
  'flushdb',
  'flushall',
  'shutdown',
  'save',
  'bgsave',
  'bgrewriteaof',
  'replicaof',
  'slaveof',
  'debug',
  'module',
  'script',
  'function',
  'eval',
  'evalsha',
  'eval_ro',
  'evalsha_ro',
  'fcall',
  'fcall_ro',
  'failover',
  'monitor',
  'sync',
  'psync',
  'swapdb',
  'migrate',
  'auth',
]);
const REDIS_DESTRUCTIVE = new Set(['flushdb', 'flushall', 'shutdown', 'del', 'unlink']);
/** Commands whose subcommand decides: these subcommands only read. */
const REDIS_READ_SUBCOMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  config: new Set(['get']),
  client: new Set(['list', 'info', 'getname', 'id', 'getredir', 'trackinginfo']),
  acl: new Set(['whoami', 'list', 'users', 'cat', 'getuser', 'log', 'genpass']),
  slowlog: new Set(['get', 'len']),
  memory: new Set(['usage', 'stats', 'doctor', 'malloc-stats']),
  cluster: new Set(['info', 'nodes', 'slots', 'shards', 'myid', 'keyslot', 'countkeysinslot']),
  latency: new Set(['latest', 'history', 'doctor', 'graph']),
  pubsub: new Set(['channels', 'numsub', 'numpat', 'shardchannels', 'shardnumsub']),
};

function classifyRedis(statement: ScannedStatement): StatementClass {
  const [command = '', sub = ''] = statement.code.split(/\s+/);
  const subcommands = REDIS_READ_SUBCOMMANDS[command];
  if (subcommands) {
    return subcommands.has(sub) ? READ : { kind: 'admin', destructive: false };
  }
  if (REDIS_READ.has(command)) return READ;
  const destructive = REDIS_DESTRUCTIVE.has(command);
  if (REDIS_ADMIN.has(command)) return { kind: 'admin', destructive };
  return { kind: 'write', destructive };
}

// ---------------------------------------------------------------------------------------------

/** How serious a query is, taking the most serious of its statements. */
export function classifyStatement(engine: DbEngine, text: string): StatementClass {
  const statements = scan(engine, text);
  if (engine === 'redis') return worst(statements.map(classifyRedis));
  if (engine === 'mongodb') return worst(statements.map(classifyMongo));
  return worst(statements.map(classifySql).filter((item): item is StatementClass => item !== null));
}
