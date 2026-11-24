import type { Project } from '@runova/core';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { noProjectOption, ProjectRowIcon, projectOption } from './projectOptions';

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Atlas',
    folderPath: 'E:\\Work\\atlas',
    tags: ['web', 'client'],
    iconDataUrl: null,
    iconFile: null,
    iconBgColor: null,
    iconColor: null,
    ...overrides,
  } as Project;
}

describe('projectOption', () => {
  it('shows the name with the folder under it and matches tags in search', () => {
    const option = projectOption(project());

    expect(option).toMatchObject({
      value: 'p1',
      label: 'Atlas',
      description: 'E:\\Work\\atlas',
      keywords: ['web', 'client'],
    });
  });

  it('draws the stored icon when the project has one', () => {
    const { container } = render(
      <>{projectOption(project({ iconDataUrl: 'data:image/png;base64,AAAA' })).icon}</>,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', 'data:image/png;base64,AAAA');
  });

  it('falls back to the folder glyph in the project colours', () => {
    const { container } = render(
      <>{projectOption(project({ iconBgColor: '#112233', iconColor: '#445566' })).icon}</>,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('svg')).not.toBeNull();
    const tile = container.firstElementChild as HTMLElement;
    expect(tile.style.backgroundColor).toBe('rgb(17, 34, 51)');
    expect(tile.style.color).toBe('rgb(68, 85, 102)');
  });
});

describe('ProjectRowIcon', () => {
  it('is a bigger tile for the two-line rows inside a dialog', () => {
    const { container } = render(
      <>
        <ProjectRowIcon project={project()} />
        <ProjectRowIcon project={project()} size="card" />
      </>,
    );
    const [row, card] = Array.from(container.children);

    expect(row).toHaveClass('h-6', 'w-6');
    expect(card).toHaveClass('h-8', 'w-8');
  });
});

describe('noProjectOption', () => {
  it('keeps its value and label and gets a tile of its own', () => {
    const option = noProjectOption('none', 'Do not link');
    const { container } = render(<>{option.icon}</>);

    expect(option).toMatchObject({ value: 'none', label: 'Do not link' });
    expect(container.querySelector('svg')).not.toBeNull();
  });
});
