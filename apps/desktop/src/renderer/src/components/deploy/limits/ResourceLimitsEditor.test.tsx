import type { ServiceLimits } from '@runova/core';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { LimitsHostFacts } from '@/lib/deploy/limits/editor';
import { ResourceLimitsEditor } from './ResourceLimitsEditor';

/**
 * The limits editor: one card per container, each resource Unlimited until switched on, the CPU
 * as cores and a share of them, memory from presets or typed, disk only where Docker can cap it,
 * and the warnings before a cap that would starve the app.
 */

const HOST: LimitsHostFacts = { cores: 8, memoryMb: 16_384, diskLimits: true };
const SERVICES = ['ollama', 'open-webui'];

function Harness({
  initial = [],
  services = SERVICES,
  host = HOST,
  onChange,
  ...rest
}: Partial<React.ComponentProps<typeof ResourceLimitsEditor>> & {
  initial?: ServiceLimits[];
}) {
  const [value, setValue] = useState<ServiceLimits[]>(initial);
  return (
    <ResourceLimitsEditor
      services={services}
      host={host}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
      {...rest}
    />
  );
}

const card = (service: string) => screen.getByRole('region', { name: service });

describe('ResourceLimitsEditor', () => {
  it('shows a card per container, each with no limits to start', () => {
    render(<Harness />);
    for (const service of SERVICES) {
      expect(within(card(service)).getByText('No limits')).toBeInTheDocument();
      expect(screen.getByRole('switch', { name: `Unlimited CPU for ${service}` })).toBeChecked();
      expect(screen.getByRole('switch', { name: `Unlimited memory for ${service}` })).toBeChecked();
      expect(screen.getByRole('switch', { name: `Unlimited disk for ${service}` })).toBeChecked();
    }
    expect(screen.queryByRole('slider')).not.toBeInTheDocument();
  });

  it('caps the CPU as cores and a share of them', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited CPU for ollama' }));
    expect(onChange).toHaveBeenLastCalledWith([
      { service: 'ollama', cpuCores: 2, cpuPercent: 100 },
    ]);
    const ollama = within(card('ollama'));
    expect(ollama.getByText('2 of 8 cores')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: 'Max CPU usage for ollama' }), {
      target: { value: '50' },
    });
    expect(onChange).toHaveBeenLastCalledWith([{ service: 'ollama', cpuCores: 2, cpuPercent: 50 }]);
    expect(ollama.getByText('Up to 1 core of CPU time')).toBeInTheDocument();
    expect(ollama.getByText('2 cores at 50%')).toBeInTheDocument();

    fireEvent.change(screen.getByRole('slider', { name: 'CPU cores for ollama' }), {
      target: { value: '3' },
    });
    expect(ollama.getByText('Up to 1.5 cores of CPU time')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited CPU for ollama' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
  });

  it('caps memory from a preset or a typed number, within the server', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} host={{ ...HOST, memoryMb: 4096 }} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited memory for ollama' }));
    expect(onChange).toHaveBeenLastCalledWith([{ service: 'ollama', memoryMb: 1024 }]);
    const ollama = within(card('ollama'));
    expect(ollama.getByText('of 4 GB')).toBeInTheDocument();
    // 8 GB is more than this server has.
    expect(ollama.queryByRole('button', { name: '8 GB' })).not.toBeInTheDocument();

    await userEvent.click(ollama.getByRole('button', { name: '2 GB' }));
    expect(onChange).toHaveBeenLastCalledWith([{ service: 'ollama', memoryMb: 2048 }]);
    expect(ollama.getByRole('button', { name: '2 GB' })).toHaveAttribute('aria-pressed', 'true');

    const typed = screen.getByRole('spinbutton', { name: 'Memory in MB for ollama' });
    await userEvent.clear(typed);
    await userEvent.type(typed, '768');
    expect(onChange).toHaveBeenLastCalledWith([{ service: 'ollama', memoryMb: 768 }]);
    expect(ollama.getByText('768 MB RAM')).toBeInTheDocument();

    // More than the server has is not taken.
    await userEvent.clear(typed);
    await userEvent.type(typed, '9000');
    expect(onChange).toHaveBeenLastCalledWith([{ service: 'ollama', memoryMb: 900 }]);
  });

  it('starts memory at what the app asks for and warns below it', async () => {
    render(<Harness minMemoryMb={8192} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited memory for ollama' }));
    const ollama = within(card('ollama'));
    expect(ollama.getByText('8 GB RAM')).toBeInTheDocument();
    expect(ollama.queryByText('This app needs about 8 GB to run well.')).not.toBeInTheDocument();
    await userEvent.click(ollama.getByRole('button', { name: '4 GB' }));
    expect(ollama.getByText('This app needs about 8 GB to run well.')).toBeInTheDocument();
  });

  it('warns when the cap is under what the container uses now', () => {
    render(
      <Harness
        initial={[{ service: 'ollama', memoryMb: 1024 }]}
        usage={{ ollama: { memoryMb: 1228.8 } }}
      />,
    );
    expect(
      within(card('ollama')).getByText(
        'It uses 1.2 GB now, so it would be stopped for running out of memory.',
      ),
    ).toBeInTheDocument();
  });

  it('caps the disk in GB', async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole('switch', { name: 'Unlimited disk for open-webui' }));
    expect(onChange).toHaveBeenLastCalledWith([{ service: 'open-webui', diskGb: 20 }]);
    const typed = screen.getByRole('spinbutton', { name: 'Disk in GB for open-webui' });
    await userEvent.clear(typed);
    await userEvent.type(typed, '50');
    expect(onChange).toHaveBeenLastCalledWith([{ service: 'open-webui', diskGb: 50 }]);
  });

  it('keeps the disk unlimited, with the reason, where Docker cannot cap it', () => {
    render(
      <Harness
        host={{
          ...HOST,
          diskLimits: false,
          diskNote: "overlay2 on ext4 can't cap a container's disk; xfs with pquota can.",
        }}
      />,
    );
    expect(screen.getByRole('switch', { name: 'Unlimited disk for ollama' })).toBeDisabled();
    expect(
      within(card('ollama')).getByText(
        "overlay2 on ext4 can't cap a container's disk; xfs with pquota can.",
      ),
    ).toBeInTheDocument();
  });

  it('says so in its own words when no reason is known', () => {
    render(<Harness services={['app']} host={{ ...HOST, diskLimits: false }} />);
    expect(
      screen.getByText("Docker on this server can't cap a container's disk."),
    ).toBeInTheDocument();
  });

  it('leaves the disk out for a live edit', () => {
    render(<Harness cpuOnlyLive />);
    expect(
      screen.queryByRole('switch', { name: 'Unlimited disk for ollama' }),
    ).not.toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Unlimited memory for ollama' })).toBeInTheDocument();
  });

  it('copies one card to every service', async () => {
    const onChange = vi.fn();
    render(
      <Harness
        onChange={onChange}
        initial={[{ service: 'ollama', cpuCores: 4, cpuPercent: 50, memoryMb: 8192 }]}
      />,
    );
    await userEvent.click(
      within(card('ollama')).getByRole('button', { name: 'Use these limits for every service' }),
    );
    expect(onChange).toHaveBeenLastCalledWith([
      { service: 'ollama', cpuCores: 4, cpuPercent: 50, memoryMb: 8192 },
      { service: 'open-webui', cpuCores: 4, cpuPercent: 50, memoryMb: 8192 },
    ]);
    expect(within(card('open-webui')).getByText('4 cores at 50% · 8 GB RAM')).toBeInTheDocument();
  });

  it('has nothing to copy with one service', () => {
    render(<Harness services={['app']} initial={[{ service: 'app', memoryMb: 512 }]} />);
    expect(
      screen.queryByRole('button', { name: 'Use these limits for every service' }),
    ).not.toBeInTheDocument();
  });

  it('marks the card it was opened for', () => {
    render(<Harness focus="open-webui" />);
    expect(card('open-webui')).toHaveAttribute('data-focused', 'true');
    expect(card('ollama')).not.toHaveAttribute('data-focused');
  });
});
