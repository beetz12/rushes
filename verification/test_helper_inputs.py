from pathlib import Path
import runpy
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
INPUTS = runpy.run_path(ROOT / 'scripts/app-intents/helper_inputs.py')


class HelperBuildInputTests(unittest.TestCase):
    def setUp(self):
        self.workspace = tempfile.TemporaryDirectory(prefix='rushes-helper-inputs-')
        self.addCleanup(self.workspace.cleanup)
        self.root = Path(self.workspace.name).resolve()

    def constant(self, directory, name, module='RushIntents', architecture='arm64', configuration='Release'):
        path = directory / 'out/Intermediates.noindex/project.build' / configuration / (module + '-t.build') / 'Objects-normal' / architecture / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text('Generated compiler-input fixture')
        return path

    def test_selected_compiler_root_excludes_foreign_build_and_target(self):
        selected = self.root / 'selected'
        expected = self.constant(selected, 'RushIntents-primary.swiftconstvalues')
        foreign = self.constant(self.root / 'foreign', expected.name)
        self.constant(selected, expected.name, module='Unrelated')
        import os
        os.utime(foreign, (2_000_000_000, 2_000_000_000))
        actual = INPUTS['compiler_constants'](selected, 'RushIntents', [], 'release')
        self.assertEqual(actual, [expected])

    def test_two_architectures_or_whole_module_variants_are_ambiguous(self):
        selected = self.root / 'selected'
        self.constant(selected, 'RushIntents-primary.swiftconstvalues')
        other = self.constant(selected, 'RushIntents-primary.swiftconstvalues', architecture='x86_64')
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            INPUTS['compiler_constants'](selected, 'RushIntents', [], 'release')
        other.unlink()
        self.constant(selected, 'RushIntents.swiftconstvalues')
        with self.assertRaisesRegex(ValueError, 'Ambiguous'):
            INPUTS['compiler_constants'](selected, 'RushIntents', [], 'release')

    def test_incremental_files_require_every_declared_source(self):
        selected = self.root / 'selected'
        first = self.constant(selected, 'Actions.swiftconstvalues', configuration='Debug')
        self.constant(selected, first.name, module='Unrelated', configuration='Debug')
        with self.assertRaisesRegex(ValueError, 'Missing'):
            INPUTS['compiler_constants'](selected, 'RushIntents', ['Actions.swift', 'Provider.swift'], 'debug')
        second = self.constant(selected, 'Provider.swiftconstvalues', configuration='Debug')
        self.assertEqual(INPUTS['compiler_constants'](selected, 'RushIntents', ['Actions.swift', 'Provider.swift'], 'debug'), [first, second])
        with self.assertRaises(ValueError):
            INPUTS['compiler_constants'](selected, 'RushIntents', ['Actions.swift'], 'release')

    def test_selected_constant_cannot_be_a_symlink_to_another_build(self):
        foreign = self.constant(self.root / 'foreign', 'RushIntents-primary.swiftconstvalues')
        selected = self.root / 'selected'
        link = self.constant(selected, foreign.name)
        link.unlink(); link.symlink_to(foreign)
        with self.assertRaisesRegex(ValueError, 'escaped'):
            INPUTS['compiler_constants'](selected, 'RushIntents', [], 'release')

    def test_helper_binary_requires_an_in_root_regular_executable(self):
        selected = self.root / 'compiler'
        binaries = selected / 'arm64-apple-macosx/release'
        binaries.mkdir(parents=True)
        executable = binaries / 'RushIntentsExtension'
        with self.assertRaisesRegex(ValueError, 'missing'):
            INPUTS['helper_binary'](selected, binaries)
        executable.write_bytes(b'generated helper fixture')
        self.assertEqual(INPUTS['helper_binary'](selected, binaries), executable)
        foreign = self.root / 'foreign'
        foreign.mkdir(); (foreign / executable.name).write_bytes(b'foreign')
        with self.assertRaisesRegex(ValueError, 'directory escaped'):
            INPUTS['helper_binary'](selected, foreign)
        executable.unlink(); executable.symlink_to(foreign / executable.name)
        with self.assertRaisesRegex(ValueError, 'executable'):
            INPUTS['helper_binary'](selected, binaries)

    def test_helper_versions_are_inherited_and_validate_stable_app_identity(self):
        self.assertEqual(INPUTS['helper_versions']('0.2.0', '42'), {'CFBundleVersion': '42', 'CFBundleShortVersionString': '0.2.0'})
        for version, build in [('0.2.0-beta', '42'), ('', '42'), ('0.2.0', '../42'), ('0.2.0', None)]:
            with self.subTest(version=version, build=build), self.assertRaises(ValueError):
                INPUTS['helper_versions'](version, build)

    def test_production_timestamp_cannot_silently_use_development_or_qa(self):
        identity = 'Developer ID Application: Generated Helper Test (ABCDEFGHIJ)'
        self.assertEqual(INPUTS['helper_timestamp'](identity, True, None, 'release'), '--timestamp')
        self.assertEqual(INPUTS['helper_timestamp']('-', False, None, 'release'), '--timestamp=none')
        for selected, socket, configuration in [('-', None, 'release'), (identity, '/generated/qa.sock', 'release'), (identity, None, 'debug')]:
            with self.subTest(identity=selected, socket=socket), self.assertRaises(ValueError):
                INPUTS['helper_timestamp'](selected, True, socket, configuration)

    def test_actual_production_entrypoint_refuses_development_before_compiler(self):
        import sys
        script = ROOT / 'scripts/app-intents/host-package.py'
        arguments = [str(script), '--production', '--output', str(self.root / 'NeverBuilt.app'), '--sign-identity', '-', '--version', '0.2.0', '--build-version', '42']
        with patch.object(sys, 'argv', arguments), patch.object(sys, 'path', [str(script.parent), *sys.path]), patch('subprocess.run') as invoked, patch('subprocess.check_output') as queried:
            with self.assertRaisesRegex(ValueError, 'Developer ID'):
                runpy.run_path(script, run_name='__main__')
            invoked.assert_not_called(); queried.assert_not_called()
        self.assertFalse((self.root / 'NeverBuilt.app').exists())

    def test_signature_fields_require_exact_identity_team_and_one_timestamp(self):
        identity = 'Developer ID Application: Generated Helper Test (ABCDEFGHIJ)'
        description = 'Authority=' + identity + '\nTeamIdentifier=ABCDEFGHIJ\nTimestamp=Generated timestamp fixture\n'
        INPUTS['production_signature_fields'](description, identity)
        for value in [description.replace('ABCDEFGHIJ\n', 'OTHERTEAM1\n'),
                      description.replace('Timestamp=', 'Signed Time='),
                      description.replace('Generated timestamp fixture', 'none'),
                      description + 'Timestamp=Another timestamp\n',
                      description.replace('Authority=' + identity, 'Authority=' + identity + 'Extra')]:
            with self.subTest(description=value), self.assertRaises(ValueError):
                INPUTS['production_signature_fields'](value, identity)

    def test_explicit_empty_versions_do_not_fall_back_to_project_defaults(self):
        import sys
        script = ROOT / 'scripts/app-intents/host-package.py'
        identity = 'Developer ID Application: Generated Helper Test (ABCDEFGHIJ)'
        for version, build in [('', '42'), ('0.2.0', '')]:
            arguments = [str(script), '--production', '--output', str(self.root / 'NeverBuilt.app'), '--sign-identity', identity, '--version', version, '--build-version', build]
            with self.subTest(version=version, build=build), patch.object(sys, 'argv', arguments), patch.object(sys, 'path', [str(script.parent), *sys.path]), patch('subprocess.run') as invoked, patch('subprocess.check_output') as queried:
                with self.assertRaisesRegex(ValueError, 'version'):
                    runpy.run_path(script, run_name='__main__')
                invoked.assert_not_called(); queried.assert_not_called()

    def test_actual_helper_entrypoint_refuses_escaping_executable(self):
        import sys
        script = ROOT / 'scripts/app-intents/host-package.py'
        foreign = self.root / 'ForeignHelper'
        foreign.write_bytes(b'outside compiler scratch')
        binary_paths = []

        def simulate_sdk(command, **kwargs):
            if command[0] == 'swift':
                scratch = Path(command[command.index('--scratch-path') + 1])
                binaries = scratch / 'arm64-apple-macosx/release'
                binaries.mkdir(parents=True)
                (binaries / 'RushIntentsExtension').symlink_to(foreign)
                binary_paths.append(binaries)
            elif command[0] == 'python3':
                metadata = Path(command[command.index('--output') + 1]) / 'RushIntentsExtension/Metadata.appintents'
                metadata.mkdir(parents=True)
                (metadata / 'extract.actionsdata').write_text('{}')

        output = self.root / 'NeverBuilt.app'
        arguments = [str(script), '--output', str(output), '--sign-identity', '-']
        with patch.object(sys, 'argv', arguments), patch.object(sys, 'path', [str(script.parent), *sys.path]), patch('subprocess.run', side_effect=simulate_sdk), patch('subprocess.check_output', side_effect=lambda *args, **kwargs: str(binary_paths[-1])):
            with self.assertRaisesRegex(ValueError, 'executable'):
                runpy.run_path(script, run_name='__main__')
        self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
