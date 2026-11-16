/**
 * Rules for a GitHub self-hosted runner's name, shared by the Add runner dialog and the main
 * process that registers it, so both refuse the same names with the same words.
 */

export const RUNNER_NAME_MAX = 64;

const ALLOWED = /^[A-Za-z0-9._-]+$/;
const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** What is wrong with `name`, or null when it can be used. `taken` are the repo's runner names. */
export function validateRunnerName(name: string, taken: readonly string[]): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'Give the runner a name.';
  if (!ALLOWED.test(trimmed)) {
    return 'Use only letters, digits, dots, dashes and underscores.';
  }
  if (trimmed.length > RUNNER_NAME_MAX) {
    return `Keep it to ${RUNNER_NAME_MAX} characters or fewer.`;
  }
  const lower = trimmed.toLowerCase();
  if (taken.some((other) => other.toLowerCase() === lower)) {
    return `A runner called ${trimmed} is already registered here.`;
  }
  return null;
}

/**
 * A name that passes `validateRunnerName`, made from a host name or a server's nickname. A host
 * name keeps only its first label, the way `config.sh` names a runner by default.
 */
export function runnerNameFrom(source: string): string {
  const trimmed = source.trim();
  const base = IPV4.test(trimmed) || /\s/.test(trimmed) ? trimmed : trimmed.split('.')[0];
  const slug = base
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, RUNNER_NAME_MAX)
    .replace(/-+$/g, '');
  return slug || 'runner';
}
