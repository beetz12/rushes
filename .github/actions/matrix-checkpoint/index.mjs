import { main } from '../../../browser/test/matrix-checkpoint-action.mjs';
try { process.exitCode = await main(); }
catch { console.error('Generated matrix checkpoint supervisor failed'); process.exitCode = 1; }
