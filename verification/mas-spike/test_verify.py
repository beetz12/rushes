import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
import sys

spec = importlib.util.spec_from_file_location("mas_verify", Path(__file__).with_name("verify.py"))
verify = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verify)
gate_spec = importlib.util.spec_from_file_location("mas_gate", Path(__file__).resolve().parents[2] / "scripts/mas-spike/check.py")
gate = importlib.util.module_from_spec(gate_spec)
gate_spec.loader.exec_module(gate)


def receipt():
    kinds = ["screen", "camera", "microphone", "systemAudio"]
    rounds, media = [], []
    for index in (1, 2):
        originals = {kind + ".mov": "a" * 64 for kind in kinds}
        commands = [{"exit": 0, "timedOut": False, "stdout": "{}"} for _ in range(7)]
        commands[0]["stdout"] = '{"pong":true}'
        commands[1]["stdout"] = json.dumps({"pid": index + 10, "state": "idle"})
        commands[2]["stdout"] = json.dumps({"recordings": [] if index == 1 else [{"id": "take-1"}]})
        commands[4]["stdout"] = '{"ok":true}'
        rounds.append({"round": index, "pid": index + 10, "engineLog": '{"capture":"stub"}\n',
                       "package": "/container/take-" + str(index), "exports": "/container/exports-" + str(index),
                       "retirement": {"exited": True, "socketAbsent": True, "exit": 0},
                       "recording": {"id": "take-" + str(index), "status": "complete", "durationMs": 3000,
                                     "tracks": [{"kind": kind, "finalizeState": "finalized", "framesWritten": 90} for kind in kinds]},
                       "requests": commands, "originalHashesBeforeExport": originals})
        media.append({"round": index, "originalHashes": {name: {"originalSha256": value, "exportSha256": value}
                      for name, value in originals.items()}, "decodeExit": 0,
                      "package": "/container/take-" + str(index), "exports": "/container/exports-" + str(index),
                      "decoded": [{"path": "/container/take-" + str(index) + "/" + kind + ".mov", "ok": True, "duration": 3, "decodedTracks": [{"samples": 90}]} for kind in kinds]
                          + [{"path": "/container/exports-" + str(index) + "/combined.mp4", "ok": True, "duration": 3, "decodedTracks": [{"samples": 90}]}]})
    return {"schema": "rushes.mas-feasibility/1", "experimentCompleted": True,
            "appStoreReady": False, "electronMASAccepted": False, "provisionedMASAccepted": False,
            "physicalCaptureAccepted": False, "signingMode": "native-adhoc",
            "electronMAS": {"status": "not-run", "reason": "Applicable profile unavailable"},
            "signedEntitlements": {"parent": {"com.apple.security.app-sandbox": True,
                "com.apple.security.network.client": True, "com.apple.security.network.server": True,
                "com.apple.security.files.user-selected.read-write": True},
                "engine": {"com.apple.security.app-sandbox": True, "com.apple.security.inherit": True},
                "cli": {"com.apple.security.app-sandbox": True, "com.apple.security.inherit": True}},
            "control": {"sandboxEntitlement": None, "outsideWrite": {"allowed": True}, "containerWrite": True},
            "nativeLaunch": {"exit": 0, "timedOut": False},
            "ownedRetirement": {"session": 123, "retirementConfirmed": True,
                                "socket": {"path": "/container/.s/c.sock", "absentBefore": True, "absentAfter": True, "forcedRemoval": False},
                                "observations": [{"session": 123, "members": []}, {"session": 123, "members": []}]},
            "native": {"sandboxEntitlement": True, "containerWrite": True,
                "socket": "/container/.s/c.sock",
                "home": "/Users/test/Library/Containers/com.nexai.rushes.masprobe/Data", "physicalCapture": False,
                "outsideWrite": {"allowed": False, "underlyingDomain": "NSPOSIXErrorDomain", "underlyingCode": 1},
                "helperOutsideIndex": {"exit": 1, "timedOut": False, "stderr": "index-open-failed"}, "rounds": rounds},
            "media": media}


class ReceiptTests(unittest.TestCase):
    def setUp(self):
        self.data = receipt()

    def reject(self):
        with self.assertRaises(ValueError):
            verify.native_decision(self.data)

    def test_native_positive_never_accepts_store(self):
        result = verify.native_decision(self.data)
        self.assertTrue(result["nativeMechanicsAccepted"])
        self.assertFalse(result["appStoreReady"])
        self.assertFalse(result["electronMASAccepted"])

    def test_store_overclaims_are_rejected(self):
        for key in ("appStoreReady", "electronMASAccepted", "provisionedMASAccepted", "physicalCaptureAccepted"):
            with self.subTest(key=key):
                self.data = receipt()
                self.data[key] = True
                self.reject()

    def test_removed_parent_sandbox_rejected(self):
        del self.data["signedEntitlements"]["parent"]["com.apple.security.app-sandbox"]
        self.reject()

    def test_extra_sandbox_right_rejected(self):
        self.data["signedEntitlements"]["parent"]["com.apple.security.temporary-exception.files.absolute-path.read-write"] = ["/"]
        self.reject()

    def test_removed_inherit_rejected(self):
        del self.data["signedEntitlements"]["engine"]["com.apple.security.inherit"]
        self.reject()

    def test_missing_runtime_entitlement_rejected(self):
        self.data["native"]["sandboxEntitlement"] = False
        self.reject()

    def test_unwritable_control_has_no_probe_power(self):
        self.data["control"]["outsideWrite"]["allowed"] = False
        self.reject()

    def test_allowed_outside_write_rejected(self):
        self.data["native"]["outsideWrite"]["allowed"] = True
        self.reject()

    def test_false_permission_denial_rejected(self):
        self.data["native"]["outsideWrite"]["underlyingCode"] = 2
        self.reject()

    def test_failed_container_write_rejected(self):
        self.data["native"]["containerWrite"] = False
        self.reject()

    def test_helper_cannot_fake_outside_denial_by_timeout(self):
        self.data["native"]["helperOutsideIndex"]["timedOut"] = True
        self.reject()

    def test_cleanup_mutations_rejected(self):
        for key, value in [("exited", False), ("socketAbsent", False), ("exit", -9)]:
            with self.subTest(key=key):
                self.data = receipt()
                self.data["native"]["rounds"][0]["retirement"][key] = value
                self.reject()

    def test_wrong_helper_pid_rejected(self):
        self.data["native"]["rounds"][0]["requests"][1]["stdout"] = '{"pid":999,"state":"idle"}'
        self.reject()

    def test_restart_must_see_original_take(self):
        self.data["native"]["rounds"][1]["requests"][2]["stdout"] = '{"recordings":[]}'
        self.reject()

    def test_export_mutation_rejected(self):
        self.data["media"][0]["originalHashes"]["screen.mov"]["exportSha256"] = "b" * 64
        self.reject()

    def test_original_before_export_required(self):
        self.data["native"]["rounds"][0].pop("originalHashesBeforeExport")
        self.reject()

    def test_decode_extent_mutation_rejected(self):
        self.data["media"][0]["decoded"][0]["duration"] = 1
        self.reject()

    def test_all_four_tracks_required(self):
        self.data["native"]["rounds"][0]["recording"]["tracks"].pop()
        self.reject()

    def test_physical_scope_forgery_rejected(self):
        self.data["native"]["physicalCapture"] = True
        self.reject()

    def test_launch_constraint_does_not_accept_native(self):
        self.data["nativeLaunch"]["exit"] = -9
        result = verify.native_decision(self.data)
        self.assertFalse(result["nativeMechanicsAccepted"])
        self.assertFalse(result["appStoreReady"])

    def test_no_actual_exit_is_not_a_complete_constraint(self):
        self.data["nativeLaunch"]["exit"] = None
        self.reject()

    def test_failed_parent_cannot_hide_descendants(self):
        self.data["nativeLaunch"]["exit"] = -9
        self.data["ownedRetirement"]["observations"][-1]["members"] = [{"pid": 44, "group": 123}]
        self.reject()

    def test_cleanup_claim_needs_driver_observations(self):
        self.data["ownedRetirement"]["observations"] = []
        self.reject()

    def test_failed_parent_cannot_hide_leftover_socket(self):
        self.data["nativeLaunch"]["exit"] = -9
        self.data["ownedRetirement"]["socket"]["absentAfter"] = False
        self.reject()

    def test_wrong_asset_decode_rejected(self):
        self.data["media"][0]["decoded"][0]["path"] = "/another/library/screen.mov"
        self.reject()

    def test_hash_source_mutation_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "source"
            file.write_text("original")
            import hashlib
            mapping = {str(file): hashlib.sha256(file.read_bytes()).hexdigest()}
            verify.hashes(mapping)
            file.write_text("changed")
            with self.assertRaisesRegex(ValueError, "Changed bound file"):
                verify.hashes(mapping)

    def test_missing_hash_binding_rejected(self):
        with self.assertRaises(ValueError):
            verify.hashes({})

    def test_clean_room_metric_rejects_success_exit_with_hits(self):
        self.assertFalse(gate.clean_metric_passes("4\nsource.py:3 <- forbidden reference\n"))
        self.assertFalse(gate.clean_metric_passes(""))
        self.assertTrue(gate.clean_metric_passes("0\n"))

    def test_clean_room_child_warning_does_not_replace_zero_stdout_metric(self):
        with tempfile.TemporaryDirectory() as folder:
            row = gate.logged_step("spike-clean-room", [sys.executable, "-c",
                "import sys;sys.stderr.write('warning: reference clones absent\\n');sys.stderr.flush();sys.stdout.write('0\\n')"], Path(folder))
            self.assertEqual(row["exit"], 0)
            self.assertTrue(row["accepted"])
            self.assertEqual(Path(row["log"]).read_text(), "0\n")
            self.assertEqual(Path(row["stderrLog"]).read_text(), "warning: reference clones absent\n")

    def test_clean_room_child_warning_and_nonzero_metric_are_rejected(self):
        with tempfile.TemporaryDirectory() as folder:
            row = gate.logged_step("spike-clean-room", [sys.executable, "-c",
                "import sys;sys.stderr.write('warning: reference clones absent\\n');sys.stderr.flush();sys.stdout.write('1\\n')"], Path(folder))
            self.assertEqual(row["exit"], 0)
            self.assertFalse(row["accepted"])
            self.assertEqual(Path(row["log"]).read_text(), "1\n")
            self.assertEqual(Path(row["stderrLog"]).read_text(), "warning: reference clones absent\n")

    def test_clean_room_child_failure_cannot_pass_with_zero_metric(self):
        with tempfile.TemporaryDirectory() as folder:
            row = gate.logged_step("spike-clean-room", [sys.executable, "-c",
                "import sys;sys.stderr.write('warning: reference clones absent\\n');sys.stdout.write('0\\n');sys.exit(9)"], Path(folder))
            self.assertEqual(row["exit"], 9)
            self.assertFalse(row["accepted"])

    def test_combined_hash_entry_cannot_be_omitted(self):
        media = {"package": "/container/take", "exports": "/container/exports"}
        manifest = {"tracks": [{"file": "screen.mov", "present": True}]}
        media["mediaHashes"] = {path: "a" * 64 for path in ["/container/take/screen.mov",
            "/container/exports/originals/screen.mov", "/container/take/manifest.json",
            "/container/exports/combined.mp4", "/container/exports/originals/offsets.json"]}
        verify.media_hash_set(media, manifest)
        media["mediaHashes"].pop("/container/exports/combined.mp4")
        with self.assertRaisesRegex(ValueError, "hash coverage"):
            verify.media_hash_set(media, manifest)


if __name__ == "__main__":
    unittest.main()
