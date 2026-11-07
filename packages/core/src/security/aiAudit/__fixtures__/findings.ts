/**
 * findings.json records shaped exactly as the skill's report-schema.json describes them, one per
 * verdict, plus helpers to vary them.
 */

export const CONFIRMED_SQLI = {
  verdict: 'confirmed',
  fingerprint: 'sqli:src/db/users.ts:42',
  title: 'SQL injection in user search',
  description: 'The search term is concatenated into a SQL string.',
  root_cause: 'String concatenation instead of a parameterized query.',
  intended_behavior: 'Search terms are treated as data.',
  trace: [
    {
      kind: 'entrypoint',
      file: 'src/routes/users.ts',
      line: 12,
      scope: 'GET /users',
      description: 'q is read from the query string.',
    },
    {
      kind: 'sink',
      file: 'src/db/users.ts',
      line: 42,
      scope: 'searchUsers',
      description: 'q reaches db.query unescaped.',
    },
  ],
  evidence: [{ file: 'src/db/users.ts', line: 42, description: 'db.query(`... ${q}`)' }],
  conditions: [{ kind: 'authentication_level', description: 'Any signed-in user.' }],
  execution: {
    attacker_perspective: 'A signed-in user with no special role.',
    payloads: ["' OR 1=1 --"],
    instructions: ['Send GET /users?q=%27%20OR%201%3D1%20--'],
    observed_result: 'Every user row is returned.',
  },
  remediation: {
    strategy: 'Use a parameterized query.',
    code_changes: [{ file_name: 'src/db/users.ts', fixed_code: 'db.query(sql, [q])' }],
  },
  severity: {
    likelihood: { score: 'high', reason: 'Reachable by any user.' },
    impact: { score: 'high', reason: 'Reads every user.' },
    overall_severity: 'high',
  },
  confidence: { score: 'high', reason: 'Reproduced locally.' },
};

export const CONFIRMED_LOW = {
  ...CONFIRMED_SQLI,
  fingerprint: 'headers:src/server.ts:3',
  title: 'Missing security headers',
  severity: {
    likelihood: { score: 'low', reason: 'Needs another bug.' },
    impact: { score: 'low', reason: 'Defense in depth.' },
    overall_severity: 'low',
  },
};

export const CONFIRMED_CRITICAL = {
  ...CONFIRMED_SQLI,
  fingerprint: 'rce:src/admin/run.ts:9',
  title: 'Command injection in admin runner',
  severity: {
    likelihood: { score: 'high', reason: 'Unauthenticated.' },
    impact: { score: 'critical', reason: 'Code execution.' },
    overall_severity: 'critical',
  },
};

export const NEEDS_VALIDATION_SSRF = {
  verdict: 'needs_validation',
  fingerprint: 'ssrf:src/fetch.ts:20',
  title: 'Possible SSRF in the image proxy',
  description: 'The proxy fetches a user supplied URL.',
  claimed_root_cause: 'No allow list for hosts.',
  trace: [
    {
      kind: 'sink',
      file: 'src/fetch.ts',
      line: 20,
      scope: 'proxyImage',
      description: 'fetch(url)',
    },
  ],
  evidence: [{ file: 'src/fetch.ts', line: 20, description: 'fetch(url)' }],
  blockers: ['Whether the deployment blocks metadata IPs is unknown.'],
  validation_plan: { deployment: 'Request http://169.254.169.254 through the proxy.' },
};

export const REJECTED_XSS = {
  verdict: 'rejected',
  fingerprint: 'xss:src/view.tsx:8',
  title: 'XSS in the profile view',
  description: 'A name is rendered into the page.',
  claimed_root_cause: 'Unescaped output.',
  trace: [{ kind: 'sink', file: 'src/view.tsx', line: 8, scope: 'Profile', description: '{name}' }],
  evidence: [{ file: 'src/view.tsx', line: 8, description: 'React escapes it.' }],
  reason: 'React escapes text children.',
};
