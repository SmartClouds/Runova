/**
 * GitHub's page for a new fine-grained token, filled in for one repository's releases (E105).
 * GitHub takes the name, description, owner and permissions as URL parameters; which
 * repositories the token reaches cannot be filled in, so the person still picks that.
 */

export const NEW_TOKEN_URL = 'https://github.com/settings/personal-access-tokens/new';

/** GitHub refuses a longer name in the URL. */
const NAME_LIMIT = 40;

export function newReleaseTokenUrl(repository: string): string {
  const owner = repository.split('/')[0] ?? '';
  const query = new URLSearchParams({
    name: `Runova releases ${repository}`.slice(0, NAME_LIMIT),
    description: `Lets a Runova server download the release images of ${repository}. Read-only.`,
    target_name: owner,
    contents: 'read',
  });
  return `${NEW_TOKEN_URL}?${query.toString()}`;
}
