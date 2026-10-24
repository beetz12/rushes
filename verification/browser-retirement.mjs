// Independent owned-browser retirement check between generated CI controls.
import * as processCalls from 'node:child_process';
import * as proofFiles from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

export function ownedProfile(command) {
  assert.ok(typeof command === 'string' && command.trim(), 'Owned browser command line is unavailable');
  const matches = [...command.matchAll(/--user-data-dir=(?:"([^"\r\n]+)"|([^\r\n]*?playwright_chromiumdev_profile-[A-Za-z0-9_-]+))(?=["\s]|$)/g)];
  assert.equal(matches.length, 1, 'Expected exactly one owned Playwright profile');
  const profile = matches[0][1] ?? matches[0][2];
  assert.match(profile, /[/\\]playwright_chromiumdev_profile-[A-Za-z0-9_-]+$/, 'Unexpected owned profile directory');
  return profile;
}

export function psRows(text) {
  return text.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(.*)$/);
    assert.ok(match, 'Malformed process inventory row');
    return { pid: Number(match[1]), command: match[2] };
  });
}

// State is diagnostic only: no process state exempts any original rejection.
export function statefulPsRows(text) {
  return text.trim().split('\n').map(line => {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.*)$/);
    assert.ok(match, 'Malformed state-bearing process inventory row');
    return { pid: Number(match[1]), state: match[2], command: match[3] };
  });
}

export function requireRetired(rows, owner, currentPid) {
  let currentRow = null;
  try {
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
  assert.ok(typeof owner.profile === 'string' && owner.profile.length > 10);
  assert.ok(rows.some(row => row.pid === currentPid), 'Process inventory positive control is missing');
  for (const row of rows) {
    currentRow = row;
    assert.notEqual(row.pid, owner.pid, 'Owned browser process is still present');
    const unknown = typeof row.command !== 'string' || !row.command.trim() || /^[\[(].*[\])]\s*$/.test(row.command.trim());
    if (unknown) {
      assert.ok(!/chrome|chromium/i.test(`${row.name ?? ''} ${row.command ?? ''}`), 'A Chrome command line could not be inspected');
    } else assert.ok(!row.command.toLowerCase().includes(owner.profile.toLowerCase()), 'Owned browser profile is still in use');
  }
  return { processAbsent: true, profileAbsent: true, positiveControl: currentPid };
  } catch (error) {
    // Preserve the exact original assertion and fail closed even if diagnostics fail.
    try {
      const command = typeof currentRow?.command === 'string' ? currentRow.command : '';
      const opaque = !command.trim() || /^[\[(].*[\])]\s*$/.test(command.trim());
      const name = typeof currentRow?.name === 'string' ? currentRow.name : '';
      const chromeDetected = /chrome|chromium/i.test(name + ' ' + command);
      const nameClass = /chromium/i.test(name) ? 'chromium' : /chrome/i.test(name) ? 'chrome' : name ? 'other' : 'unavailable';
      error.retirementEvidence = {
        schema: 'rushes.retirement-refusal/1', observedAt: new Date().toISOString(),
        reason: error.message, ownerPid: owner?.pid, positiveControlPid: currentPid,
        positiveControlSeen: rows.some(row => row.pid === currentPid),
        blockedRow: currentRow ? { pid: currentRow.pid, state: currentRow.state ?? null,
          nameClass, nameBytes: Buffer.byteLength(name), nameSHA256: createHash('sha256').update(name).digest('hex'),
          opaqueCommandShape: !command.trim() ? 'empty' : opaque ? 'bracketed' : 'available', chromeDetected,
          commandBytes: Buffer.byteLength(command), commandSHA256: createHash('sha256').update(command).digest('hex') } : null,
        limitation: 'Only this captured inventory; no state exception, retry, or attribution to a later snapshot.'
      };
    } catch { /* The original assertion remains the first failure. */ }
    throw error;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 4) throw new Error('Usage: browser-retirement.mjs <owner.json> <new-retirement.json>');
  const owner = JSON.parse(proofFiles.readFileSync(process.argv[2], 'utf8'));
  let rows;
  if (process.platform === 'win32') {
    const script = 'Get-CimInstance Win32_Process | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress';
    const text = processCalls.execFileSync('powershell.exe', ['-NoProfile', '-Command', script], { timeout: 10000, maxBuffer: 4 * 1024 ** 2, encoding: 'utf8' });
    const value = JSON.parse(text);
    rows = (Array.isArray(value) ? value : [value]).map(row => ({ pid: row.ProcessId, name: row.Name, command: row.CommandLine }));
  } else if (process.platform === 'darwin') {
    const text = processCalls.execFileSync('ps', ['-ww', '-axo', 'pid=,state=,args='], { timeout: 3000, maxBuffer: 4 * 1024 ** 2, encoding: 'utf8' });
    rows = statefulPsRows(text);
  } else throw new Error('This generated retirement check supports Mac and Windows');
  let result;
  try { result = requireRetired(rows, owner, process.pid); }
  catch (error) {
    try {
      proofFiles.writeFileSync(process.argv[3], JSON.stringify({ accepted: false,
        failureClassification: 'predicate-refused', failure: error.retirementEvidence ?? { reason: error.message } }), { flag: 'wx' });
    } catch { /* Do not replace the retirement refusal with a reporting error. */ }
    throw error;
  }
  proofFiles.writeFileSync(process.argv[3], JSON.stringify(result), { flag: 'wx' });
  console.log(JSON.stringify(result));
}
