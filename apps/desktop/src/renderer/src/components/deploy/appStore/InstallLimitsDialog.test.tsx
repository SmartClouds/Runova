import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { InstallLimitsDialog } from './InstallLimitsDialog';

/** The step after the install sheet: caps for each container the app makes, then Install. */

const HOST = { cores: 8, memoryMb: 16_384, diskLimits: true };

function renderDialog(props: Partial<React.ComponentProps<typeof InstallLimitsDialog>> = {}) {
  const onBack = vi.fn();
  const onInstall = vi.fn();
  render(
    <InstallLimitsDialog
      open
      services={['ollama', 'open-webui']}
      host={HOST}
      minMemoryMb={8192}
      busy={false}
      onBack={onBack}
      onInstall={onInstall}
      {...props}
    />,
  );
  return { onBack, onInstall };
}

describe('InstallLimitsDialog', () => {
  it('asks for limits with a card per container', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog', { name: 'Set resource limits' });
    expect(dialog).toHaveTextContent(
      "Choose how much of the server each container may use. You can change these later from the app's page.",
    );
    expect(screen.getByRole('region', { name: 'ollama' })).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'open-webui' })).toBeInTheDocument();
  });

  it('installs with no limits when nothing is capped', async () => {
    const { onInstall } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onInstall).toHaveBeenCalledWith([]);
  });

  it('installs with the limits picked', async () => {
    const { onInstall } = renderDialog();
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited memory for ollama' }));
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited CPU for open-webui' }));
    await userEvent.click(screen.getByRole('button', { name: 'Install' }));
    expect(onInstall).toHaveBeenCalledWith([
      { service: 'ollama', memoryMb: 8192 },
      { service: 'open-webui', cpuCores: 2, cpuPercent: 100 },
    ]);
  });

  it('goes back to the install sheet', async () => {
    const { onBack, onInstall } = renderDialog();
    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(onBack).toHaveBeenCalled();
    expect(onInstall).not.toHaveBeenCalled();
  });

  it('holds Install while the install is under way', () => {
    renderDialog({ busy: true });
    expect(screen.getByRole('button', { name: /Install/ })).toBeDisabled();
  });

  it('is not shown when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});
