import { defaultGrammarSettings } from '@runova/core';
import type { GrammarIssue } from '@shared/grammar';
import { screen, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFakeMicrophone } from '../../../../test/renderer/fakeMicrophone';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { AgentPromptField, type AgentPromptFieldProps } from './AgentPromptField';

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const SETTINGS = {
  promptBuilderProvider: 'openai',
  openaiModel: 'gpt-test',
  speechLanguage: 'fa',
  speechModel: 'large-v3-turbo',
};

type Overrides = Partial<Omit<AgentPromptFieldProps, 'value' | 'onChange' | 'buildRequest'>>;

/** The field with its text in state, the way every composer holds it. */
function Harness({ initial, ...props }: Overrides & { initial: string }): React.JSX.Element {
  const [value, setValue] = useState(initial);
  return (
    <AgentPromptField
      value={value}
      onChange={setValue}
      purpose="task"
      target="ssh"
      ariaLabel="Task for the AI"
      placeholder="Describe it…"
      onSubmit={vi.fn()}
      {...props}
    />
  );
}

function renderField(initial = '', props: Overrides = {}, bridge: Record<string, unknown> = {}) {
  const view = renderWithProviders(<Harness initial={initial} {...props} />, {
    bridge: {
      'settings.get': SETTINGS,
      'speech.transcribe': vi.fn(async () => ({ ok: true, text: 'و بعد سرویس را ریستارت کن' })),
      ...bridge,
    },
  });
  return { ...view, field: () => screen.getByRole('textbox', { name: 'Task for the AI' }) };
}

beforeEach(() => {
  installFakeMicrophone();
});

describe('Translate to English', () => {
  it('is offered only once the text has Persian in it', async () => {
    const { user, field } = renderField('');
    expect(screen.queryByRole('button', { name: /Translate to English/ })).not.toBeInTheDocument();
    await user.type(field(), 'لاگ');
    expect(screen.getByRole('button', { name: /Translate to English/ })).toBeInTheDocument();
  });

  it('replaces the text, and Undo brings the Persian back', async () => {
    const { user, field } = renderField(
      'لاگ‌ها را پاک کن',
      {},
      {
        'translate.text': async () => 'Clear the logs',
      },
    );
    await user.click(screen.getByRole('button', { name: /Translate to English/ }));
    await waitFor(() => expect(field()).toHaveValue('Clear the logs'));
    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(field()).toHaveValue('لاگ‌ها را پاک کن');
    expect(field()).toHaveAttribute('dir', 'rtl');
  });
});

describe('Write it for me', () => {
  it('rewrites the note with the AI, for the question it answers', async () => {
    const ask = vi.fn(async (_input: { prompt: string; provider: string; model: string }) => ({
      ok: true,
      text: 'Reload the api site.',
    }));
    const { user, field } = renderField(
      'api one',
      { purpose: 'answer', question: 'Which site?' },
      { 'ai.ask': ask },
    );
    await user.click(screen.getByRole('button', { name: /Write it for me/ }));
    await waitFor(() => expect(field()).toHaveValue('Reload the api site.'));
    expect(ask.mock.calls[0]?.[0]).toMatchObject({ provider: 'openai', model: 'gpt-test' });
    expect(ask.mock.calls[0]?.[0].prompt).toContain('Which site?');
  });

  it('is unavailable while the box is empty', () => {
    renderField('');
    expect(screen.getByRole('button', { name: /Write it for me/ })).toBeDisabled();
  });

  it('shows the work in progress with a way to cancel it, and keeps the text', async () => {
    const { user, field, bridge } = renderField(
      'note',
      {},
      {
        'ai.ask': () => new Promise(() => undefined),
        'ai.cancel': async () => true,
      },
    );
    await user.click(screen.getByRole('button', { name: /Write it for me/ }));
    expect(await screen.findByText('Writing…')).toBeInTheDocument();
    expect(field()).toHaveAttribute('readonly');
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(bridge.$fn('ai.cancel')).toHaveBeenCalled();
    expect(field()).not.toHaveAttribute('readonly');
    expect(field()).toHaveValue('note');
  });
});

describe('Dictate', () => {
  it('adds what was said after what is already typed, in the language picked', async () => {
    const { user, field, bridge } = renderField('df -h');
    await user.click(await screen.findByRole('button', { name: 'Dictate' }));
    expect(await screen.findByRole('group', { name: 'Recording' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Stop and transcribe' }));
    await waitFor(() => expect(field()).toHaveValue('df -h و بعد سرویس را ریستارت کن'));
    expect(bridge.$fn('speech.transcribe')).toHaveBeenCalledWith(
      expect.objectContaining({ language: 'fa' }),
    );
  });

  it('lets the language be switched on the spot', async () => {
    renderField('');
    expect(await screen.findByRole('button', { name: /Dictation language/ })).toBeInTheDocument();
  });
});

describe('keys', () => {
  it('sends on Enter and keeps Shift+Enter for a new line', async () => {
    const onSubmit = vi.fn();
    const { user, field } = renderField('', { onSubmit, submitOn: 'enter' });
    await user.type(field(), 'one{Shift>}{Enter}{/Shift}two');
    expect(onSubmit).not.toHaveBeenCalled();
    expect(field()).toHaveValue('one\ntwo');
    await user.type(field(), '{Enter}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('needs Ctrl+Enter when set to, leaving Enter for new lines', async () => {
    const onSubmit = vi.fn();
    const { user, field } = renderField('', { onSubmit, submitOn: 'mod-enter' });
    await user.type(field(), 'one{Enter}two');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.type(field(), '{Control>}{Enter}{/Control}');
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('does not send while a rewrite is still running', async () => {
    const onSubmit = vi.fn();
    const { user, field } = renderField(
      'note',
      { onSubmit },
      {
        'ai.ask': () => new Promise(() => undefined),
        'ai.cancel': async () => true,
      },
    );
    await user.click(screen.getByRole('button', { name: /Write it for me/ }));
    await screen.findByText('Writing…');
    field().focus();
    await user.keyboard('{Enter}');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('Escape cancels a running job first, and only then reaches the caller', async () => {
    const onEscape = vi.fn();
    const { user, field } = renderField(
      'note',
      { onEscape },
      {
        'ai.ask': () => new Promise(() => undefined),
        'ai.cancel': async () => true,
      },
    );
    await user.click(screen.getByRole('button', { name: /Write it for me/ }));
    await screen.findByText('Writing…');
    field().focus();
    await user.keyboard('{Escape}');
    expect(onEscape).not.toHaveBeenCalled();
    expect(screen.queryByText('Writing…')).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onEscape).toHaveBeenCalledTimes(1);
  });

  it('translates with the Translate shortcut', async () => {
    const { user, field } = renderField('سلام', {}, { 'translate.text': async () => 'Hello' });
    field().focus();
    await user.keyboard('{Control>}t{/Control}');
    await waitFor(() => expect(field()).toHaveValue('Hello'));
  });
});

describe('Writing check', () => {
  /** The check waits for a pause in the typing (1.4 s) before it asks LanguageTool. */
  const AFTER_PAUSE = { timeout: 4000 };

  const typo: GrammarIssue = {
    offset: 6,
    length: 3,
    text: 'teh',
    message: 'Possible spelling mistake found.',
    shortMessage: 'Spelling mistake',
    kind: 'spelling',
    ruleId: 'MORFOLOGIK_RULE_EN_US',
    categoryName: 'Possible Typo',
    replacements: ['the'],
  };

  const found = (issues: GrammarIssue[]) =>
    vi.fn(async () => ({ issues, language: 'English (US)', source: 'online', truncatedAt: null }));

  /** The counter's name is what it says: Checking…, No issues, 1 issue and so on. */
  const counter = () => screen.queryByRole('button', { name: /issue|Checking|Check failed/ });

  it('checks what is written and says how many issues it found', async () => {
    const check = found([typo]);
    const { bridge } = renderField('I saw teh', {}, { 'grammar.check': check });
    expect(await screen.findByRole('button', { name: '1 issue' }, AFTER_PAUSE)).toBeInTheDocument();
    expect(bridge.$fn('grammar.check')).toHaveBeenCalledWith({ text: 'I saw teh' });
  });

  it('fixes a mistake from the review panel', async () => {
    // jsdom has no execCommand, so the fix takes the path that sets the value and fires input.
    Object.defineProperty(document, 'execCommand', { value: () => false, configurable: true });
    try {
      const { user, field } = renderField('I saw teh', {}, { 'grammar.check': found([typo]) });
      await user.click(await screen.findByRole('button', { name: '1 issue' }, AFTER_PAUSE));
      await user.click(await screen.findByRole('button', { name: 'the' }));
      expect(field()).toHaveValue('I saw the');
    } finally {
      Reflect.deleteProperty(document, 'execCommand');
    }
  });

  it('stays out of the way while the box is empty', async () => {
    renderField('', {}, { 'grammar.check': found([]) });
    await screen.findByRole('button', { name: /Dictation language/ });
    expect(counter()).not.toBeInTheDocument();
  });

  it('is gone when the writing check is off in Settings', async () => {
    renderField(
      'I saw teh',
      {},
      {
        'settings.get': { ...SETTINGS, grammar: { ...defaultGrammarSettings(), enabled: false } },
        'grammar.check': found([typo]),
      },
    );
    await screen.findByRole('button', { name: /Dictation language/ });
    await waitFor(() => expect(counter()).not.toBeInTheDocument());
  });

  it('leaves Persian alone, which it has no rules for, and offers English instead', async () => {
    const check = found([typo]);
    const { user, field } = renderField('I saw teh', {}, { 'grammar.check': check });
    await screen.findByRole('button', { name: '1 issue' }, AFTER_PAUSE);
    await user.clear(field());
    await user.type(field(), 'لاگ‌ها را ببین');
    expect(screen.getByRole('button', { name: /Translate to English/ })).toBeInTheDocument();
    expect(counter()).not.toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 1600));
    expect(check).toHaveBeenCalledTimes(1);
  });

  it('makes room for the recording while dictating', async () => {
    const { user } = renderField('I saw teh', {}, { 'grammar.check': found([typo]) });
    await screen.findByRole('button', { name: '1 issue' }, AFTER_PAUSE);
    await user.click(screen.getByRole('button', { name: 'Dictate' }));
    await screen.findByRole('group', { name: 'Recording' });
    expect(counter()).not.toBeInTheDocument();
  });
});

describe('the rest of the box', () => {
  it('shows what the caller puts next to it, such as Send', () => {
    renderField('', { trailing: <button type="button">Send</button> });
    expect(screen.getByRole('button', { name: 'Send' })).toBeInTheDocument();
  });

  it('stops at the length it is given and says how close it is', async () => {
    const { user, field } = renderField('', { maxLength: 10 });
    await user.type(field(), '123456789012');
    expect(field()).toHaveValue('1234567890');
    expect(screen.getByText('10/10')).toBeInTheDocument();
  });
});
