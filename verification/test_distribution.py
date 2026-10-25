import base64
import copy
import unittest
from distribution import signature_properties, artifact_manifest


class DistributionProofTests(unittest.TestCase):
    def test_development_signature_does_not_qualify_as_production(self):
        for authority in ['Authority=Apple Development: Fixture', 'Signature=adhoc']:
            with self.assertRaises(ValueError):
                signature_properties('Identifier=com.nexai.rushes\nTeamIdentifier=TESTTEAM12\nflags=0x10000(runtime)\nTimestamp=fixture\n' + authority, 'TESTTEAM12', 'com.nexai.rushes')

    def test_signer_requires_exact_team_timestamp_runtime_and_bundle(self):
        details = 'Identifier=com.nexai.rushes\nTeamIdentifier=TESTTEAM12\nAuthority=Developer ID Application: Fixture\nflags=0x10000(runtime)\nTimestamp=fixture\n'
        signature_properties(details, 'TESTTEAM12', 'com.nexai.rushes')
        for fragment in ['TeamIdentifier=TESTTEAM12', 'Timestamp=fixture', 'flags=0x10000(runtime)', 'Identifier=com.nexai.rushes']:
            with self.assertRaises(ValueError):
                signature_properties(details.replace(fragment, ''), 'TESTTEAM12', 'com.nexai.rushes')

        for old, new in [('Identifier=com.nexai.rushes', 'Identifier=com.nexai.rushes.other-app'), ('TeamIdentifier=TESTTEAM12', 'TeamIdentifier=TESTTEAM12OTHER')]:
            with self.assertRaises(ValueError):
                signature_properties(details.replace(old, new), 'TESTTEAM12', 'com.nexai.rushes')

    def test_manifest_requires_real_artifact_pair_and_public_identity(self):
        value = dict(schema='rushes.mac-release/1', appId='com.nexai.rushes', platform='darwin', arch='arm64', version='0.1.1', releaseDate='2026-10-24T00:00:00.000Z', files=[dict(url=f'Rushes-0.1.1-arm64.{kind}', size=1, sha512=base64.b64encode(bytes(64)).decode()) for kind in ['zip', 'dmg']])
        self.assertEqual(len(artifact_manifest(value)), 2)
        mutations = [lambda v: v.update(schema='rushes.development-build/1'), lambda v: v['files'][0].update(url='../outside.zip'), lambda v: v['files'][0].update(size=0), lambda v: v['files'][0].update(sha512='fake'), lambda v: v['files'].pop()]
        for mutate in mutations:
            other = copy.deepcopy(value)
            mutate(other)
            with self.assertRaises((ValueError, TypeError)):
                artifact_manifest(other)
