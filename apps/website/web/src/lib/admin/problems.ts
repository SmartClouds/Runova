/**
 * Field errors from a `validation-failed` problem. Its keys are the JSON paths of the request
 * fields (`title`, `cveIds[1]`, `technologies[0].versionRange`), so each form control asks for
 * the path it edits.
 */

export type FieldErrors = Record<string, string[]>;

/** The messages for exactly this path. */
export function errorsFor(errors: FieldErrors, path: string): string[] {
  return errors[path] ?? [];
}

/**
 * The messages for a list field shown as one control: its own, then each entry's, numbered from 1
 * so the editor knows which line to fix.
 */
export function errorsUnder(errors: FieldErrors, field: string): string[] {
  const own = errorsFor(errors, field);
  const entries = Object.entries(errors)
    .map(([key, messages]) => ({ match: new RegExp(`^${field}\\[(\\d+)\\]$`).exec(key), messages }))
    .filter(({ match }) => match !== null)
    .sort((a, b) => Number(a.match?.[1]) - Number(b.match?.[1]))
    .flatMap(({ match, messages }) =>
      messages.map((message) => `Entry ${Number(match?.[1]) + 1}: ${message}`),
    );
  return [...own, ...entries];
}

/** The top-level field a path belongs to: `technologies` for `technologies[0].fixedIn`. */
const rootOf = (path: string) => path.split(/[.[]/, 1)[0];

/** The messages whose field is not on the form, so the error summary can still show them. */
export function unplacedErrors(errors: FieldErrors, fields: string[]): string[] {
  return Object.entries(errors)
    .filter(([key]) => !fields.includes(rootOf(key)))
    .flatMap(([, messages]) => messages);
}
