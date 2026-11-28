import { describe, expect, it } from 'vitest';
import {
  appendJournalEntry,
  archiveRelPath,
  bodySection,
  itemFileName,
  itemFolderRelPath,
  itemIdFromFileName,
  journalRelPath,
  journalResult,
  nextItemId,
  parseItemFile,
  parseJournal,
  parsePlanFile,
  planRelPath,
  planRunOptions,
  RELAY_ITEM_KINDS,
  RELAY_ITEM_SPECS,
  renderAttemptArchive,
  renderItemFile,
  renderPlanFile,
} from './plan.js';

describe('PLAN.md', () => {
  it('round-trips the plan and its settings', () => {
    const text = renderPlanFile({
      title: 'Patient search',
      mode: 'plan',
      keepRolling: true,
      runPastBudget: true,
      reviewEachTask: true,
      definitionOfDone: ['Tests pass on CI', 'Docs updated'],
      goal: 'Staff find a patient in two keystrokes.',
      outOfScope: 'Archived patients.',
    });
    const plan = parsePlanFile(text);
    expect(plan).toMatchObject({
      title: 'Patient search',
      mode: 'plan',
      budget: null,
      keepRolling: true,
      runPastBudget: true,
      reviewEachTask: true,
      definitionOfDone: ['Tests pass on CI', 'Docs updated'],
      issues: [],
    });
    expect(bodySection(plan.body, 'Goal')).toBe('Staff find a patient in two keystrokes.');
    expect(bodySection(plan.body, 'Definition of done')).toContain('- Docs updated');
    expect(text).not.toContain('—');
  });

  it('reads a hand-written plan leniently and says what it could not use', () => {
    const plan = parsePlanFile(
      '---\nmode: sometimes\nbudget: lots\nkeepRolling: yes\n---\n# Rebuild the API\n',
    );
    expect(plan.title).toBe('Rebuild the API');
    expect(plan.mode).toBe('fit');
    expect(plan.keepRolling).toBe(true);
    expect(plan.budget).toBeNull();
    expect(plan.issues.map((issue) => issue.field)).toEqual(['mode', 'budget']);
  });

  it('reads a plan with no front matter as a fit plan with an issue', () => {
    const plan = parsePlanFile('# Just notes\n');
    expect(plan.mode).toBe('fit');
    expect(plan.issues[0]?.field).toBe('frontMatter');
  });
});

describe('items', () => {
  it('gives every kind its own prefix, folder and statuses', () => {
    const prefixes = RELAY_ITEM_KINDS.map((kind) => RELAY_ITEM_SPECS[kind].prefix);
    expect(new Set(prefixes).size).toBe(RELAY_ITEM_KINDS.length);
    expect(prefixes).not.toContain('T');
    for (const kind of RELAY_ITEM_KINDS) {
      expect(RELAY_ITEM_SPECS[kind].statuses.length).toBeGreaterThan(1);
      expect(RELAY_ITEM_SPECS[kind].sections.length).toBeGreaterThan(0);
    }
  });

  it('numbers ids per kind and reads them back from file names', () => {
    expect(nextItemId('decision', ['D001', 'D007', 'W020', 'junk'])).toBe('D008');
    expect(nextItemId('workaround', [])).toBe('W001');
    expect(itemFileName('W003', 'Pin zod to 4.6')).toBe('W003-pin-zod-to-4-6.md');
    expect(itemIdFromFileName('workaround', 'W003-pin-zod-to-4-6.md')).toBe('W003');
    expect(itemIdFromFileName('workaround', 'D003-pin.md')).toBeNull();
    expect(itemIdFromFileName('risk', 'notes.md')).toBeNull();
  });

  it('round-trips a workaround with what it waits for', () => {
    const text = renderItemFile({
      kind: 'workaround',
      id: 'W003',
      title: 'Pin zod to 4.6',
      task: 'T012',
      created: '2026-11-28',
      dependency: 'zod',
      ecosystem: 'npm',
      waitingFor: '4.7.0',
      revisitBy: '2027-02-01',
      sections: { 'What we did': 'Pinned zod.', why: 'A parser bug in 4.6.8.' },
    });
    const item = parseItemFile('workaround', 'W003-pin-zod-to-4-6.md', text);
    expect(item).toMatchObject({
      kind: 'workaround',
      id: 'W003',
      title: 'Pin zod to 4.6',
      status: 'open',
      task: 'T012',
      created: '2026-11-28',
      dependency: 'zod',
      ecosystem: 'npm',
      waitingFor: '4.7.0',
      revisitBy: '2027-02-01',
      issues: [],
    });
    expect(bodySection(item.body, 'What we did')).toBe('Pinned zod.');
    expect(bodySection(item.body, 'Why')).toBe('A parser bug in 4.6.8.');
    // A section left out keeps its hint, which reads as empty.
    expect(bodySection(item.body, 'Proper fix')).toBe('');
    expect(text).toContain('## Proper fix');
  });

  it('reads a risk and a milestone with their own fields', () => {
    const risk = parseItemFile(
      'risk',
      'R001-x.md',
      '---\nid: R001\ntitle: Vendor API changes\nlikelihood: Med\nimpact: high\nowner: Sam\n---\n',
    );
    expect(risk).toMatchObject({ likelihood: 'medium', impact: 'high', owner: 'Sam' });
    const milestone = parseItemFile(
      'milestone',
      'M002-beta.md',
      '---\nid: M002\ntitle: Beta\nstatus: completed\ntarget: 2026-12-15\n---\n',
    );
    expect(milestone).toMatchObject({ status: 'done', target: '2026-12-15' });
  });

  it('turns bad values into issues and keeps the rest', () => {
    const item = parseItemFile(
      'decision',
      'D002-store.md',
      '---\nid: D009\ntitle: Use SQLite\nstatus: maybe\ntask: later\n---\n',
    );
    expect(item.id).toBe('D009');
    expect(item.status).toBe('proposed');
    expect(item.task).toBeNull();
    expect(item.issues.map((issue) => issue.field)).toEqual(['id', 'status', 'task']);
  });
});

describe('journal', () => {
  const entry = {
    at: '2026-11-28T09:30:00.000Z',
    legNo: 1,
    cliId: 'claude-code',
    model: 'opus',
    effort: 'high',
    result: 'continue' as const,
    tests: 'passed' as const,
    peakContextTokens: 142_300,
    minutes: 34,
    commit: 'abc1234',
    attempt: null,
  };

  it('starts a journal and adds entries at the end', () => {
    const first = appendJournalEntry(null, 'T004', entry);
    const second = appendJournalEntry(first, 'T004', {
      ...entry,
      legNo: 2,
      result: 'done',
      attempt: 2,
      commit: null,
    });
    expect(second.startsWith('---\ntask: T004\n---')).toBe(true);
    const entries = parseJournal(second);
    expect(entries.map((view) => view.heading)).toEqual([
      '2026-11-28 09:30 session 1',
      '2026-11-28 09:30 session 2',
    ]);
    expect(entries[0].lines).toEqual([
      'Agent: claude-code, opus, high',
      'Result: continue',
      'Tests: passed',
      'Context: 142K tokens at most',
      'Time: 34 min',
      'Commit: abc1234',
    ]);
    expect(entries[1].lines).toContain('Attempt: 2');
    expect(second).not.toContain('—');
  });
});

describe('paths', () => {
  it('keeps everything inside the tasks folder', () => {
    expect(planRelPath('docs')).toBe('docs/tasks/PLAN.md');
    expect(itemFolderRelPath('planning/specs', 'decision')).toBe('planning/specs/tasks/decisions');
    expect(journalRelPath('docs', 'T004')).toBe('docs/tasks/journal/T004.md');
    expect(archiveRelPath('docs', 'T004', 2)).toBe('docs/tasks/handoffs/archive/T004-attempt-2.md');
  });

  it('archives an attempt as one file with its handoff and its journal', () => {
    const text = renderAttemptArchive({
      taskId: 'T004',
      attempt: 1,
      agent: 'claude-code',
      handoff: '---\ntask: T004\noutcome: continue\n---\n\n## Purpose\n\nColumns.\n',
      journal:
        '---\ntask: T004\n---\n\n# Journal of T004\n\n## 2026-11-28 09:30 session 1\n\n- Result: continue\n',
    });
    expect(text).toMatch(/^---\ntask: T004\nattempt: 1\nagent: claude-code\n---/);
    expect(text).toContain('## Purpose\n\nColumns.');
    expect(text).toContain('- Result: continue');
    expect(text).not.toContain('# Journal of T004');
  });
});

describe('planRunOptions', () => {
  const plan = (front: string) => parsePlanFile(`---\ntitle: X\n${front}\n---\n`);

  it('turns on what the plan asks for and nothing else', () => {
    expect(planRunOptions(plan('mode: fit'))).toEqual({});
    expect(planRunOptions(plan('mode: fit\nkeepRolling: true\nbudget: 400000'))).toEqual({
      keepRolling: true,
      defaultBudget: 400_000,
    });
    expect(planRunOptions(plan('reviewEachTask: true'))).toEqual({ reviewEachTask: true });
  });

  it('always rolls on and runs past the budget in plan mode, which has no budget', () => {
    expect(planRunOptions(plan('mode: plan\nbudget: 100000'))).toEqual({
      keepRolling: true,
      runPastBudget: true,
    });
  });

  it('reads a marked or tested session as done in the journal', () => {
    expect(journalResult('testing')).toBe('done');
    expect(journalResult('marked-done')).toBe('done');
    expect(journalResult('continue')).toBe('continue');
  });
});
