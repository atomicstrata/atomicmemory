/** Run the deterministic, credential-free local example from the command line. */
import { runOfflineDemo } from './demo.js';

process.stdout.write(`${JSON.stringify(await runOfflineDemo(), null, 2)}\n`);
