/**
 * Agent ids the `skills` CLI (skills.sh) recognizes, with the Runova CLI each one belongs to.
 * The Skills page installs for all of them; the security audit picks from them.
 */
export const SKILLS_CLI_AGENTS: readonly { value: string; cliId: string }[] = [
  { value: 'claude-code', cliId: 'claude-code' },
  { value: 'codex', cliId: 'codex-cli' },
  { value: 'cursor', cliId: 'cursor-cli' },
  { value: 'opencode', cliId: 'opencode' },
  { value: 'gemini-cli', cliId: 'gemini-cli' },
];
