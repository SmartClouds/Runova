#!/usr/bin/env node
// Turns a release tag into the phone apps' version, so nobody has to bump one by hand.
//
//   node scripts/mobile-version.mjs v1.2.3   prints VERSION_NAME=... and VERSION_CODE=... for `eval`

import { pathToFileURL } from 'node:url';

const TAG = /^v(\d+)\.(\d+)\.(\d+)$/;
const MAX_PART = 999;
const MAX_MAJOR = 2099;

export function mobileVersion(tag) {
  const match = TAG.exec(tag);
  if (!match) throw new Error(`${tag} is not a release tag like v1.2.3.`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major > MAX_MAJOR || minor > MAX_PART || patch > MAX_PART) {
    throw new Error(`${tag} has a part too big for a build number.`);
  }
  return { name: `${major}.${minor}.${patch}`, code: major * 1_000_000 + minor * 1_000 + patch };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { name, code } = mobileVersion(process.argv[2] ?? '');
  process.stdout.write(`VERSION_NAME=${name}\nVERSION_CODE=${code}\n`);
}
