import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { hasGit, initGitRepo, tempDir, writeTree } from '../../test/main/fixtures';
import { gitFacts } from './gitFilter';

/**
 * Git is the judge of which folders belong to the project. These run real git against real
 * repositories, because a mocked answer would only prove the mock.
 */
describe.runIf(hasGit())('gitFacts', () => {
  it('knows nothing about a folder that is not a repository', async () => {
    const dir = writeTree(tempDir(), { 'dist/app.js': 'x' });
    const facts = await gitFacts(dir, ['dist']);
    expect(facts.inRepo).toBe(false);
    expect(facts.tracked.size).toBe(0);
    expect(facts.ignored.size).toBe(0);
  });

  it('finds a folder git tracks, so it is never offered', async () => {
    const { dir } = initGitRepo({ 'build/keep.txt': 'tracked', 'src/a.ts': 'a' });
    const facts = await gitFacts(dir, ['build']);
    expect(facts.inRepo).toBe(true);
    expect(facts.tracked.has('build')).toBe(true);
  });

  it('finds a folder git ignores', async () => {
    const { dir } = initGitRepo({ '.gitignore': 'dist/\nnode_modules/\n' });
    writeTree(dir, { 'dist/app.js': 'x', 'node_modules/pkg/index.js': 'y' });
    const facts = await gitFacts(dir, ['dist', 'node_modules']);
    expect([...facts.ignored].sort()).toEqual(['dist', 'node_modules']);
    expect(facts.tracked.size).toBe(0);
  });

  it('tells apart tracked, ignored and neither', async () => {
    const { dir } = initGitRepo({
      '.gitignore': 'dist/\n',
      'build/keep.txt': 'tracked',
    });
    writeTree(dir, { 'dist/app.js': 'x', 'out/app.js': 'y' });
    const facts = await gitFacts(dir, ['build', 'dist', 'out']);
    expect([...facts.tracked]).toEqual(['build']);
    expect([...facts.ignored]).toEqual(['dist']);
  });

  it('counts a folder as tracked when only a file deep inside it is', async () => {
    const { dir } = initGitRepo({ 'vendor/acme/lib/deep/file.php': '<?php' });
    const facts = await gitFacts(dir, ['vendor']);
    expect(facts.tracked.has('vendor')).toBe(true);
  });

  it('works for a project that is a subfolder of a bigger repository', async () => {
    const { dir } = initGitRepo({
      '.gitignore': 'dist/\n',
      'app/build/keep.txt': 'tracked',
      'app/src/a.ts': 'a',
    });
    writeTree(dir, { 'app/dist/app.js': 'x' });
    const facts = await gitFacts(join(dir, 'app'), ['build', 'dist']);
    expect(facts.inRepo).toBe(true);
    expect([...facts.tracked]).toEqual(['build']);
    expect([...facts.ignored]).toEqual(['dist']);
  });

  it('handles nested paths written with forward slashes', async () => {
    const { dir } = initGitRepo({
      '.gitignore': 'node_modules/\n',
      'apps/web/src/a.ts': 'a',
    });
    writeTree(dir, { 'apps/web/node_modules/x/i.js': 'x' });
    const facts = await gitFacts(dir, ['apps/web/node_modules']);
    expect(facts.ignored.has('apps/web/node_modules')).toBe(true);
  });

  it('treats glob characters and spaces in a path as plain text', async () => {
    const { dir } = initGitRepo({ 'a [1]/build/keep.txt': 'tracked', 'plain/build/x.txt': 'y' });
    const facts = await gitFacts(dir, ['a [1]/build', 'plain/build']);
    expect([...facts.tracked].sort()).toEqual(['a [1]/build', 'plain/build']);
    const none = await gitFacts(dir, ['a ?1?/build']);
    expect(none.tracked.size).toBe(0);
  });

  it('copes with more paths than fit in one command', async () => {
    const { dir } = initGitRepo({ 'build/keep.txt': 'tracked' });
    const many = Array.from({ length: 450 }, (_, i) => `pkg${i}/dist`);
    const facts = await gitFacts(dir, [...many, 'build']);
    expect([...facts.tracked]).toEqual(['build']);
  });

  it('still reports the repository when there is nothing to ask about', async () => {
    const { dir } = initGitRepo();
    const facts = await gitFacts(dir, []);
    expect(facts.inRepo).toBe(true);
    expect(facts.tracked.size).toBe(0);
    expect(facts.ignored.size).toBe(0);
  });
});
