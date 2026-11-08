import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mobileVersion } from './mobile-version.mjs';

test('reads the version name from a release tag', () => {
  assert.equal(mobileVersion('v1.2.3').name, '1.2.3');
});

test('makes a build number that grows with every release', () => {
  assert.equal(mobileVersion('v1.2.3').code, 1002003);
  assert.ok(mobileVersion('v1.2.4').code > mobileVersion('v1.2.3').code);
  assert.ok(mobileVersion('v1.3.0').code > mobileVersion('v1.2.999').code);
  assert.ok(mobileVersion('v2.0.0').code > mobileVersion('v1.999.999').code);
});

test('stays inside what the Play Store accepts', () => {
  assert.ok(mobileVersion('v2099.999.999').code <= 2100000000);
});

test('refuses a tag that is not a release', () => {
  assert.throws(() => mobileVersion('nightly'), /nightly/);
  assert.throws(() => mobileVersion('v1.2'), /v1\.2/);
  assert.throws(() => mobileVersion('v1.2.3-beta'), /beta/);
});

test('refuses a part too big for its place in the build number', () => {
  assert.throws(() => mobileVersion('v1.1000.0'), /1000/);
  assert.throws(() => mobileVersion('v1.0.1000'), /1000/);
  assert.throws(() => mobileVersion('v2100.0.0'), /2100/);
});
