import { z } from 'zod';

const SKILL_ID_PATTERN = /^[\w.-]+$/;

/**
 * A skill id becomes a folder name under an agent skills dir, so it has to be one plain path
 * segment. '.' and '..' match the character set but would name the skills dir or its parent.
 */
export function isSafeSkillId(id: string): boolean {
  return SKILL_ID_PATTERN.test(id) && id !== '.' && id !== '..';
}

/**
 * A path inside a skill folder or a repository: relative, with no '..' segment, and no leading
 * slash, backslash or drive letter that would anchor it somewhere else.
 */
export function isSafeRelativeSkillPath(path: string): boolean {
  if (path.length === 0 || path.includes('\0')) return false;
  if (/^[\\/]/.test(path) || /^[a-zA-Z]:/.test(path)) return false;
  return !path.split(/[\\/]/).includes('..');
}

export const SkillFileSchema = z.object({
  // Where the file lands inside the installed skill folder.
  path: z.string().refine(isSafeRelativeSkillPath, 'Skill file path must stay inside the skill'),
  // A url index may point at absolute URLs here, so a folder or git source checks this on read.
  url: z.string(),
});
export type SkillFile = z.infer<typeof SkillFileSchema>;

export const SkillSchema = z.object({
  id: z.string().refine(isSafeSkillId, 'Skill id must be a single folder name'),
  name: z.string(),
  description: z.string(),
  category: z.string(),
  tags: z.array(z.string()).default([]),
  author: z.string(),
  version: z.string(),
  popularity: z.number().default(0),
  dependencies: z.array(z.string()).default([]),
  compatibility: z.array(z.string()).default([]),
  documentationUrl: z.string().optional(),
  files: z.array(SkillFileSchema).min(1),
});
export type Skill = z.infer<typeof SkillSchema>;

export const SkillRepositoryIndexSchema = z.object({
  name: z.string(),
  description: z.string().optional(),
  skills: z.array(SkillSchema),
});
export type SkillRepositoryIndex = z.infer<typeof SkillRepositoryIndexSchema>;

export type SkillRepositorySourceType = 'url' | 'git' | 'local-folder';

export interface SkillRepository {
  id: string;
  name: string;
  sourceType: SkillRepositorySourceType;
  source: string;
  addedAt: string;
  lastRefreshedAt: string | null;
}

export function parseRepositoryIndex(raw: unknown): SkillRepositoryIndex {
  return SkillRepositoryIndexSchema.parse(raw);
}
