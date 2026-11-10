import { join } from 'node:path';
import { app } from 'electron';
import { isE2E, userDataOverride } from './testMode';

export const APP_NAME = 'Runova';
export const DEV_APP_NAME = 'Runova Dev';

// package.json has no productName, so Electron would name the profile folder after the package
// ("@runova/desktop"). Dev runs get a folder of their own so they never share data or the
// single-instance lock with an installed release. This runs right after testMode, before anything
// reads userData.
//
// The end-to-end suite points appData at a folder of its own, so it never touches this machine's
// real profiles.
const e2eAppData = isE2E ? process.env.RUNOVA_E2E_APP_DATA?.trim() : undefined;
// A profile chosen on purpose is used as it is.
if (e2eAppData || !(userDataOverride || app.commandLine.hasSwitch('user-data-dir'))) {
  const appData = e2eAppData || app.getPath('appData');
  app.setPath('userData', join(appData, app.isPackaged ? APP_NAME : DEV_APP_NAME));
}
