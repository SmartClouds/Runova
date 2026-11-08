/**
 * The rules for an unattended-access password (E61). Anyone signed in to Runova who knows the ID
 * can try it, so it has to stand up to guessing; the PAKE and the lockout stop guessing from
 * being cheap, and these rules stop it from being easy.
 */

const COMMON = new Set([
  '1234567890',
  '0123456789',
  '0987654321',
  'qwertyuiop',
  'asdfghjkl;',
  'password123',
  'password1234',
  'passw0rd123',
  'iloveyou123',
  'letmein1234',
  'welcome123',
  'admin12345',
  'administrator',
  'changeme123',
  'runova12345',
  'remotedesktop',
  'teamviewer',
  'anydesk1234',
]);

export const PASSWORD_MIN_LENGTH = 10;

/** Why the password will not do, or null when it is fine. */
export function passwordProblem(password: string): string | null {
  if ([...password].length < PASSWORD_MIN_LENGTH) {
    return `Use at least ${PASSWORD_MIN_LENGTH} characters. A short phrase works well.`;
  }
  if (COMMON.has(password.toLowerCase()))
    return 'That is one of the most common passwords. Pick something only you would use.';
  if (new Set(password).size === 1) return 'Do not just repeat one character.';
  return null;
}

/** 0 (none) to 4 (strong), for the meter under the field. */
export function passwordStrength(password: string): 0 | 1 | 2 | 3 | 4 {
  if (!password) return 0;
  const length = [...password].length;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  let score = 0;
  if (length >= PASSWORD_MIN_LENGTH) score++;
  if (length >= 14) score++;
  if (length >= 20) score++;
  if (classes >= 3) score++;
  if (passwordProblem(password)) score = Math.min(score, 1);
  return Math.max(1, Math.min(4, score)) as 1 | 2 | 3 | 4;
}
