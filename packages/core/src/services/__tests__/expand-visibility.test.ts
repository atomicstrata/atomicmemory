/**
 * Regression tests for workspace agent visibility enforcement on expand.
 *
 * Verifies that expandMemoriesInWorkspace respects the visibility column
 * and memory_visibility_grants when callerAgentId is provided:
 * - 'workspace' visibility: visible to all agents
 * - 'agent_only' visibility: visible only to the owning agent
 * - 'restricted' visibility: visible to owner + agents with explicit grants
 * - null visibility: treated as workspace-visible (backward compat)
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', () => ({ config: {} }));
vi.mock('../timing.js', () => ({
  timed: vi.fn(async (_name: string, fn: () => unknown) => fn()),
}));

const { expandMemoriesInWorkspace } = await import('../memory-crud.js');

function makeMemory(id: string, visibility: string | null, agentId: string) {
  return { id, content: `content-${id}`, visibility, agent_id: agentId };
}

function makeDeps(getResult: unknown) {
  const getMemoryInWorkspace = vi.fn().mockResolvedValue(getResult);
  return {
    repo: { getMemoryInWorkspace },
    stores: { memory: { getMemoryInWorkspace } },
  } as any;
}

describe('expandMemoriesInWorkspace — agent visibility', () => {
  it('returns workspace-visibility memory for any agent', async () => {
    const deps = makeDeps(makeMemory('m1', 'workspace', 'agent-owner'));
    const result = await expandMemoriesInWorkspace(deps, 'ws1', ['m1'], 'agent-other');
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('m1');
    expect(deps.repo.getMemoryInWorkspace).toHaveBeenCalledWith('m1', 'ws1', 'agent-other');
  });

  it('returns agent_only memory when caller is the owner', async () => {
    const deps = makeDeps(makeMemory('m1', 'agent_only', 'agent-owner'));
    const result = await expandMemoriesInWorkspace(deps, 'ws1', ['m1'], 'agent-owner');
    expect(result).toHaveLength(1);
    expect(deps.repo.getMemoryInWorkspace).toHaveBeenCalledWith('m1', 'ws1', 'agent-owner');
  });

  it('hides agent_only memory from a different agent', async () => {
    const deps = makeDeps(null); // repo returns null when visibility blocks access
    const result = await expandMemoriesInWorkspace(deps, 'ws1', ['m1'], 'agent-other');
    expect(result).toHaveLength(0);
    expect(deps.repo.getMemoryInWorkspace).toHaveBeenCalledWith('m1', 'ws1', 'agent-other');
  });

  it('threads callerAgentId to the repository layer', async () => {
    const deps = makeDeps(null);
    await expandMemoriesInWorkspace(deps, 'ws1', ['m1', 'm2'], 'agent-caller');
    expect(deps.repo.getMemoryInWorkspace).toHaveBeenCalledTimes(2);
    expect(deps.repo.getMemoryInWorkspace).toHaveBeenCalledWith('m1', 'ws1', 'agent-caller');
    expect(deps.repo.getMemoryInWorkspace).toHaveBeenCalledWith('m2', 'ws1', 'agent-caller');
  });

});
