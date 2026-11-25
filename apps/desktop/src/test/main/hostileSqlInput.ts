/**
 * Strings that would change a query if any of them were pasted into SQL text instead of bound as
 * a parameter. The injection tests for the app's own SQLite stores send these through each store's
 * public functions and check they come back as plain data: stored and read verbatim, matching only
 * the rows that literally hold them, and leaving every other row and table alone.
 */

/** Closes the string, drops the store's own table and comments the rest of the statement out. */
export function dropTable(table: string): string {
  return `'; DROP TABLE ${table}; --`;
}

/** Turns a WHERE clause into one that matches every row. */
export const ALWAYS_TRUE = "' OR '1'='1";

/** Every probe at once, aimed at `table`. */
export function hostileSqlValues(table: string): string[] {
  return [
    dropTable(table),
    ALWAYS_TRUE,
    '" OR "1"="1',
    `x'); DELETE FROM ${table}; --`,
    "it''s doubled",
    'back\\slash',
    '%',
    '_',
    '100%_done',
  ];
}
