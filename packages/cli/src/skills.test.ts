import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getSkill, getSkillPath, listSkills } from './skills.js';

test('listSkills exposes the bundled core skill', () => {
  assert.deepEqual(listSkills().map((skill) => skill.name), ['core']);
});

test('getSkill reads the installed skill content', () => {
  const skill = getSkill('core');

  assert.equal(skill.name, 'core');
  assert.match(skill.content, /atomicmemory doctor/);
  assert.match(skill.path, /SKILL\.md$/);
});

test('getSkillPath returns the bundled skill path', () => {
  assert.match(getSkillPath('core'), /SKILL\.md$/);
});
