"""Extract bounded stack metadata only for an identified owned engine boot."""
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time

MAX_BYTES = 4 * 1024 * 1024


def epoch_ms(value):
    if not isinstance(value, str):
        raise ValueError('Missing report time')
    for pattern in ['%Y-%m-%d %H:%M:%S.%f %z', '%Y-%m-%d %H:%M:%S %z']:
        try:
            return datetime.strptime(value, pattern).timestamp() * 1000
        except ValueError:
            pass
    raise ValueError('Unsupported Apple report time')


def matched_report(data, boot, uuids, report_observed_ms=None):
    """Apple IPS: first-line309 metadata, remaining JSON crash object."""
    first, body = data.split('\n', 1)
    metadata = json.loads(first)
    if not isinstance(metadata, dict):
        raise ValueError('Invalid report metadata')
    if str(metadata.get('bug_type')) != '309':
        return None
    report = json.loads(body)
    if not isinstance(report, dict):
        raise ValueError('Invalid crash object')
    if report.get('pid') != boot['pid']:
        return None
    launch, crash = epoch_ms(report.get('procLaunch')), epoch_ms(report.get('captureTime'))
    if report_observed_ms is None:
        report_observed_ms = time.time() * 1000
    # Account only for millisecond precision of report dates, not process reuse.
    if not (boot['launchAfterUnixMs'] - 1 <= launch <= boot['launchBeforeUnixMs'] + 1
            and launch <= crash <= report_observed_ms + 1):
        return None
    executable = Path(boot['executablePath'])
    if report.get('procName') != executable.name:
        return None
    path = report.get('procPath')
    if not isinstance(path, str):
        return None
    # Apple redacts user-identifying components. Identity still requires UUID.
    if '*' not in path and path != str(executable):
        return None
    images = report.get('usedImages', [])
    if not isinstance(images, list) or not all(isinstance(item, dict) for item in images):
        raise ValueError('Invalid image records')
    mains = [item for item in images if item.get('name') == executable.name
             and str(item.get('uuid', '')).upper() in uuids and item.get('source') == 'P']
    if len(mains) != 1:
        return None
    threads = report.get('threads', [])
    fault = report.get('faultingThread')
    if not isinstance(threads, list) or type(fault) is not int or not 0 <= fault < len(threads) or not isinstance(threads[fault], dict):
        raise ValueError('Missing faulting thread')
    frames = threads[fault].get('frames', [])
    if not isinstance(frames, list) or not frames:
        raise ValueError('No crash stack frames')
    output = []
    for frame in frames[:64]:
        if not isinstance(frame, dict):
            raise ValueError('Invalid stack frame')
        index = frame.get('imageIndex')
        if type(index) is not int or not 0 <= index < len(images):
            raise ValueError('Invalid stack image index')
        image = images[index]
        for key in ['imageOffset', 'symbolLocation']:
            value = frame.get(key)
            if value is None and key == 'symbolLocation':
                continue
            if type(value) is not int or not 0 <= value < 2 ** 64:
                raise ValueError('Invalid numeric stack field')
        if not all(isinstance(image.get(key, ''), str) for key in ['uuid', 'name']) or not isinstance(frame.get('symbol', ''), str):
            raise ValueError('Invalid stack labels')
        output.append({'imageUUID': str(image.get('uuid', ''))[:64],
                       'imageName': str(image.get('name', ''))[:128],
                       'imageOffset': frame.get('imageOffset'),
                       'symbol': str(frame.get('symbol', ''))[:512],
                       'symbolLocation': frame.get('symbolLocation')})
    if not all(isinstance(report.get(key, {}), dict) for key in ['exception', 'termination']):
        raise ValueError('Invalid termination fields')
    return {'pid': boot['pid'], 'bootID': boot.get('bootID'),
            'launchUnixMs': launch, 'crashUnixMs': crash,
            'mainImageUUID': mains[0]['uuid'], 'faultingThread': fault,
            'exception': {key: str(report.get('exception', {}).get(key, ''))[:512] for key in ['type', 'signal', 'subtype', 'codes']},
            'termination': {key: str(report.get('termination', {}).get(key, ''))[:512] for key in ['namespace', 'code', 'indicator']},
            'frames': output, 'omittedFrames': max(0, len(frames) - len(output))}


def own_boots(log, executable):
    found = {}
    for line in log.splitlines():
        for label in ['CLI_ENGINE_FIRST_FAILURE ', 'CLI_ENGINE_EXIT ']:
            if label not in line:
                continue
            try:
                item = json.JSONDecoder().raw_decode(line.split(label, 1)[1])[0]
                if (isinstance(item, dict) and type(item.get('pid')) is int
                        and type(item.get('bootID')) is int and item['bootID'] > 0
                        and not item.get('requestedRetirement', True)
                        and item.get('terminationReason') == 2 and item.get('exitStatus') == 11
                        and item.get('executablePath') == str(executable)
                        and all(type(item.get(k)) in [int, float] for k in
                                ['launchAfterUnixMs', 'launchBeforeUnixMs', 'observedExitUnixMs'])):
                    found[item['pid']] = item
            except (ValueError, TypeError):
                continue
    return list(found.values())


def collect(boots, uuids, directories):
    result = {'schema': 'rushes.owned-engine-crash/1', 'reports': [], 'unavailablePids': [], 'errors': []}
    candidates = []
    for directory in directories:
        names = {Path(boot['executablePath']).name for boot in boots}
        for name in names:
            observed = []
            try:
                for number, path in enumerate(directory.glob(name + '*.ips')):
                    if number >= 256:
                        if len(result['errors']) < 16:
                            result['errors'].append('Report inventory exceeded256 entries')
                        break
                    try:
                        info = path.lstat()
                        if stat.S_ISREG(info.st_mode) and info.st_size <= MAX_BYTES:
                            observed.append((info.st_mtime, path, info))
                    except OSError:
                        continue
            except OSError:
                continue
            candidates.extend(sorted(observed, key=lambda item: item[0], reverse=True)[:64])
    for boot in boots:
        matches = []
        for _, path, original in candidates:
            try:
                with path.open('rb') as handle:
                    current = os.fstat(handle.fileno())
                    if not stat.S_ISREG(current.st_mode) or (current.st_dev, current.st_ino) != (original.st_dev, original.st_ino):
                        continue
                    data = handle.read(MAX_BYTES + 1)
                if len(data) > MAX_BYTES:
                    continue
                report = matched_report(data.decode('utf-8'), boot, uuids)
                if report:
                    report['reportSHA256'] = hashlib.sha256(data).hexdigest()
                    matches.append(report)
            except (OSError, ValueError, TypeError, KeyError) as error:
                if len(result['errors']) < 16:
                    result['errors'].append(type(error).__name__)
        unique = {item['reportSHA256']: item for item in matches}
        if len(unique) == 1:
            result['reports'].extend(unique.values())
        else:
            result['unavailablePids'].append(boot['pid'])
            if unique:
                result['errors'].append('Ambiguous owned crash reports')
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--log', type=Path, required=True)
    parser.add_argument('--engine', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--reports', type=Path, action='append')
    options = parser.parse_args()
    executable = options.engine.resolve(strict=True)
    identity = subprocess.run(['dwarfdump', '--uuid', str(executable)], check=True,
                              capture_output=True, text=True, timeout=5)
    uuids = {s.upper() for s in re.findall(r'UUID: ([0-9A-Fa-f-]{36})', identity.stdout)}
    if not uuids:
        raise ValueError('No exact engine Mach-O UUID')
    boots = own_boots(options.log.read_text(), executable)
    directories = options.reports or [Path.home() / 'Library/Logs/DiagnosticReports', Path('/Library/Logs/DiagnosticReports'), Path.home() / 'Library/Logs/DiagnosticReports/Retired', Path('/Library/Logs/DiagnosticReports/Retired')]
    result = collect(boots, uuids, directories)
    result['ownedBootCount'] = len(boots)
    result['binarySHA256'] = hashlib.sha256(executable.read_bytes()).hexdigest()
    result['binaryUUIDs'] = sorted(uuids)
    options.output.write_text(json.dumps(result, indent=2))
    print(json.dumps({'ownedBoots': len(boots), 'matchedStacks': len(result['reports']),
                      'unavailablePids': result['unavailablePids'], 'errors': result['errors']}))


if __name__ == '__main__':
    main()
