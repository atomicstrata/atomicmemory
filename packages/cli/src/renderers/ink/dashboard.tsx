/**
 * @file Public Ink dashboard module. Runtime imports keep using
 * `renderers/ink/dashboard.js`; the actual implementation is split
 * under `renderers/ink/dashboard/` so each file stays small and
 * testable.
 */

export { InteractiveDashboard } from './dashboard/index.js';
export type { InteractiveDashboardOptions } from './dashboard/types.js';
export {
  commandForSubmittedMenuInput,
  commandMenuItems,
  commandMenuReservedRows,
  interactiveHelpText,
} from './dashboard/menu.js';
export { formatDashboardCommandResult } from './dashboard/format.js';
export { sanitizeCapturedDashboardWrites } from './dashboard/console-capture.js';
export {
  sessionBodyHeightForTerminal,
  sessionScrollOffset,
  wrapSessionLine,
} from './dashboard/session.js';
