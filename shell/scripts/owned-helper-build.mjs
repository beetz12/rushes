import processes from 'node:child_process';
import utilities from 'node:util';
import addresses from 'node:url';

const execute = utilities.promisify(processes.execFile);
const sessionTool = addresses.fileURLToPath(new URL('./helper-session.py', import.meta.url));

// Retire every process group in the command's new POSIX session before signing.
export function runOwnedHelper(command, argumentsList, options = {}) {
  const { cwd, cancellation, timeoutMs = 900000, stopWaitMs = 2000, killWaitMs = 3000 } = options;
  if (process.platform !== 'darwin') return Promise.reject(new Error('Native helper builds require macOS.'));
  for (const value of [timeoutMs, stopWaitMs, killWaitMs])
    if (!Number.isFinite(value) || value <= 0 || value > 900000) return Promise.reject(new Error('A finite helper build budget is required.'));
  if (cancellation?.cancelled) return Promise.reject(new Error('Native helper build was cancelled before launch.'));
  return new Promise((resolve, reject) => {
    let child, closed = false, exited = false, exitCode, exitSignal, reason, settled = false;
    let deadline, poll, escalation, retirementLimit, retiringSignal, exhausted = false;
    let checking = false, emptySnapshots = 0, lastMembers = [];
    let retained = Buffer.alloc(0), outputBytes = 0;
    function retain(chunk) {
      outputBytes += chunk.length;
      retained = Buffer.concat([retained, chunk]).subarray(-65536);
    }
    async function members() {
      if (!child?.pid) return [];
      const args = [sessionTool, String(child.pid)];
      if (retiringSignal) args.push('--signal', retiringSignal);
      const response = await execute('python3', args, { cwd, timeout: 3000, maxBuffer: 262144 });
      const value = JSON.parse(response.stdout);
      if (value.session !== child.pid || !Array.isArray(value.members) || value.members.some(member =>
        !Number.isSafeInteger(member.pid) || member.pid <= 1 || !Number.isSafeInteger(member.group) || member.group <= 1))
        throw new Error('Native helper session membership could not be verified.');
      return value.members;
    }
    function finish(retirementFailure = false) {
      if (settled) return;
      settled = true;
      for (const timer of [deadline, escalation, retirementLimit]) clearTimeout(timer);
      clearInterval(poll);
      cancellation?.removeListener('cancel', cancelled);
      process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', terminated);
      const result = { actualExitCode: exitCode, signal: exitSignal, outputBytes, outputTail: retained.toString(),
        ownedPid: child?.pid, ownedSession: child?.pid, retirementConfirmed: !retirementFailure, lastSessionMembers: lastMembers };
      if (retirementFailure) {
        reason = new Error('Native helper session retirement could not be confirmed.');
        child?.stdout?.destroy(); child?.stderr?.destroy();
      }
      if (reason || exitCode !== 0 || exitSignal) {
        const failure = reason ?? new Error('Native helper build failed.');
        failure.buildResult = result; reject(failure);
      } else resolve(result);
    }
    function stop(error) {
      reason ??= error;
      if (retirementLimit) return;
      retiringSignal = 'TERM';
      escalation = setTimeout(() => { retiringSignal = 'KILL'; void checkRetirement(); }, stopWaitMs);
      retirementLimit = setTimeout(() => { exhausted = true; void checkRetirement(); }, stopWaitMs + killWaitMs);
      void checkRetirement();
    }
    async function checkRetirement() {
      if (settled || checking || (!closed && !exited && !reason)) return;
      checking = true;
      try {
        lastMembers = await members();
        if (settled) return;
        if (exited && lastMembers.length && !reason) stop(new Error('Native helper left build descendants running.'));
        emptySnapshots = closed && lastMembers.length === 0 ? emptySnapshots + 1 : 0;
        if (emptySnapshots >= 2) finish();
        else if (exhausted) finish(true);
      } catch (error) {
        stop(error);
        if (exhausted) finish(true);
      } finally { checking = false; }
    }
    function cancelled() { stop(new Error('Native helper build was cancelled.')); }
    function interrupted() { process.exitCode = 130; stop(new Error('Native helper build interrupted by SIGINT.')); }
    function terminated() { process.exitCode = 143; stop(new Error('Native helper build interrupted by SIGTERM.')); }
    cancellation?.on('cancel', cancelled);
    process.on('SIGINT', interrupted); process.on('SIGTERM', terminated);
    poll = setInterval(() => { void checkRetirement(); }, 100);
    deadline = setTimeout(() => stop(new Error('Native helper build deadline exceeded.')), timeoutMs);
    try {
      if (cancellation?.cancelled) { reason = new Error('Native helper build was cancelled before launch.'); closed = true; finish(); return; }
      child = processes.spawn(command, argumentsList, { cwd, detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.on('data', retain); child.stderr.on('data', retain);
      child.on('error', error => { reason ??= error; });
      child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; void checkRetirement(); });
      child.on('close', (code, signal) => { closed = true; exitCode = code; exitSignal = signal; void checkRetirement(); });
    } catch (error) { closed = !child; stop(error); }
  });
}
