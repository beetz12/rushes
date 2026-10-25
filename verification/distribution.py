#!/usr/bin/env python3
"""Verify Mac release bytes/signatures. Source checks never imply installation.

--check-source runs the owned packaging/update regressions without signing.
--acceptance-root reads an operator-reviewed inputs.json and checks real files. Artifact checks never qualify an update transition.
A missing artifact, quarantine or notarization fails; production remains separate.
"""
import argparse
import base64
import datetime
import hashlib
import json
import os
from pathlib import Path
import plistlib
import re
import subprocess
import sys

APP_ID = 'com.nexai.rushes'


def hardened_runtime(lines):
    directories = [line for line in lines if line.startswith('CodeDirectory ')]
    if len(directories) != 1:
        return False
    flags = re.search(r'(?:^|\s)flags=(0x[0-9a-fA-F]+)\(([^)]*)\)(?:\s|$)', directories[0])
    return bool(flags and int(flags.group(1), 16) & 0x10000
                and 'runtime' in flags.group(2).split(','))


def signature_properties(details, team, identifier):
    if not re.fullmatch(r'[A-Z0-9]{10}', team):
        raise ValueError('The selected Developer ID team is required')
    lines = details.splitlines()
    fields = {}
    for line in lines:
        if '=' in line:
            key, value = line.split('=', 1)
            fields.setdefault(key, []).append(value)
    if fields.get('Identifier') != [identifier] or fields.get('TeamIdentifier') != [team]:
        raise ValueError('Exact signing identifier/team did not match')
    if not any(line.startswith('Authority=Developer ID Application:') for line in lines):
        raise ValueError('Developer ID Application authority required')
    if not hardened_runtime(lines):
        raise ValueError('Hardened runtime signature required')
    if not any(line.startswith('Timestamp=') and line.split('=', 1)[1].strip().lower() not in ['', 'none'] for line in lines):
        raise ValueError('Trusted signing timestamp required')
    if 'Signature=adhoc' in lines or any(line.startswith('Authority=Apple Development:') for line in lines):
        raise ValueError('Development/ad-hoc signatures do not qualify')


def artifact_manifest(value):
    if set(value) != {'schema', 'appId', 'platform', 'arch', 'version', 'releaseDate', 'files'}:
        raise ValueError('Unexpected release metadata fields')
    if (value['schema'], value['appId'], value['platform'], value['arch']) != ('rushes.mac-release/1', APP_ID, 'darwin', 'arm64'):
        raise ValueError('Wrong release identity')
    version = value['version']
    pieces = version.split('.') if isinstance(version, str) else []
    if len(pieces) != 3 or any(not piece.isascii() or not piece.isdecimal() or (len(piece) > 1 and piece[0] == '0') or int(piece) > 9007199254740991 for piece in pieces):
        raise ValueError('Stable version required')
    date = value['releaseDate']
    if not isinstance(date, str) or not date.endswith('Z') or datetime.datetime.fromisoformat(date[:-1] + '+00:00').isoformat(timespec='milliseconds').replace('+00:00', 'Z') != date:
        raise ValueError('Exact ISO release date required')
    files = value['files']
    if not isinstance(files, list) or len(files) != 2:
        raise ValueError('One DMG and one ZIP are required')
    names = set()
    for member in files:
        if set(member) != {'url', 'size', 'sha512'}:
            raise ValueError('Unexpected artifact fields')
        if member['url'] not in {f'Rushes-{version}-arm64.dmg', f'Rushes-{version}-arm64.zip'}:
            raise ValueError('Unexpected artifact path')
        if member['url'] in names or type(member['size']) is not int or not 0 < member['size'] <= 1024 ** 3:
            raise ValueError('Invalid artifact identity or length')
        names.add(member['url'])
        digest = base64.b64decode(member['sha512'], validate=True)
        if len(digest) != 64 or base64.b64encode(digest).decode() != member['sha512']:
            raise ValueError('Invalid SHA512')
    return files


def digest(path):
    value = hashlib.sha512()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            value.update(block)
    return base64.b64encode(value.digest()).decode()


class Check:
    def __init__(self, root):
        self.root = root
        self.commands = []

    def command(self, argv, timeout=60):
        run = subprocess.run(argv, capture_output=True, text=True, timeout=timeout)
        item = {'argv': list(map(str, argv)), 'exitCode': run.returncode,
                'stdout': run.stdout, 'stderr': run.stderr}
        self.commands.append(item)
        if run.returncode != 0:
            raise ValueError(f'Required command failed: {Path(argv[0]).name} (exit {run.returncode})')
        return run.stdout + run.stderr

    def application(self, path, team, version, quarantine=False):
        if not path.is_dir() or path.is_symlink():
            raise ValueError('A real application directory is required')
        info = plistlib.loads((path / 'Contents/Info.plist').read_bytes())
        if info.get('CFBundleIdentifier') != APP_ID or info.get('CFBundleShortVersionString') != version:
            raise ValueError('Installed bundle identity/version differs from release')
        self.command(['/usr/bin/codesign', '--verify', '--deep', '--strict', str(path)])
        details = self.command(['/usr/bin/codesign', '-d', '--verbose=4', str(path)])
        signature_properties(details, team, APP_ID)
        for relative in ['Contents/Resources/bin/rushcore-engine', 'Contents/Resources/bin/rushes',
                         'Contents/Helpers/RushesAutomation.app']:
            target = path / relative
            self.command(['/usr/bin/codesign', '--verify', '--strict', str(target)])
            description = self.command(['/usr/bin/codesign', '-d', '--verbose=4', str(target)])
            nested = description.splitlines()
            if f'TeamIdentifier={team}' not in nested or not any(line.startswith('Timestamp=') for line in nested) or not hardened_runtime(nested):
                raise ValueError('Nested component signature/team/runtime is incomplete')
        self.command(['/usr/bin/xcrun', 'stapler', 'validate', str(path)])
        gatekeeper = self.command(['/usr/sbin/spctl', '--assess', '--type', 'execute', '--verbose=4', str(path)])
        if 'source=Notarized Developer ID' not in gatekeeper:
            raise ValueError('Gatekeeper did not confirm notarized Developer ID')
        if quarantine and not self.command(['/usr/bin/xattr', '-p', 'com.apple.quarantine', str(path)]).strip():
            raise ValueError('The installed acceptance app was not quarantined')

    def acceptance(self):
        if (self.root/'inputs.json').stat().st_size > 65536 or (self.root/'latest-mac.json').stat().st_size > 65536:
            raise ValueError('Acceptance metadata exceeds its bound')
        inputs = json.loads((self.root / 'inputs.json').read_text())
        manifest = json.loads((self.root / 'latest-mac.json').read_text())
        members = artifact_manifest(manifest)
        for member in members:
            path = self.root / member['url']
            if not path.is_file() or path.is_symlink() or path.stat().st_size != member['size'] or digest(path) != member['sha512']:
                raise ValueError('Actual release artifact length/digest differs')
        team = inputs.get('expectedTeam', '')
        app = Path(inputs.get('installedApp', ''))
        if not app.is_absolute():
            raise ValueError('Exact installed application path is required')
        self.application(app, team, manifest['version'], quarantine=True)
        dmg = self.root / next(item['url'] for item in members if item['url'].endswith('.dmg'))
        self.command(['/usr/bin/xcrun', 'stapler', 'validate', str(dmg)])
        return {'level': 'artifact-digests-and-installed-signatures', 'archivePayloadMatchQualified': False, 'version': manifest['version'], 'team': team,
                'productionAccepted': False, 'updateTransitionQualified': False,
                'remaining': 'Actual signed N-to-N+1 install/restart/data-preservation and decoder acceptance must be measured separately; artifact signatures cannot establish that transition.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    choice = parser.add_mutually_exclusive_group(required=True)
    choice.add_argument('--check-source', action='store_true')
    choice.add_argument('--acceptance-root', type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    if args.check_source:
        node = Path.home() / '.nvm/versions/node/v22.22.0/bin'
        env = dict(os.environ, PATH=str(node) + os.pathsep + os.environ['PATH'])
        run = subprocess.run(['npm', '--prefix', 'shell', 'test', '--', '--run', 'tests/distribution.test.mjs',
                              'tests/package-policy.test.mjs', 'tests/updater.test.ts', 'tests/update-restart.test.ts'], cwd=repo, env=env)
        print(json.dumps({'level': 'source-only', 'exitCode': run.returncode, 'productionAccepted': False}))
        return run.returncode
    check = Check(args.acceptance_root.resolve())
    try:
        result = check.acceptance()
        print(json.dumps({'status': 'verified', **result, 'commands': check.commands}))
        return 0
    except Exception as error:
        print(json.dumps({'status': 'unverified', 'reason': str(error), 'commands': check.commands}))
        return 1


if __name__ == '__main__':
    sys.exit(main())
