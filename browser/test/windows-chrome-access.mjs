// Installer setup for the owned public Chrome payload; never change profile ACLs.
import * as childCalls from 'node:child_process';
import * as payloadFiles from 'node:fs/promises';
import * as payloadPaths from 'node:path';
import { promisify } from 'node:util';

export const sandboxPrincipals = Object.freeze(['S-1-15-2-1', 'S-1-15-2-2']);
// Windows file GENERIC_READ | GENERIC_EXECUTE includes SYNCHRONIZE.
export const sandboxReadExecuteMask = 0x1200a9;
const literal = value => "'" + value.replaceAll("'", "''") + "'";

function requirePayloadRows(rows, paths) {
  if (!Array.isArray(rows) || rows.length !== paths.length) throw new Error('Incomplete Chrome ACL read-back');
  for (const path of paths) {
    const matching = rows.filter(row => row.path === path);
    if (matching.length !== 1 || !Array.isArray(matching[0].rules)) throw new Error('Missing Chrome payload ACL');
  }
}
export function requirePayloadRules(rows, paths) {
  requirePayloadRows(rows, paths);
  for (const path of paths) {
    const matching = rows.filter(row => row.path === path);
    for (const sid of sandboxPrincipals) {
      const rules = matching[0].rules.filter(rule => rule.sid === sid);
      if (rules.some(rule => !Number.isSafeInteger(rule.accessMask) || rule.accessMask < 0 || rule.accessMask > 0xffffffff
        || ['allow', 'inherits', 'appliesHere', 'propagates'].some(field => typeof rule[field] !== 'boolean')))
        throw new Error('Incomplete Chrome ACL rule');
      if (rules.some(rule => rule.allow !== true && (rule.accessMask & sandboxReadExecuteMask) !== 0)
        || !rules.some(rule => rule.allow === true && (rule.accessMask & sandboxReadExecuteMask) === sandboxReadExecuteMask && rule.appliesHere === true
          && (path !== paths[0] || (rule.inherits === true && rule.propagates === true))))
        throw new Error(`Chrome payload lacks the requested inheritable read/execute ACL for ${sid}`);
    }
  }
}

export async function configureWindowsChromeAccess(root, runFile = promisify(childCalls.execFile)) {
  if (payloadPaths.basename(root) !== 'chrome-win64') throw new Error('Expected the owned Chrome payload directory');
  const paths = [root, payloadPaths.join(root, 'chrome.exe'), payloadPaths.join(root, 'chrome.dll')];
  for (const [index, path] of paths.entries()) {
    const item = await payloadFiles.lstat(path);
    if (item.isSymbolicLink() || (index === 0 ? !item.isDirectory() : !item.isFile()))
      throw new Error('Chrome ACL setup requires ordinary owned payload files');
  }
  const script = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);
    Import-Module -Name ([System.IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Security','Microsoft.PowerShell.Security.psd1')) -Force -ErrorAction Stop;
    Import-Module -Name ([System.IO.Path]::Combine($PSHOME,'Modules','Microsoft.PowerShell.Utility','Microsoft.PowerShell.Utility.psd1')) -Force -ErrorAction Stop;
    $rows=@(foreach($path in @(${paths.map(literal).join(',')})) {
      $rules=@(foreach($rule in (Get-Acl -LiteralPath $path).GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])) {
        [pscustomobject]@{sid=$rule.IdentityReference.Value; allow=($rule.AccessControlType -eq 'Allow');
          accessMask=[int]$rule.FileSystemRights;
          inherits=(([int]$rule.InheritanceFlags -band 3) -eq 3);
          appliesHere=(([int]$rule.PropagationFlags -band 2) -eq 0);
          propagates=([int]$rule.PropagationFlags -eq 0)}
      }); [pscustomobject]@{path=$path;rules=$rules}
    });
    $security=(Get-Command -Name Get-Acl -CommandType Cmdlet).Module.Path;
    $utility=(Get-Command -Name ConvertTo-Json -CommandType Cmdlet).Module.Path;
    $nativeRoot=$PSHOME+[System.IO.Path]::DirectorySeparatorChar;
    $shell=[pscustomobject]@{version=$PSVersionTable.PSVersion.ToString();edition=$PSVersionTable.PSEdition;
      modulePaths=@($security,$utility);nativeModules=($security.StartsWith($nativeRoot,[StringComparison]::OrdinalIgnoreCase) -and $utility.StartsWith($nativeRoot,[StringComparison]::OrdinalIgnoreCase))};
    ConvertTo-Json -InputObject ([pscustomobject]@{rows=$rows;shell=$shell}) -Depth 6 -Compress`;
  const receiptPath = payloadPaths.join(payloadPaths.dirname(root), 'windows-sandbox-access.json');
  const receipt = { root, checkedPaths: paths, state: 'preparing', grants: [] };
  await payloadFiles.writeFile(receiptPath, JSON.stringify(receipt), { flag: 'wx', mode: 0o600 });
  const save = () => payloadFiles.writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  const readRules = async () => {
    const result = JSON.parse((await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { timeout: 15000 })).stdout);
    if (!Array.isArray(result?.rows) || result.shell?.nativeModules !== true
      || typeof result.shell.version !== 'string' || typeof result.shell.edition !== 'string'
      || !Array.isArray(result.shell.modulePaths) || result.shell.modulePaths.length !== 2
      || result.shell.modulePaths.some(path => typeof path !== 'string' || !path))
      throw new Error('Native Windows PowerShell module proof is unavailable');
    receipt.shell = result.shell; return result.rows;
  };
  try {
    receipt.phase = 'read-before'; receipt.before = await readRules(); requirePayloadRows(receipt.before, paths); await save();
    for (const sid of sandboxPrincipals) {
      receipt.phase = `grant ${sid}`; await save();
      await runFile('icacls.exe', [root, '/grant', `*${sid}:(OI)(CI)(RX)`], { timeout: 15000 });
      receipt.grants.push({ sid, actualExit: 0 }); await save();
    }
    receipt.phase = 'read-after'; receipt.after = await readRules();
    requirePayloadRules(receipt.after, paths); receipt.state = 'requested-rules-verified'; await save();
  } catch (error) {
    receipt.state = 'failed'; receipt.error = { name: error.name, code: error.code ?? null };
    try { await save(); }
    catch (persistence) { throw new AggregateError([error, persistence], 'Chrome ACL setup and its failure receipt could not finish'); }
    throw error;
  }
  return { principalSids: sandboxPrincipals, checkedPaths: paths, requestedReadExecuteRulesVerified: true,
    receiptPath,
    effectiveSandboxChild: 'Requires the real sandboxed browser qualification; ACL read-back alone is insufficient' };
}
