import { describe, expect, it } from 'vitest';
import {
  type BlueprintPromptInput,
  buildBlueprintGenerationRequest,
  buildBlueprintPrompt,
} from './prompt.js';

function input(overrides: Partial<BlueprintPromptInput> = {}): BlueprintPromptInput {
  return {
    projectName: 'CuraLink',
    agentLabel: 'Claude Code',
    targetAI: 'Claude Code',
    docsFolder: 'docs',
    sections: [{ stepId: 'idea', text: 'A clinic portal.', attachmentNames: [] }],
    confirmBeforeWriting: false,
    ...overrides,
  };
}

describe('buildBlueprintPrompt', () => {
  it('asks for a backlog when the relay is off', () => {
    const prompt = buildBlueprintPrompt(input());
    expect(prompt).toContain('docs/BACKLOG.md');
    expect(prompt).not.toContain('docs/tasks/');
  });

  it('asks for Relay task files instead of a backlog when the relay is on', () => {
    const prompt = buildBlueprintPrompt(input({ relay: { enabled: true, budgetTokens: 200_000 } }));
    expect(prompt).not.toContain('BACKLOG.md');
    expect(prompt).toContain('docs/tasks/');
    expect(prompt).toContain('docs/tasks/RELAY.md');
    expect(prompt).toContain('200K');
    expect(prompt).toMatch(/so each fits one AI session/);
  });

  it('lets a task run over several sessions when the relay keeps rolling', () => {
    const prompt = buildBlueprintPrompt(
      input({ relay: { enabled: true, budgetTokens: 200_000, keepRolling: true } }),
    );
    expect(prompt).not.toMatch(/so each fits one AI session/);
    expect(prompt).toMatch(/may run over several AI sessions/);
    expect(prompt).toMatch(/carries on in a new session/);
    expect(prompt).not.toContain('—');
  });
});

describe('buildBlueprintGenerationRequest', () => {
  it('passes the relay instructions on to the prompt it asks for', () => {
    const request = buildBlueprintGenerationRequest(
      input({ relay: { enabled: true, budgetTokens: 400_000 } }),
    );
    expect(request).not.toContain('BACKLOG.md');
    expect(request).toContain('docs/tasks/');
    expect(request).toContain('400K');
    expect(request).toMatch(/sized to finish in one AI session/);
  });

  it('says a task may take several sessions when the relay keeps rolling', () => {
    const request = buildBlueprintGenerationRequest(
      input({ relay: { enabled: true, budgetTokens: 400_000, keepRolling: true } }),
    );
    expect(request).toMatch(/a task may take several sessions/);
    expect(request).not.toMatch(/sized to finish in one AI session/);
  });

  it('keeps the backlog when the relay is off', () => {
    expect(buildBlueprintGenerationRequest(input())).toContain('docs/BACKLOG.md');
  });
});

describe('the plan pack in a Blueprint prompt', () => {
  it('writes the plan, milestones, risks and questions next to the tasks when Relay is on', () => {
    const prompt = buildBlueprintPrompt(input({ relay: { enabled: true, budgetTokens: 200_000 } }));
    expect(prompt).toContain('docs/tasks/PLAN.md');
    expect(prompt).toContain('mode: fit');
    expect(prompt).toContain('docs/tasks/milestones/M001-slug.md');
    expect(prompt).toContain('docs/tasks/risks/R001-slug.md');
    expect(prompt).toContain('docs/tasks/questions/Q001-slug.md');
    expect(prompt).not.toContain('MILESTONES.md');
  });

  it('keeps MILESTONES.md and RISKS.md when Relay is off', () => {
    const prompt = buildBlueprintPrompt(input());
    expect(prompt).toContain('docs/MILESTONES.md');
    expect(prompt).toContain('docs/RISKS.md');
    expect(prompt).not.toContain('PLAN.md');
  });

  it('asks for specced parts with no budget in plan mode', () => {
    const prompt = buildBlueprintPrompt(
      input({ relay: { enabled: true, budgetTokens: 200_000, mode: 'plan' } }),
    );
    expect(prompt).toContain('mode: plan');
    expect(prompt).toMatch(/There is no context budget/);
    expect(prompt).toContain('Interfaces and files');
    expect(prompt).not.toContain('budget: 200000');
    expect(prompt).not.toContain('200K');
    const request = buildBlueprintGenerationRequest(
      input({ relay: { enabled: true, budgetTokens: 200_000, mode: 'plan' } }),
    );
    expect(request).toMatch(/sized by what it delivers, with a full spec and no context budget/);
    expect(request).not.toContain('—');
  });
});
