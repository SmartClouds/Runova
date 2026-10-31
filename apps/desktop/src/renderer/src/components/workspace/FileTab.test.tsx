// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useEditorRevealStore } from '@/stores/editorRevealStore';
import { useWorkspaceStore, type WorkspaceFileTab } from '@/stores/workspaceStore';
import { installRunovaBridge } from '../../../../test/renderer/runovaBridge';

// Monaco needs a real layout engine, and neither test below is about the editor itself.
const revealed = vi.hoisted(() => [] as string[]);
vi.mock('@/components/editor/MonacoEditor', async () => {
  const { useEffect } = await import('react');
  return {
    MonacoEditor: ({
      value,
      onChange,
      reveal,
      onRevealed,
    }: {
      value: string;
      onChange?: (value: string) => void;
      reveal?: { line: number; column: number } | null;
      onRevealed?: () => void;
    }) => {
      useEffect(() => {
        if (!reveal) return;
        revealed.push(`${reveal.line}:${reveal.column}`);
        onRevealed?.();
      }, [reveal, onRevealed]);
      return (
        <>
          <div data-testid="monaco">{value}</div>
          <button type="button" onClick={() => onChange?.(`${value} edited`)}>
            type
          </button>
        </>
      );
    },
  };
});
vi.mock('@/components/editor/MonacoDiffEditor', () => ({
  languageFor: () => 'plaintext',
  MonacoDiffEditor: ({
    original,
    modified,
    onModifiedChange,
  }: {
    original: string;
    modified: string;
    onModifiedChange?: (value: string) => void;
  }) => (
    <>
      <div data-testid="diff-original">{original}</div>
      <div data-testid="diff-modified">{modified}</div>
      <button type="button" onClick={() => onModifiedChange?.(`${original} merged`)}>
        merge
      </button>
    </>
  ),
}));

const FileTab = (await import('./FileTab')).default;

const project = { id: 'p1', name: 'App', folderPath: 'E:\\work\\app' } as Project;

function tab(path: string, preview = false): WorkspaceFileTab {
  return { kind: 'file', id: 't1', path, preview };
}

/** A fresh cache per test, so one test's picture is never the next one's cached answer. */
let client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

function wrap(fileTab: WorkspaceFileTab): React.JSX.Element {
  return (
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <FileTab project={project} tab={fileTab} />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

function renderTab(fileTab: WorkspaceFileTab) {
  return render(wrap(fileTab));
}

afterEach(cleanup);

describe('FileTab', () => {
  it('shows a picture in the viewer instead of its bytes', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));

    const image = await screen.findByAltText('logo.png');
    expect(image).toHaveAttribute('src', 'data:image/png;base64,AAA');
    expect(screen.queryByTestId('monaco')).not.toBeInTheDocument();
    expect(await screen.findByText('2.00 KB')).toBeInTheDocument();
  });

  it('says why an image could not be opened', async () => {
    installRunovaBridge({
      'fs.readImage': () => Promise.reject(new Error('This image is too large to show here.')),
    });
    renderTab(tab('E:\\work\\app\\assets\\huge.png'));

    expect(await screen.findByText('This image could not be opened')).toBeInTheDocument();
    expect(screen.getByText('This image is too large to show here.')).toBeInTheDocument();
  });

  it('lets an SVG switch between the picture and its source', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/svg+xml;base64,BBB', bytes: 300 },
      'fs.readFile': () => '<svg />',
    });
    renderTab(tab('E:\\work\\app\\assets\\icon.svg'));

    expect(await screen.findByAltText('icon.svg')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Edit the source'));
    expect(await screen.findByTestId('monaco')).toHaveTextContent('<svg />');

    fireEvent.click(screen.getByLabelText('Show the picture'));
    await waitFor(() => expect(screen.getByAltText('icon.svg')).toBeInTheDocument());
  });

  it('re-reads the file from disk on demand', async () => {
    const bridge = installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));
    await screen.findByAltText('logo.png');
    expect(bridge.$fn('fs.readImage')).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText('Reload from disk'));
    await waitFor(() => expect(bridge.$fn('fs.readImage')).toHaveBeenCalledTimes(2));
  });

  it('hands the picture to its default app when asked', async () => {
    const bridge = installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));
    await screen.findByAltText('logo.png');

    fireEvent.click(screen.getByLabelText('Open in its default app'));
    expect(bridge.$fn('shell.openPath')).toHaveBeenCalledWith('E:\\work\\app\\assets\\logo.png');
  });

  it('does not offer the source of a picture that has none', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab('E:\\work\\app\\assets\\logo.png'));
    await screen.findByAltText('logo.png');
    expect(screen.queryByLabelText('Edit the source')).not.toBeInTheDocument();
  });

  it('goes back to the viewer when the tab is reused for another file', async () => {
    installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/svg+xml;base64,BBB', bytes: 300 },
      'fs.readFile': () => '<svg />',
    });
    const view = renderTab(tab('E:\\work\\app\\assets\\icon.svg'));
    await screen.findByAltText('icon.svg');
    fireEvent.click(screen.getByLabelText('Edit the source'));
    expect(await screen.findByTestId('monaco')).toBeInTheDocument();

    // A preview tab is reused for the next file clicked, which is a new picture, not source.
    view.rerender(wrap(tab('E:\\work\\app\\assets\\other.svg')));
    expect(await screen.findByAltText('other.svg')).toBeInTheDocument();
  });

  it('opens at the line a search result asked for, once', async () => {
    installRunovaBridge({ 'fs.readFile': () => 'a\nb\nc\n' });
    const path = 'E:\\work\\app\\src\\index.ts';
    useEditorRevealStore.getState().requestReveal(path, { line: 3, column: 2 });
    renderTab(tab(path));

    await screen.findByTestId('monaco');
    // Taken as it is applied, so switching back to the tab later does not jump again.
    await waitFor(() => expect(useEditorRevealStore.getState().pending[path]).toBeUndefined());
    expect(revealed).toEqual(['3:2']);
  });

  it("shows the new file, not the last one's edits, when a preview tab moves on", async () => {
    const texts: Record<string, string> = {
      'E:\\work\\app\\README.md': '# Readme',
      'E:\\work\\app\\docs\\guide.md': '# Guide',
      'E:\\work\\app\\docs\\notes.md': '# Notes',
    };
    installRunovaBridge({ 'fs.readFile': (path: string) => texts[path] });
    const view = renderTab(tab('E:\\work\\app\\README.md', true));
    expect(await screen.findByTestId('monaco')).toHaveTextContent('# Readme');
    fireEvent.click(screen.getByText('type'));
    expect(screen.getByTestId('monaco')).toHaveTextContent('# Readme edited');

    // Clicking through files quickly reuses the same tab for each one.
    view.rerender(wrap(tab('E:\\work\\app\\docs\\guide.md', true)));
    expect(await screen.findByText('# Guide')).toBeInTheDocument();
    view.rerender(wrap(tab('E:\\work\\app\\docs\\notes.md', true)));
    expect(await screen.findByText('# Notes')).toBeInTheDocument();
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
  });

  it('pins a preview tab once its file is edited', async () => {
    const openFile = vi.fn();
    const original = useWorkspaceStore.getState().openFile;
    useWorkspaceStore.setState({ openFile });
    try {
      installRunovaBridge({ 'fs.readFile': () => '# Readme' });
      renderTab(tab('E:\\work\\app\\README.md', true));
      await screen.findByTestId('monaco');
      fireEvent.click(screen.getByText('type'));
      expect(openFile).toHaveBeenCalledWith('p1', 'E:\\work\\app\\README.md', { pin: true });
    } finally {
      useWorkspaceStore.setState({ openFile: original });
    }
  });

  it('keeps a plain file in the editor', async () => {
    installRunovaBridge({ 'fs.readFile': () => 'const a = 1;\n' });
    renderTab(tab('E:\\work\\app\\src\\index.ts'));

    expect(await screen.findByTestId('monaco')).toHaveTextContent('const a = 1;');
    expect(screen.queryByLabelText('Show the picture')).not.toBeInTheDocument();
  });
});

describe('FileTab when the file changes on disk', () => {
  const path = 'E:\\work\\app\\.env.prod';

  /** The file on disk, which the tests rewrite the way an agent would. */
  let disk = '';

  function installDisk() {
    disk = 'A=1';
    return installRunovaBridge({
      'fs.readFile': () => disk,
      'fs.writeFile': (_path: string, content: string) => {
        disk = content;
      },
    });
  }

  /** Rewrites the file (or deletes it, for null) and has the watcher report it. */
  async function changeOnDisk(
    bridge: ReturnType<typeof installRunovaBridge>,
    next: string | null,
  ): Promise<void> {
    if (next !== null) disk = next;
    await act(async () => {
      bridge.$emit('fs.onFileChanged', path, { exists: next !== null });
    });
  }

  it('watches its file while open and lets go when closed', async () => {
    const bridge = installDisk();
    const view = renderTab(tab(path));
    await screen.findByTestId('monaco');
    expect(bridge.$fn('fs.watchFile')).toHaveBeenCalledWith(path);

    view.unmount();
    expect(bridge.$fn('fs.unwatchFile')).toHaveBeenCalledWith(path);
    expect(bridge.$listenerCount('fs.onFileChanged')).toBe(0);
  });

  it('reloads a file with no unsaved edits and says so', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    expect(await screen.findByTestId('monaco')).toHaveTextContent('A=1');

    await changeOnDisk(bridge, 'A=2');

    await waitFor(() => expect(screen.getByTestId('monaco')).toHaveTextContent('A=2'));
    expect(screen.getByRole('status')).toHaveTextContent(
      '.env.prod changed on disk and was reloaded.',
    );
    fireEvent.click(screen.getByLabelText('Dismiss'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('drops the reloaded note once the file is edited', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');
    await changeOnDisk(bridge, 'A=2');
    await screen.findByRole('status');

    fireEvent.click(screen.getByText('type'));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('ignores a change to another file', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');

    await act(async () => {
      bridge.$emit('fs.onFileChanged', 'E:\\work\\app\\.env.local', { exists: true });
    });
    expect(bridge.$fn('fs.readFile')).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps unsaved edits when the file changes on disk, and asks what to do', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');
    fireEvent.click(screen.getByText('type'));

    await changeOnDisk(bridge, 'A=2');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('.env.prod changed on disk. Your edits are not saved.');
    expect(screen.getByTestId('monaco')).toHaveTextContent('A=1 edited');
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
  });

  it('shows the new version when asked, dropping the edits', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');
    fireEvent.click(screen.getByText('type'));
    await changeOnDisk(bridge, 'A=2');
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Show new version' }));

    expect(screen.getByTestId('monaco')).toHaveTextContent('A=2');
    expect(screen.queryByText('A=1 edited')).not.toBeInTheDocument();
    expect(screen.queryByText('Unsaved')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps the edits when asked, and a save then writes them over the new version', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');
    fireEvent.click(screen.getByText('type'));
    await changeOnDisk(bridge, 'A=2');
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByTestId('monaco')).toHaveTextContent('A=1 edited');
    expect(screen.getByText('Unsaved')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.$fn('fs.writeFile')).toHaveBeenCalledWith(path, 'A=1 edited'),
    );
  });

  it('compares the disk with the edits, and keeps what was merged there', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');
    fireEvent.click(screen.getByText('type'));
    await changeOnDisk(bridge, 'A=2');
    await screen.findByRole('alert');

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByTestId('diff-original')).toHaveTextContent('A=2');
    expect(screen.getByTestId('diff-modified')).toHaveTextContent('A=1 edited');
    expect(screen.getByRole('button', { name: 'Compare' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getByText('merge'));
    fireEvent.click(screen.getByRole('button', { name: 'Keep mine' }));

    expect(screen.queryByTestId('diff-original')).not.toBeInTheDocument();
    expect(screen.getByTestId('monaco')).toHaveTextContent('A=2 merged');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() =>
      expect(bridge.$fn('fs.writeFile')).toHaveBeenCalledWith(path, 'A=2 merged'),
    );
  });

  it('follows a second change while it is still asking', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');
    fireEvent.click(screen.getByText('type'));
    await changeOnDisk(bridge, 'A=2');
    await screen.findByRole('alert');
    await changeOnDisk(bridge, 'A=3');

    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    await waitFor(() => expect(screen.getByTestId('diff-original')).toHaveTextContent('A=3'));
  });

  it('says nothing about its own save', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');
    fireEvent.click(screen.getByText('type'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByText('Unsaved')).not.toBeInTheDocument());

    // The save is itself a change on disk, and the watcher reports it like any other.
    await changeOnDisk(bridge, 'A=1 edited');

    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('says when the file was deleted on disk, and that a save brings it back', async () => {
    const bridge = installDisk();
    renderTab(tab(path));
    await screen.findByTestId('monaco');

    await changeOnDisk(bridge, null);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      '.env.prod was deleted on disk. Saving will create it again.',
    );
    expect(screen.getByTestId('monaco')).toHaveTextContent('A=1');
  });

  it('reloads a picture that changed on disk', async () => {
    const imagePath = 'E:\\work\\app\\assets\\logo.png';
    const bridge = installRunovaBridge({
      'fs.readImage': { dataUrl: 'data:image/png;base64,AAA', bytes: 2048 },
    });
    renderTab(tab(imagePath));
    await screen.findByAltText('logo.png');
    expect(bridge.$fn('fs.watchFile')).toHaveBeenCalledWith(imagePath);

    await act(async () => {
      bridge.$emit('fs.onFileChanged', imagePath, { exists: true });
    });
    await waitFor(() => expect(bridge.$fn('fs.readImage')).toHaveBeenCalledTimes(2));
  });
});
