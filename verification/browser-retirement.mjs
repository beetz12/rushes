// Independent owned-browser retirement check between generated CI controls.
import * as processCalls from 'node:child_process';
import * as proofFiles from 'node:fs';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

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

export function requireRetired(rows, owner, currentPid) {
  assert.ok(Number.isSafeInteger(owner.pid) && owner.pid > 0);
  assert.ok(typeof owner.profile === 'string' && owner.profile.length > 10);
  assert.ok(rows.some(row => row.pid === currentPid), 'Process inventory positive control is missing');
  for (const row of rows) {
    assert.notEqual(row.pid, owner.pid, 'Owned browser process is still present');
    const unknown = typeof row.command !== 'string' || !row.command.trim() || /^[\[(].*[\])]\s*$/.test(row.command.trim());
    if (unknown) {
      assert.ok(!/chrome|chromium/i.test(`${row.name ?? ''} ${row.command ?? ''}`), 'A Chrome command line could not be inspected');
    } else assert.ok(!row.command.toLowerCase().includes(owner.profile.toLowerCase()), 'Owned browser profile is still in use');
  }
  return { processAbsent: true, profileAbsent: true, positiveControl: currentPid };
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
    const text = processCalls.execFileSync('ps', ['-axo', 'pid=,args='], { timeout: 3000, maxBuffer: 4 * 1024 ** 2, encoding: 'utf8' });
    rows = psRows(text);
  } else throw new Error('This generated retirement check supports Mac and Windows');
  const result = requireRetired(rows, owner, process.pid);
  proofFiles.writeFileSync(process.argv[3], JSON.stringify(result), { flag: 'wx' });
  console.log(JSON.stringify(result));
}
