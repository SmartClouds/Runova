import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskAiHistoryMessage } from '../../shared/apiTypes';

/**
 * runAiPrompt() talks to OpenAI, Gemini and Ollama for every API-backed AI feature. These pin the
 * exact request bodies, so a screenshot reaches each provider in the shape it reads images in, and
 * a request without one goes out exactly as it always has.
 */

const settings = {
  current: {} as Record<string, unknown>,
};

vi.mock('../store', () => ({
  store: { getSettings: async () => settings.current },
}));
// ai.ts also registers the CLI-backed handlers; nothing here starts a CLI.
vi.mock('../cli/headlessPrompt', () => ({
  runHeadlessCliPrompt: vi.fn(),
  cancelHeadlessPrompt: vi.fn(),
}));

const fetchMock = vi.fn();

function answer(json: unknown): Response {
  return { ok: true, status: 200, json: async () => json, text: async () => '' } as Response;
}

/** The raw body of the one request runAiPrompt sent. */
function sentBody(): string {
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
  return init.body as string;
}

const history: AskAiHistoryMessage[] = [
  { role: 'user', content: 'earlier question' },
  { role: 'assistant', content: 'earlier answer' },
];
const PNG = 'iVBORw0KGgoAAAANSUhEUg';

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  settings.current = {
    openaiApiKey: 'sk-test',
    geminiApiKey: 'gm-test',
    ollamaBaseUrl: 'http://ollama:11434',
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function runAiPrompt(...args: Parameters<typeof import('./ai').runAiPrompt>) {
  const ai = await import('./ai');
  return ai.runAiPrompt(...args);
}

describe('runAiPrompt with OpenAI', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(answer({ choices: [{ message: { content: 'CLICK 1 2' } }] }));
  });

  it('sends the same body as always without images', async () => {
    await expect(runAiPrompt('openai', 'gpt-test', 'hello', history)).resolves.toBe('CLICK 1 2');
    expect(sentBody()).toBe(
      JSON.stringify({
        model: 'gpt-test',
        messages: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
          { role: 'user', content: 'hello' },
        ],
      }),
    );
  });

  it('treats an empty image list like none', async () => {
    await runAiPrompt('openai', 'gpt-test', 'hello', [], undefined, []);
    expect(sentBody()).toBe(
      JSON.stringify({ model: 'gpt-test', messages: [{ role: 'user', content: 'hello' }] }),
    );
  });

  it('attaches the screenshot to the last user message as a data URL', async () => {
    await runAiPrompt('openai', 'gpt-test', 'what now?', history, undefined, [PNG]);
    const body = JSON.parse(sentBody());
    expect(body.messages.slice(0, 2)).toEqual([
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
    ]);
    expect(body.messages[2]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'what now?' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG}` } },
      ],
    });
  });
});

describe('runAiPrompt with Gemini', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(
      answer({ candidates: [{ content: { parts: [{ text: 'WAIT 500' }] } }] }),
    );
  });

  it('sends the same body as always without images', async () => {
    await expect(runAiPrompt('gemini', 'gem-test', 'hello', history)).resolves.toBe('WAIT 500');
    expect(sentBody()).toBe(
      JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: 'earlier question' }] },
          { role: 'model', parts: [{ text: 'earlier answer' }] },
          { role: 'user', parts: [{ text: 'hello' }] },
        ],
      }),
    );
  });

  it('adds the screenshot as inline data after the prompt text', async () => {
    await runAiPrompt('gemini', 'gem-test', 'what now?', history, undefined, [PNG]);
    const body = JSON.parse(sentBody());
    expect(body.contents).toHaveLength(3);
    expect(body.contents[2]).toEqual({
      role: 'user',
      parts: [{ text: 'what now?' }, { inline_data: { mime_type: 'image/png', data: PNG } }],
    });
  });
});

describe('runAiPrompt with Ollama', () => {
  beforeEach(() => {
    fetchMock.mockResolvedValue(answer({ message: { content: 'KEY enter' } }));
  });

  it('sends the same body as always without images', async () => {
    settings.current = { ...settings.current, ollamaKeepAlive: '5m', ollamaContextLength: 8192 };
    await expect(runAiPrompt('ollama', 'llava', 'hello', history)).resolves.toBe('KEY enter');
    expect(fetchMock.mock.calls[0]?.[0]).toBe('http://ollama:11434/api/chat');
    expect(sentBody()).toBe(
      JSON.stringify({
        model: 'llava',
        messages: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
          { role: 'user', content: 'hello' },
        ],
        stream: false,
        keep_alive: '5m',
        options: { num_ctx: 8192 },
      }),
    );
  });

  it('puts the screenshot in the images list of the last user message', async () => {
    await runAiPrompt('ollama', 'llava', 'what now?', history, undefined, [PNG]);
    const body = JSON.parse(sentBody());
    expect(body.messages[0]).toEqual({ role: 'user', content: 'earlier question' });
    expect(body.messages[2]).toEqual({ role: 'user', content: 'what now?', images: [PNG] });
  });
});

describe('runAiPrompt with a system instruction', () => {
  it('opens the OpenAI conversation with a system message', async () => {
    fetchMock.mockResolvedValue(answer({ choices: [{ message: { content: 'ok' } }] }));
    await runAiPrompt('openai', 'gpt-test', 'hello', history, undefined, [], 'Be brief.');
    expect(JSON.parse(sentBody()).messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'earlier question' },
      { role: 'assistant', content: 'earlier answer' },
      { role: 'user', content: 'hello' },
    ]);
  });

  it('sends it to Gemini as system_instruction', async () => {
    fetchMock.mockResolvedValue(answer({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }));
    await runAiPrompt('gemini', 'gem-test', 'hello', [], undefined, [], 'Be brief.');
    expect(JSON.parse(sentBody())).toEqual({
      system_instruction: { parts: [{ text: 'Be brief.' }] },
      contents: [{ role: 'user', parts: [{ text: 'hello' }] }],
    });
  });

  it('opens the Ollama conversation with a system message', async () => {
    fetchMock.mockResolvedValue(answer({ message: { content: 'ok' } }));
    await runAiPrompt('ollama', 'llama', 'hello', [], undefined, [], 'Be brief.');
    expect(JSON.parse(sentBody()).messages).toEqual([
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: 'hello' },
    ]);
  });
});

describe('askCli', () => {
  async function headless() {
    const mod = await import('../cli/headlessPrompt');
    return vi.mocked(mod.runHeadlessCliPrompt);
  }

  beforeEach(async () => {
    (await headless()).mockReset();
  });

  it('runs only the picked CLI, with its model and effort flags, outside any repo', async () => {
    const run = await headless();
    run.mockResolvedValue({ ok: true, text: 'the prompt', cliName: 'Claude Code CLI' });
    const { askCli } = await import('./ai');

    const result = await askCli({
      prompt: 'write it',
      cliId: 'claude-code',
      modelId: 'opus',
      effort: 'high',
      requestId: 'r1',
    });

    expect(result).toMatchObject({ ok: true, text: 'the prompt', cliName: 'Claude Code CLI' });
    const [prompt, cwd, options] = run.mock.calls[0] ?? [];
    expect(prompt).toBe('write it');
    expect(cwd).toBe((await import('node:os')).tmpdir());
    expect(options).toMatchObject({
      requestId: 'r1',
      preferredCliId: 'claude-code',
      strictCli: true,
      runArgs: ['--model', 'opus', '--effort', 'high'],
    });
  });

  it('leaves the model to the CLI when none was picked', async () => {
    const run = await headless();
    run.mockResolvedValue({ ok: true, text: 'x', cliName: 'Codex CLI' });
    const { askCli } = await import('./ai');

    await askCli({ prompt: 'p', cliId: 'codex-cli', modelId: null, effort: 'high' });

    expect(run.mock.calls[0]?.[2]).toMatchObject({ runArgs: [] });
  });

  it('answers with the default CLI when no CLI was picked', async () => {
    const run = await headless();
    run.mockResolvedValue({ ok: true, text: 'x', cliName: 'Codex CLI' });
    const { askCli } = await import('./ai');

    const result = await askCli({ prompt: 'p', requestId: 'r2' });

    expect(result).toMatchObject({ ok: true, text: 'x', cliName: 'Codex CLI' });
    const options = run.mock.calls[0]?.[2];
    expect(options).toMatchObject({ requestId: 'r2' });
    expect(options?.strictCli).toBeUndefined();
    expect(options?.preferredCliId).toBeUndefined();
    expect(options?.runArgs).toBeUndefined();
  });

  it('passes a failure through without any half-written text', async () => {
    const run = await headless();
    run.mockResolvedValue({
      ok: false,
      text: 'partial',
      cliName: 'Claude Code CLI',
      timedOut: true,
      error: 'Claude Code CLI was still working after 5 minutes and was stopped.',
    });
    const { askCli } = await import('./ai');

    const result = await askCli({ prompt: 'p', cliId: 'claude-code' });

    expect(result).toEqual({
      ok: false,
      text: '',
      cliName: 'Claude Code CLI',
      timedOut: true,
      cancelled: undefined,
      error: 'Claude Code CLI was still working after 5 minutes and was stopped.',
    });
  });
});
