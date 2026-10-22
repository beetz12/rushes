import copy
import json
import tempfile
import unittest
from unittest.mock import patch
from pathlib import Path

import engine_crash_report as subject


class OwnedCrashReportTests(unittest.TestCase):
    def setUp(self):
        self.uuid = '044289A2-FDF5-41DF-9C44-37E7777A26F0'
        self.boot = {'pid': 1234, 'bootID': 2, 'executablePath': '/owned/rushcore-engine',
                     'launchAfterUnixMs': 1767225600000, 'launchBeforeUnixMs': 1767225600020,
                     'observedExitUnixMs': 1767225601000}
        self.report = {'pid': 1234, 'procName': 'rushcore-engine', 'procPath': '/owned/rushcore-engine',
                       'procLaunch': '2026-01-01 00:00:00.010 +0000',
                       'captureTime': '2026-01-01 00:00:00.500 +0000', 'faultingThread': 0,
                       'usedImages': [{'name': 'rushcore-engine', 'uuid': self.uuid, 'source': 'P'}],
                       'threads': [{'frames': [{'imageIndex': 0, 'imageOffset': 42, 'symbol': 'generatedCrash'}]}],
                       'exception': {'type': 'EXC_BAD_ACCESS', 'signal': 'SIGSEGV'},
                       'termination': {'namespace': 'SIGNAL', 'code': 11},
                       'asi': {'unapproved': 'must not escape'}, 'vmSummary': 'must not escape'}

    def encoded(self, report=None, kind='309'):
        return json.dumps({'bug_type': kind}) + '\n' + json.dumps(report or self.report)

    def match(self, report=None, kind='309'):
        return subject.matched_report(self.encoded(report, kind), self.boot, {self.uuid}, self.boot['observedExitUnixMs'] + 100)

    def test_exact_identity_stack_and_no_unapproved_fields(self):
        result = self.match()
        self.assertEqual(result['frames'][0]['symbol'], 'generatedCrash')
        self.assertNotIn('must not escape', json.dumps(result))

    def test_apple_redaction_retains_uuid_pid_and_time_requirement(self):
        report = copy.deepcopy(self.report); report['procPath'] = '/Users/*/owned/rushcore-engine'
        self.assertIsNotNone(self.match(report))
        report['usedImages'][0]['uuid'] = 'wrong'
        self.assertIsNone(self.match(report))

    def test_wrong_identity_or_time_never_matches(self):
        changes = [('pid', 9), ('procName', 'other'), ('procPath', '/other/rushcore-engine'),
                   ('procLaunch', '2026-01-01 00:00:02 +0000'),
                   ('captureTime', '2026-01-01 00:00:02 +0000')]
        for key, value in changes:
            with self.subTest(key=key):
                report = copy.deepcopy(self.report); report[key] = value
                self.assertIsNone(self.match(report))
        self.assertIsNone(self.match(kind='288'))

    def test_missing_stack_and_invalid_image_are_rejected(self):
        for frames in [[], [{'imageIndex': 99, 'imageOffset': 1}]]:
            with self.subTest(frames=frames):
                report = copy.deepcopy(self.report); report['threads'][0]['frames'] = frames
                with self.assertRaises(ValueError):
                    self.match(report)

    def test_only_unexpected_signal11_owned_executable_boot_is_selected(self):
        boot = {**self.boot, 'exitStatus': 11, 'terminationReason': 2, 'requestedRetirement': False}
        log = 'CLI_ENGINE_FIRST_FAILURE ' + json.dumps(boot)
        self.assertEqual(subject.own_boots(log, Path('/owned/rushcore-engine')), [boot])
        for key, value in [('exitStatus', 23), ('requestedRetirement', True), ('executablePath', '/other')]:
            with self.subTest(key=key):
                self.assertEqual(subject.own_boots('CLI_ENGINE_EXIT ' + json.dumps({**boot, key: value}), Path('/owned/rushcore-engine')), [])

    def test_stack_numeric_fields_cannot_escape_as_arbitrary_data(self):
        for key, value in [('imageOffset', {'unexpected': 'private'}), ('imageOffset', -1), ('symbolLocation', ['private'])]:
            with self.subTest(key=key, value=value):
                report = copy.deepcopy(self.report); report['threads'][0]['frames'][0][key] = value
                with self.assertRaises(ValueError): self.match(report)

    def test_broken_symlink_and_malformed_prefixed_report_preserve_valid_report(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            (directory / 'rushcore-engine-missing.ips').symlink_to(directory / 'absent')
            (directory / 'rushcore-engine-malformed.ips').write_text('[]\n[]')
            (directory / 'rushcore-engine-good.ips').write_text(self.encoded())
            result = subject.collect([self.boot], {self.uuid}, [directory])
            self.assertEqual(len(result['reports']), 1)

    def test_malformed_boots_never_escape_or_hide_later_valid_boot(self):
        valid = {**self.boot, 'exitStatus': 11, 'terminationReason': 2, 'requestedRetirement': False}
        for invalid in [[], {**valid, 'bootID': {'private': 'do not copy'}}, {**valid, 'bootID': -1}]:
            with self.subTest(invalid=invalid):
                log = 'CLI_ENGINE_EXIT ' + json.dumps(invalid) + '\nCLI_ENGINE_EXIT ' + json.dumps(valid)
                self.assertEqual(subject.own_boots(log, Path('/owned/rushcore-engine')), [valid])

    def test_capture_timestamp_can_be_after_child_exit_before_report_observation(self):
        report = copy.deepcopy(self.report)
        report['captureTime'] = '2026-01-01 00:00:01.050 +0000'
        self.assertIsNotNone(subject.matched_report(self.encoded(report), self.boot, {self.uuid}, self.boot['observedExitUnixMs'] + 100))
        self.assertIsNone(subject.matched_report(self.encoded(report), self.boot, {self.uuid}, self.boot['observedExitUnixMs'] + 10))

    def test_actual_read_stays_bounded_if_file_grows_after_inventory(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root); path = directory / 'rushcore-engine-growing.ips'
            path.write_text(self.encoded()); original_open = Path.open; sizes = []
            class ReadReceipt:
                def __init__(self, handle): self.handle = handle
                def __enter__(self): return self
                def __exit__(self, *args): self.handle.close()
                def fileno(self): return self.handle.fileno()
                def read(self, size=-1):
                    sizes.append(size)
                    return self.handle.read(size)
            def growing_open(candidate, mode='r', *args, **kwargs):
                if candidate == path and mode == 'rb':
                    with original_open(path, 'ab') as writer: writer.write(b'x' * (subject.MAX_BYTES + 1))
                    return ReadReceipt(original_open(candidate, mode, *args, **kwargs))
                return original_open(candidate, mode, *args, **kwargs)
            with patch.object(Path, 'open', growing_open):
                result = subject.collect([self.boot], {self.uuid}, [directory])
            self.assertTrue(sizes and all(0 <= size <= subject.MAX_BYTES + 1 for size in sizes))
            self.assertEqual(result['reports'], [])

    def test_symlink_oversize_and_unrelated_filename_are_not_collected(self):
        with tempfile.TemporaryDirectory() as root:
            directory = Path(root)
            target = directory / 'unrelated.ips'; target.write_text(self.encoded())
            (directory / 'rushcore-engine-link.ips').symlink_to(target)
            (directory / 'rushcore-engine-large.ips').write_bytes(b'x' * (subject.MAX_BYTES + 1))
            result = subject.collect([self.boot], {self.uuid}, [directory])
            self.assertEqual(result['reports'], [])
            self.assertEqual(result['unavailablePids'], [1234])
            (directory / 'rushcore-engine-good.ips').write_text(self.encoded())
            self.assertEqual(len(subject.collect([self.boot], {self.uuid}, [directory])['reports']), 1)


if __name__ == '__main__':
    unittest.main()
