import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseHealthResponse } from './parse.js';
import { INITIAL_HEALTH_TRACK, nextHealthTrack } from './transitions.js';
import type { HealthProbeState, HealthReport } from './types.js';

/**
 * The cases in fixtures/ are shared with the monitoring nodes' C# port
 * (apps/website/api/tests/Runova.Monitoring.Tests/Health/FixtureTests.cs), which runs the same
 * files. A case that passes here and fails there, or the other way round, means the two parsers
 * have drifted apart.
 *
 * A parse case gives the response as `json` (sent as JSON.stringify of it) or as a raw `body`
 * string, for text that is not JSON or that JSON.parse reads in a way worth pinning down. The
 * defaults are HTTP 200, application/health+json, 42 ms and the AT below. Every field of `expect`
 * is optional; a service in `services` is compared on the fields it lists, and so is its error.
 */

const AT = 1_760_000_000_000;

interface ParseCase {
  name: string;
  input: {
    httpStatus?: number;
    contentType?: string | null;
    latencyMs?: number | null;
    checkedAt?: number;
    knownSecrets?: string[];
    json?: unknown;
    body?: string;
  };
  expect: Partial<Omit<HealthReport, 'services'>> & {
    services?: Record<string, unknown>[];
    serviceKeys?: string[];
    rawContains?: string[];
    rawExcludes?: string[];
    excludes?: string[];
  };
}

interface TransitionCase {
  name: string;
  confirm?: number;
  states: HealthProbeState[];
  expect: {
    events: string[];
    confirmed: 'ok' | 'problem' | null;
    streak: number;
    pending: boolean;
  };
}

function fixture<T>(name: string): T[] {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf-8')) as T[];
}

const REPORT_FIELDS = [
  'state',
  'httpStatus',
  'latencyMs',
  'checkedAt',
  'serviceId',
  'description',
  'releaseId',
  'version',
  'output',
  'problem',
  'raw',
] as const;

describe('the shared parse fixtures', () => {
  const cases = fixture<ParseCase>('parse.json');

  it('has cases', () => {
    expect(cases.length).toBeGreaterThan(20);
  });

  it.each(cases.map((one) => [one.name, one] as const))('%s', (_name, { input, expect: want }) => {
    const report = parseHealthResponse({
      httpStatus: input.httpStatus ?? 200,
      contentType: input.contentType === undefined ? 'application/health+json' : input.contentType,
      body: input.body ?? JSON.stringify(input.json),
      latencyMs: input.latencyMs === undefined ? 42 : input.latencyMs,
      checkedAt: input.checkedAt ?? AT,
      knownSecrets: input.knownSecrets,
    });

    for (const field of REPORT_FIELDS) {
      if (field in want) expect(report[field], field).toEqual(want[field]);
    }
    if (want.serviceKeys)
      expect(report.services.map((service) => service.key)).toEqual(want.serviceKeys);
    if (want.services) {
      expect(report.services).toHaveLength(want.services.length);
      want.services.forEach((service, index) => {
        const { error, ...rest } = service;
        expect(report.services[index]).toMatchObject(rest);
        if (error === null) expect(report.services[index].error).toBeNull();
        else if (error !== undefined) expect(report.services[index].error).toMatchObject(error);
      });
    }
    for (const text of want.rawContains ?? []) expect(report.raw).toContain(text);
    for (const text of want.rawExcludes ?? []) expect(report.raw ?? '').not.toContain(text);
    const all = JSON.stringify(report);
    for (const text of want.excludes ?? []) expect(all).not.toContain(text);
  });
});

describe('the shared transition fixtures', () => {
  const cases = fixture<TransitionCase>('transitions.json');

  it.each(cases.map((one) => [one.name, one] as const))(
    '%s',
    (_name, { confirm, states, expect: want }) => {
      let track = INITIAL_HEALTH_TRACK;
      const events: string[] = [];
      for (const state of states) {
        const step = nextHealthTrack(track, state, confirm);
        track = step.track;
        if (step.opened) events.push('opened');
        if (step.resolved) events.push('resolved');
      }
      expect(events).toEqual(want.events);
      expect(track).toEqual({
        confirmed: want.confirmed,
        streak: want.streak,
        pending: want.pending,
      });
    },
  );
});
