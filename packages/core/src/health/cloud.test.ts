import { describe, expect, it } from 'vitest';
import { cloudIntervalChoices, cloudSecretFor, cloudUrlProblem } from './cloud.js';

describe('cloudUrlProblem', () => {
  it('lets a public https address through', () => {
    expect(cloudUrlProblem('https://api.example.com/health', false)).toBeNull();
    expect(cloudUrlProblem('https://93.184.216.34:8443/health', false)).toBeNull();
    expect(cloudUrlProblem('https://[2606:4700::1111]/health', false)).toBeNull();
  });

  it('takes plain http only when the monitor allows it', () => {
    expect(cloudUrlProblem('http://api.example.com/health', false)).toMatch(/https/);
    expect(cloudUrlProblem('http://api.example.com/health', true)).toBeNull();
  });

  it.each([
    ['https://localhost:3000/health'],
    ['https://app.localhost/health'],
    ['https://127.0.0.1/health'],
    ['https://[::1]/health'],
  ])('says %s is on this computer', (url) => {
    expect(cloudUrlProblem(url, true)).toMatch(/on this computer/);
  });

  it.each([
    ['https://10.0.0.5/health'],
    ['https://172.16.4.1/health'],
    ['https://192.168.1.20/health'],
    ['https://100.64.0.9/health'],
    ['https://169.254.169.254/latest'],
    ['https://[fd00::5]/health'],
    ['https://[fe80::1]/health'],
    ['https://[::ffff:192.168.1.2]/health'],
    ['https://nas.local/health'],
    ['https://db.internal/health'],
    ['https://intranet/health'],
  ])('says %s is on a private network', (url) => {
    expect(cloudUrlProblem(url, true)).toMatch(/private network/);
  });

  it('refuses what is not a full web address', () => {
    expect(cloudUrlProblem('api.example.com/health', false)).toMatch(/full address/);
    expect(cloudUrlProblem('ftp://api.example.com/', false)).toMatch(/http or https/);
  });
});

describe('cloudIntervalChoices', () => {
  it('offers only the presets at or above the floor', () => {
    expect(cloudIntervalChoices(300)).toEqual([300, 900, 3600, 21_600, 86_400]);
    expect(cloudIntervalChoices(30)).toEqual([30, 60, 300, 900, 3600, 21_600, 86_400]);
  });

  it('starts at the floor itself when no preset is it', () => {
    expect(cloudIntervalChoices(120)).toEqual([120, 300, 900, 3600, 21_600, 86_400]);
  });
});

describe('cloudSecretFor', () => {
  it('sends a bearer key as it is and basic as user:password', () => {
    expect(cloudSecretFor('bearer', null, 'k3y')).toBe('k3y');
    expect(cloudSecretFor('basic', 'runova', 'pa55')).toBe('runova:pa55');
  });
});
