// Which spec folders belong to which Playwright project.
//
// Playwright matches a relative glob such as 'admin/**' against the whole absolute path, not
// against the path under testDir. A checkout in /home/admin (the CI Linux VM's user) then puts
// every spec in the admin project and none in chromium. These patterns only look at the folder
// under e2e/, so the place the repo is checked out does not matter.
const inFolder = (name: string) => `[\\\\/]e2e[\\\\/]${name}[\\\\/]`;

/** Every spec file under e2e/admin. */
export const ADMIN_SPECS = new RegExp(`${inFolder('admin')}.*\\.spec\\.ts$`);

/** Every spec file under e2e/captcha. */
export const CAPTCHA_SPECS = new RegExp(`${inFolder('captcha')}.*\\.spec\\.ts$`);

/** What the chromium project leaves out: the folders other projects or configs own. */
export const CHROMIUM_IGNORE = [
  new RegExp(inFolder('admin')),
  new RegExp(inFolder('captcha')),
  new RegExp(inFolder('stack')),
];
