/** The `?tab=` value that opens MCP Servers on the Dev Tools page. */
export const MCP_TAB = 'mcp';

/** Dev Tools on the MCP Servers tab, where the old `/mcp` page went. */
export const MCP_ROUTE = `/tools?tab=${MCP_TAB}`;

/** The MCP Servers tab with `projectId` already picked as the target project. */
export function mcpRouteFor(projectId: string): string {
  return `${MCP_ROUTE}&projectId=${encodeURIComponent(projectId)}`;
}
