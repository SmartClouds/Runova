/** Where a server core lives on the server, and the names it answers to on the wire. */
export interface CoreNames {
  root: string;
  releases: string;
  current: string;
  binary: string;
  /** The program through the current link, as the unit starts it. */
  binaryPath: string;
  socketPath: string;
  dataDirectory: string;
  configDirectory: string;
  unit: string;
  unitFile: string;
  unitPath: string;
  group: string;
  tarballPrefix: string;
  host: string;
  authPrefix: string;
  execPrefix: string;
  versionHeader: string;
  fileHeader: string;
  sha256Header: string;
}

const ROOT = '/opt/runova-core';
const BINARY = 'runova-core';
const UNIT = 'runova-core';

export const RUNOVA_CORE: CoreNames = {
  root: ROOT,
  releases: `${ROOT}/releases`,
  current: `${ROOT}/current`,
  binary: BINARY,
  binaryPath: `${ROOT}/current/${BINARY}`,
  socketPath: '/run/runova-core/core.sock',
  dataDirectory: '/var/lib/runova-core',
  configDirectory: '/etc/runova-core',
  unit: UNIT,
  unitFile: `${UNIT}.service`,
  unitPath: `/etc/systemd/system/${UNIT}.service`,
  group: 'runova',
  tarballPrefix: 'runova-core-',
  host: 'runova-core',
  authPrefix: 'runova-core/auth/v1',
  execPrefix: 'runova-core/exec/v1',
  versionHeader: 'x-runova-core-version',
  fileHeader: 'x-runova-core-file',
  sha256Header: 'x-runova-core-sha256',
};
