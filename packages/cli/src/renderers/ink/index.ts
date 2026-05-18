/**
 * @file Ink renderer entry. v5 ships Ink as the V1 human TTY renderer
 * inside text mode. This module is the only place outside
 * src/renderers/ink/ that touches the Ink API; bin.ts dispatches to
 * `renderInk` only when output-policy.inkShouldLaunch() returns true.
 *
 * Implementation contract:
 *   - Mounts a Static-list component so Ink renders deterministically
 *     and unmounts on its own — no setTimeout, no app.exit(), no
 *     timing-based exit hacks (per workspace rules forbidding timing
 *     solutions).
 *   - Errors during render propagate; we never swallow them silently.
 *   - Imports Ink/React lazily so the agent/json path never pays the
 *     module-load cost.
 *
 * The live dashboard lives next to the static renderer and is mounted
 * only for bare or explicit interactive entry.
 */

import type { CommandResult, RenderContext } from '../../types.js';
import type { InteractiveDashboardOptions } from './dashboard.js';

export async function renderInk<T>(
  ctx: RenderContext,
  result: CommandResult<T>,
): Promise<void> {
  const { render } = (await import('ink')) as typeof import('ink');
  const React = (await import('react')) as typeof import('react');
  const { CommandResultView } = await import('./tui.js');

  const instance = render(
    React.createElement(CommandResultView, { ctx, result }),
    { stdout: process.stdout, stderr: process.stderr, exitOnCtrlC: true },
  );
  // Ink's Static finishes its render synchronously and then signals
  // exit. waitUntilExit resolves cleanly in that case; on any error
  // we let it propagate — the bin's outer renderError catches and
  // turns it into a v5 error envelope.
  await instance.waitUntilExit();
}

export async function renderInteractiveDashboard(
  options: InteractiveDashboardOptions,
): Promise<void> {
  const { render } = (await import('ink')) as typeof import('ink');
  const React = (await import('react')) as typeof import('react');
  const { InteractiveDashboard } = await import('./dashboard.js');

  const instance = render(
    React.createElement(InteractiveDashboard, options),
    {
      stdin: process.stdin,
      stdout: process.stdout,
      stderr: process.stderr,
      exitOnCtrlC: false,
      patchConsole: false,
      alternateBuffer: true,
    },
  );
  await instance.waitUntilExit();
}
