import type { StagedItem } from '@shared/fileSend';
import { formatBytes } from '@shared/remoteProtocol';
import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';
import { SendDropZone } from './SendDropZone';

const report: StagedItem = {
  id: 'a',
  name: 'report.pdf',
  kind: 'file',
  size: 2_100_000,
  fileCount: 1,
};
const holiday: StagedItem = {
  id: 'b',
  name: 'Holiday',
  kind: 'folder',
  size: 120_000_000,
  fileCount: 34,
};

function zone(staged: StagedItem[] = []) {
  const handlers = {
    onPaths: vi.fn(),
    onPickFiles: vi.fn(),
    onPickFolder: vi.fn(),
    onRemove: vi.fn(),
    onClear: vi.fn(),
  };
  const view = renderWithProviders(<SendDropZone staged={staged} {...handlers} />, {
    bridge: { 'shell.pathForFile': (file: File) => `/picked/${file.name}` },
  });
  return { ...view, ...handlers, area: screen.getByRole('region', { name: 'Files to send' }) };
}

function files(...names: string[]) {
  return names.map((name) => new File(['x'], name));
}

describe('the drop zone', () => {
  it('invites a drop or a pick while nothing is staged', async () => {
    const { user, onPickFiles, onPickFolder } = zone();

    expect(screen.getByText('Drop files or folders here')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Choose files' }));
    await user.click(screen.getByRole('button', { name: 'Choose folder' }));

    expect(onPickFiles).toHaveBeenCalledTimes(1);
    expect(onPickFolder).toHaveBeenCalledTimes(1);
  });

  it('stages what is dropped, by the paths Electron gives for it', () => {
    const { area, onPaths } = zone();

    fireEvent.drop(area, { dataTransfer: { files: files('a.txt', 'b.png'), types: ['Files'] } });

    expect(onPaths).toHaveBeenCalledWith(['/picked/a.txt', '/picked/b.png']);
  });

  it('lights up while files are dragged over it, and not for dragged text', () => {
    const { area } = zone();

    fireEvent.dragOver(area, { dataTransfer: { types: ['Files'] } });
    expect(screen.getByText('Drop to add')).toBeInTheDocument();

    fireEvent.dragLeave(area);
    expect(screen.queryByText('Drop to add')).not.toBeInTheDocument();

    fireEvent.dragOver(area, { dataTransfer: { types: ['text/plain'] } });
    expect(screen.queryByText('Drop to add')).not.toBeInTheDocument();
  });

  it('stays lit while the drag moves between its own rows, and goes dark once it leaves', () => {
    const { area } = zone([report]);
    const drag = { dataTransfer: { types: ['Files'] } };
    fireEvent.dragEnter(area, drag);

    // Moving onto a row enters the row before it leaves the zone.
    fireEvent.dragEnter(screen.getByText('report.pdf'), drag);
    fireEvent.dragLeave(area);
    expect(screen.getByText('Drop to add')).toBeInTheDocument();

    fireEvent.dragLeave(screen.getByText('report.pdf'));
    expect(screen.queryByText('Drop to add')).not.toBeInTheDocument();
  });

  it('lists what is staged with its size, and lets a row or everything go', async () => {
    const { user, onRemove, onClear } = zone([report, holiday]);

    expect(screen.getByText('report.pdf')).toBeInTheDocument();
    expect(screen.getByText(formatBytes(2_100_000))).toBeInTheDocument();
    expect(screen.getByText(`34 files, ${formatBytes(120_000_000)}`)).toBeInTheDocument();
    expect(screen.getByText(`35 files, ${formatBytes(122_100_000)}`)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Remove report.pdf' }));
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(onRemove).toHaveBeenCalledWith('a');
    expect(onClear).toHaveBeenCalled();
  });

  it('still takes more once something is staged', async () => {
    const { user, onPickFiles } = zone([report]);

    await user.click(screen.getByRole('button', { name: 'Add files' }));

    expect(onPickFiles).toHaveBeenCalled();
  });
});
