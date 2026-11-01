import { APIConnectionError, APIConnectionTimeoutError, APIError } from 'cloudflare/core/error';
import { permissionDeniedMessage } from '../../../shared/cloudflare/permissions';
import { encodeCloudflareError } from '../../../shared/cloudflareErrors';
import type { CloudflareAnyPermissionId } from '../../../shared/cloudflareTypes';

/**
 * Turns whatever a Cloudflare call threw into an Error the page can show. The SDK's own message
 * is the status and the entire response body as JSON, so it is never used; Cloudflare's `errors`
 * list says the same thing in words. The token is scrubbed from the result in any case.
 */

const SCRUBBED = '[token]';

function cloudflareWords(error: APIError): string {
  return error.errors
    .filter((entry) => typeof entry.message === 'string' && entry.message.length > 0)
    .map((entry) =>
      entry.code === undefined ? entry.message : `${entry.message} (code ${entry.code})`,
    )
    .join('; ');
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join(SCRUBBED) : text;
}

function explain(error: unknown, permission?: CloudflareAnyPermissionId): string {
  if (error instanceof APIConnectionTimeoutError) {
    return 'Cloudflare took too long to answer. Try again in a moment.';
  }
  if (error instanceof APIConnectionError) {
    return 'Could not reach Cloudflare. Check the internet connection and try again.';
  }
  if (error instanceof APIError) {
    const words = cloudflareWords(error);
    if (error.status === 401) {
      return encodeCloudflareError(
        'token-rejected',
        'Cloudflare no longer accepts the saved token: it may have been deleted, rolled or expired. Paste a new one.',
      );
    }
    if (error.status === 403 && permission) {
      return encodeCloudflareError(
        'missing-permission',
        permissionDeniedMessage(permission),
        permission,
      );
    }
    if (error.status === 403) return `Cloudflare refused that: ${words || 'permission denied'}`;
    if (error.status === 429) {
      return 'Cloudflare is limiting requests from this token right now. Wait a minute and try again.';
    }
    if (words) return `Cloudflare said: ${words}`;
    return `Cloudflare answered with status ${error.status}. Try again in a moment.`;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * An Error for the page. `permission` is the one the call needed: a 403 then names it, so the
 * page can show exactly what to add to the token.
 */
export function cloudflareFailure(
  error: unknown,
  token: string,
  permission?: CloudflareAnyPermissionId,
): Error {
  return new Error(scrub(explain(error, permission), token));
}

/** Whether Cloudflare refused the call for want of a permission. */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof APIError && error.status === 403;
}

/** Whether Cloudflare did not accept the credentials at all. */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof APIError && error.status === 401;
}

/** Whether Cloudflare answered "not found". */
export function isNotFound(error: unknown): boolean {
  return error instanceof APIError && error.status === 404;
}

/** Whether Cloudflare's answer carries any of these error codes. */
export function hasCloudflareCode(error: unknown, ...codes: number[]): boolean {
  return (
    error instanceof APIError &&
    error.errors.some((entry) => typeof entry.code === 'number' && codes.includes(entry.code))
  );
}

/** Whether Cloudflare said the call came too often. */
export function isRateLimited(error: unknown): boolean {
  return error instanceof APIError && error.status === 429;
}
