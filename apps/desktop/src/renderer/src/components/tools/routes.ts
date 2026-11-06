/**
 * The `?tab=` value for every tool card on the Agent Tools page. The page opens on AI CLIs when
 * there is no tab, so the tool list needs a value of its own.
 */
export const ALL_TOOLS_TAB = 'all';

/** Agent Tools on the full tool list, for links about a tool card rather than a CLI. */
export const ALL_TOOLS_ROUTE = `/tools?tab=${ALL_TOOLS_TAB}`;

/** Dev Setup, where the GitHub CLI and the other developer tools are installed. */
export const DEV_SETUP_ROUTE = '/tools?tab=dev-setup';
