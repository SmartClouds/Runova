import { parseItemFile, parsePlanFile, renderItemFile, renderPlanFile } from '@runova/core';
import type { RelayPlanPack } from '@shared/relayTypes';
import { screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { RelayOverview, RelayRecords, RelayRoadmap, RelayTaskList } from './PlanViews';
import { RelayItemDialog } from './RelayItemDialog';
import { TaskEditDialog } from './TaskEditDialog';
import { board, card } from './testing/fixtures';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
  info: vi.fn(),
  warning: vi.fn(),
}));
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

const milestone = parseItemFile(
  'milestone',
  'M001-pilot.md',
  renderItemFile({ kind: 'milestone', id: 'M001', title: 'Pilot', target: '2026-01-01' }),
);
const workaround = parseItemFile(
  'workaround',
  'W001-pin.md',
  renderItemFile({
    kind: 'workaround',
    id: 'W001',
    title: 'Pin zod',
    dependency: 'zod',
    waitingFor: '4.7.0',
    sections: { 'What we did': 'Pinned zod to 4.6.' },
  }),
);
const question = parseItemFile(
  'question',
  'Q001-ward.md',
  renderItemFile({ kind: 'question', id: 'Q001', title: 'Which ward first?' }),
);

function pack(overrides: Partial<RelayPlanPack['items']> = {}): RelayPlanPack {
  return {
    plan: parsePlanFile(
      renderPlanFile({ title: 'Paperless clinic', mode: 'plan', goal: 'No more paper charts.' }),
    ),
    items: {
      milestone: [milestone],
      decision: [],
      workaround: [workaround],
      risk: [],
      question: [question],
      ...overrides,
    },
  };
}

const tasks = [
  card('T001', { title: 'Import charts', status: 'done', milestone: 'M001', priority: 'p1' }),
  card('T002', { title: 'Ward view', status: 'blocked', milestone: 'M001', priority: 'p0' }),
  card('T003', { title: 'Reports', status: 'todo', labels: ['later'] }),
];

const revisits = [{ id: 'W001', title: 'Pin zod', state: 'ready', reason: 'zod 4.7.1 is out.' }];

beforeEach(() => {
  for (const fn of Object.values(toast)) fn.mockClear();
});

describe('RelayOverview', () => {
  it('shows the plan, progress by milestone and what needs attention', async () => {
    const onSelectTask = vi.fn();
    const { user } = renderWithProviders(
      <RelayOverview
        board={board({ tasks })}
        pack={pack()}
        onSelectTask={onSelectTask}
        onEditPlan={vi.fn()}
      />,
      { bridge: { 'relay.revisits': async () => revisits } },
    );
    expect(screen.getByRole('region', { name: 'Paperless clinic' })).toHaveTextContent(
      'No more paper charts.',
    );
    expect(screen.getByRole('progressbar', { name: 'Done overall' })).toHaveAttribute(
      'aria-valuenow',
      '33',
    );
    expect(screen.getByRole('progressbar', { name: 'M001 done' })).toHaveAttribute(
      'aria-valuenow',
      '50',
    );
    const needs = screen.getByRole('region', { name: 'Needs you' });
    expect(needs).toHaveTextContent('Which ward first?');
    await user.click(within(needs).getByRole('button', { name: /T002/ }));
    expect(onSelectTask).toHaveBeenCalledWith('T002');
    expect(await screen.findByText(/Ready to revisit/, { selector: 'span' })).toBeInTheDocument();
  });
});

describe('RelayTaskList', () => {
  it('sorts and filters the tasks', async () => {
    const { user } = renderWithProviders(
      <RelayTaskList board={board({ tasks })} pack={pack()} onSelectTask={vi.fn()} />,
    );
    const ids = () =>
      screen
        .getAllByRole('row')
        .slice(1)
        .map((row) => within(row).getAllByRole('cell')[0].textContent);
    expect(ids()).toEqual(['T001', 'T002', 'T003']);
    await user.click(screen.getByRole('button', { name: /Priority/ }));
    expect(ids()).toEqual(['T002', 'T001', 'T003']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by label' }), 'later');
    expect(ids()).toEqual(['T003']);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Filter by label' }), '');
    await user.type(screen.getByRole('textbox', { name: 'Search tasks' }), 'ward');
    expect(ids()).toEqual(['T002']);
  });
});

describe('RelayRoadmap', () => {
  it('lays the milestones out with their tasks and says when one is late', () => {
    renderWithProviders(
      <RelayRoadmap board={board({ tasks })} pack={pack()} onSelectTask={vi.fn()} />,
    );
    const pilot = screen.getByRole('region', { name: 'M001 Pilot' });
    expect(pilot).toHaveTextContent('late');
    expect(within(pilot).getByRole('button', { name: 'T001' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'No milestone' })).toHaveTextContent('T003');
  });
});

describe('RelayRecords', () => {
  it('flags a workaround whose fix is out and turns it into a task', async () => {
    const { user, bridge } = renderWithProviders(
      <RelayRecords board={board({ tasks })} pack={pack()} />,
      {
        bridge: {
          'relay.revisits': async () => revisits,
          'relay.fixWorkaround': async () => 'T004',
        },
      },
    );
    expect(screen.getByRole('tab', { name: /Decisions \(0\)/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(screen.getByRole('tab', { name: /Workarounds \(1\)/ }));
    const row = screen.getByRole('listitem', { name: 'W001 Pin zod' });
    expect(row).toHaveTextContent('Pinned zod to 4.6.');
    await waitFor(() => expect(row).toHaveTextContent('Ready to revisit'));
    await user.click(within(row).getByRole('button', { name: 'Fix with AI' }));
    await waitFor(() =>
      expect(bridge.$fn('relay.fixWorkaround')).toHaveBeenCalledWith('p1', 'W001'),
    );
    expect(toast.success).toHaveBeenCalledWith('Added T004 to take out W001', expect.anything());
  });
});

describe('RelayItemDialog', () => {
  it('adds a workaround with what it waits for', async () => {
    const onOpenChange = vi.fn();
    const { user, bridge } = renderWithProviders(
      <RelayItemDialog
        open
        onOpenChange={onOpenChange}
        projectId="p1"
        kind="workaround"
        item={null}
      />,
      { bridge: { 'relay.saveItem': async () => 'W002' } },
    );
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Patch the parser');
    await user.type(screen.getByRole('textbox', { name: 'Package it waits on' }), 'yaml');
    await user.type(screen.getByRole('textbox', { name: 'Version with the fix' }), '2.9.0');
    await user.type(screen.getByRole('textbox', { name: 'Why' }), 'It drops comments.');
    await user.click(screen.getByRole('button', { name: 'Add workaround' }));
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(bridge.$fn('relay.saveItem')).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        kind: 'workaround',
        title: 'Patch the parser',
        status: 'open',
        fields: expect.objectContaining({
          dependency: 'yaml',
          waitingFor: '2.9.0',
          ecosystem: null,
        }),
        sections: expect.objectContaining({ Why: 'It drops comments.' }),
      }),
    );
  });

  it('changes the status of a record that exists', async () => {
    const { user, bridge } = renderWithProviders(
      <RelayItemDialog
        open
        onOpenChange={vi.fn()}
        projectId="p1"
        kind="question"
        item={question}
      />,
      { bridge: { 'relay.saveItem': async () => 'Q001' } },
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status' }), 'answered');
    await user.type(screen.getByRole('textbox', { name: 'Answer' }), 'Ward A.');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.$fn('relay.saveItem')).toHaveBeenCalledWith(
        'p1',
        expect.objectContaining({
          id: 'Q001',
          status: 'answered',
          sections: expect.objectContaining({ Answer: 'Ward A.' }),
        }),
      ),
    );
  });
});

describe('TaskEditDialog', () => {
  it('adds a task with its fields and its spec', async () => {
    const onCreated = vi.fn();
    const { user, bridge } = renderWithProviders(
      <TaskEditDialog
        open
        onOpenChange={vi.fn()}
        projectId="p1"
        task={null}
        body=""
        milestones={[milestone]}
        onCreated={onCreated}
      />,
      {
        bridge: {
          'relay.createTask': async () => 'T009',
          'relay.saveTaskBody': async () => undefined,
        },
      },
    );
    await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Export');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Priority' }), 'p1');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Milestone' }), 'M001');
    await user.type(screen.getByRole('textbox', { name: 'Labels' }), 'csv, reports');
    await user.click(screen.getByRole('button', { name: 'Add task' }));
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('T009'));
    expect(bridge.$fn('relay.createTask')).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        title: 'Export',
        priority: 'p1',
        milestone: 'M001',
        labels: ['csv', 'reports'],
      }),
    );
    expect(bridge.$fn('relay.saveTaskBody')).toHaveBeenCalledWith(
      'p1',
      'T009',
      expect.stringContaining('## Acceptance criteria'),
    );
  });

  it('saves only the fields of a task that exists, and its body when it changed', async () => {
    const { user, bridge } = renderWithProviders(
      <TaskEditDialog
        open
        onOpenChange={vi.fn()}
        projectId="p1"
        task={card('T002', { title: 'Ward view', priority: 'p0' })}
        body="## Goal\n\nShow the ward."
        milestones={[]}
      />,
      { bridge: { 'relay.updateTask': async () => undefined } },
    );
    await user.selectOptions(screen.getByRole('combobox', { name: 'Size' }), 'l');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.$fn('relay.updateTask')).toHaveBeenCalledWith(
        'p1',
        'T002',
        expect.objectContaining({ title: 'Ward view', priority: 'p0', size: 'l' }),
      ),
    );
    expect(() => bridge.$fn('relay.saveTaskBody')).toThrow();
  });
});
