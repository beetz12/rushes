import { Arch } from 'electron-builder';
import { runOwnedHelper } from './owned-helper-build.mjs';
import addresses from 'node:url';
import paths from 'node:path';
import disk from 'node:fs/promises';

const project = addresses.fileURLToPath(new URL('../../', import.meta.url));
const script = paths.join(project, 'scripts/app-intents/embed-host.py');

// electron-builder awaits afterPack before signing the containing application.
export function nativeHelperBeforeSigning(signing, run = runOwnedHelper) {
  return async context => {
    if (process.platform !== 'darwin' || process.arch !== 'arm64' || context.electronPlatformName !== 'darwin' || context.arch !== Arch.arm64)
      throw new Error('The native automation helper requires the supported ARM64 Mac target.');
    if (context.packager.appInfo.productFilename !== 'Rushes') throw new Error('Unexpected containing application identity.');
    const cancellation = context.packager.info.cancellationToken;
    if (cancellation.cancelled) throw new Error('Helper packaging was cancelled before launch.');
    const application = paths.resolve(context.appOutDir, 'Rushes.app');
    const argumentsList = [script, '--app', application, '--sign-identity', signing.mac?.identity ?? '-', '--configuration', 'release'];
    if (signing.forceCodeSigning === true) argumentsList.push('--production');
    await run('python3', argumentsList, { cwd: project, cancellation });
    const helper = paths.join(application, 'Contents/Helpers/RushesAutomation.app/Contents');
    for (const member of ['Info.plist', 'MacOS/RushesAutomation', 'Resources/Metadata.appintents/extract.actionsdata'])
      await disk.access(paths.join(helper, member));
    if (cancellation.cancelled) throw new Error('Helper packaging was cancelled before outer signing.');
  };
}
