import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CliError } from './types.js';

interface CliSkillSummary {
  name: string;
  description: string;
  version: string;
}

interface CliSkill extends CliSkillSummary {
  content: string;
  path: string;
}

const CORE_SKILL: CliSkillSummary = {
  name: 'core',
  description: 'Agent instructions for using the installed AtomicMemory CLI.',
  version: '0.1.0',
};

const CORE_SKILL_URL = new URL('../SKILL.md', import.meta.url);

export function listSkills(): CliSkillSummary[] {
  return [CORE_SKILL];
}

export function getSkill(name = 'core'): CliSkill {
  if (name !== 'core') {
    throw new CliError('not_found', `Unknown skill: ${name}`);
  }
  return {
    ...CORE_SKILL,
    content: readFileSync(CORE_SKILL_URL, 'utf8'),
    path: fileURLToPath(CORE_SKILL_URL),
  };
}

export function getSkillPath(name = 'core'): string {
  return getSkill(name).path;
}
