import copy
from pathlib import Path
import unittest

from endurance import drop_check, footprint, media_check, memory_check


class EnduranceOracleTests(unittest.TestCase):
    def media(self):
        manifest={"status":"complete","clock":{"durationNs":2_000_000_000},"tracks":[
            {"role":role,"file":role+".mov","present":True} for role in ("screen","camera","mic","system")]}
        decoded=[{"path":"/owned/"+track["file"],"ok":True,"duration":2,
                  "decodedTracks":[{"samples":60,"firstPTS":0,"sampleEnd":2,"maximumGap":0,
                                    "type":"vide" if track["role"] in ("screen","camera") else "soun"}]} for track in manifest["tracks"]]
        return manifest,decoded

    def test_decode_positive_and_negative_controls(self):
        manifest,decoded=self.media()
        self.assertEqual(media_check(manifest,decoded)["seconds"],2)
        mutations=[lambda m,d:m.update(status="failed"),
                   lambda m,d:m["tracks"][0].update(present=False),
                   lambda m,d:d[0].update(ok=False),
                   lambda m,d:d[0].update(duration=1.8),
                   lambda m,d:d[0]["decodedTracks"][0].update(samples=0),
                   lambda m,d:d[0]["decodedTracks"][0].update(maximumGap=.2),
                   lambda m,d:d[0]["decodedTracks"][0].update(firstPTS=.2),
                   lambda m,d:d[0]["decodedTracks"][0].update(sampleEnd=1.8),
                   lambda m,d:d[0]["decodedTracks"][0].update(type="soun"),
                   lambda m,d:m["tracks"][0].update(offsetNs=1),
                   lambda m,d:d[0].update(path="/wrong/unknown.mov")]
        for mutate in mutations:
            m,d=copy.deepcopy((manifest,decoded));mutate(m,d)
            with self.subTest(mutation=mutate), self.assertRaises(AssertionError): media_check(m,d)

    def test_recovered_tails_require_actual_common_overlap_and_strict_metadata(self):
        manifest,decoded=self.media()
        manifest.update(status="recovered",warnings=[{"code":"recovered-track-timing"},{"code":"camera-lost"}])
        manifest["clock"]["durationNs"]=1_800_000_000
        for track,item,end in zip(manifest["tracks"],decoded,[2,.5,1.8,1.8]):
            track["durationNs"]=int(end*1e9);item["duration"]=end;item["decodedTracks"][0]["sampleEnd"]=end
        self.assertTrue(media_check(manifest,decoded)["recovery"]["lostCameraExcluded"])
        mutations=[lambda m,d:m["clock"].update(durationNs=2_000_000_000),
                   lambda m,d:m["clock"].update(durationNs=1_700_000_000),
                   lambda m,d:m["tracks"][2].pop("durationNs"),
                   lambda m,d:m["tracks"][0].update(durationNs=100_000_000),
                   lambda m,d:m.update(status="complete"),
                   lambda m,d:d[2]["decodedTracks"][0].update(type="vide"),
                   lambda m,d:d[2].update(ok=False)]
        for mutate in mutations:
            m,d=copy.deepcopy((manifest,decoded));mutate(m,d)
            with self.subTest(mutation=mutate), self.assertRaises(AssertionError): media_check(m,d)
        # Matching but shifted declarations cannot stack two 50ms tolerances.
        m,d=copy.deepcopy((manifest,decoded));m["clock"]["durationNs"]+=80_000_000
        for t in m["tracks"]:t["durationNs"]+=40_000_000
        with self.assertRaises(AssertionError): media_check(m,d)
        # A camera loss never excuses a microphone tail shorter than the clock.
        m,d=copy.deepcopy((manifest,decoded));m["tracks"][2]["durationNs"]=1_000_000_000
        d[2]["duration"]=1;d[2]["decodedTracks"][0]["sampleEnd"]=1
        with self.assertRaises(AssertionError): media_check(m,d)

    def test_screen_drop_threshold_is_not_pause_suppression(self):
        tracks=[{"kind":name,"framesWritten":1000,"framesDropped":0,"framesSuppressedByPause":9000} for name in ("screen","camera","microphone","systemAudio")]
        self.assertEqual(drop_check(tracks),0)
        tracks[0]["framesDropped"]=10
        self.assertLess(drop_check(tracks),.01)
        tracks[0]["framesDropped"]=11
        with self.assertRaises(AssertionError): drop_check(tracks)
        tracks[0]["framesDropped"]=0;tracks[1]["errorDescription"]="encoder failed"
        with self.assertRaises(AssertionError): drop_check(tracks)

    def test_memory_requires_actual_minute5_and_minute30(self):
        samples=[{"seconds":300,"physicalFootprintBytes":100*2**20},{"seconds":1800,"physicalFootprintBytes":150*2**20}]
        self.assertEqual(memory_check(samples)["growthBytes"],50*2**20)
        samples[1]["physicalFootprintBytes"]+=1
        with self.assertRaises(AssertionError): memory_check(samples)
        samples[1]["seconds"]=1790
        with self.assertRaises(AssertionError): memory_check(samples)
        with self.assertRaises(AssertionError): memory_check(samples[:1])

    def test_physical_instrument_cannot_silently_return_rss_or_zero(self):
        # Platform-independent oracle tests also run on non-macOS CI; the
        # authentic libproc positive control belongs to each actual Mac run.
        import os,sys
        if sys.platform != "darwin": self.skipTest("macOS libproc only")
        self.assertGreater(footprint(os.getpid()),0)
        with self.assertRaises(OSError): footprint(2_147_483_647)


if __name__ == "__main__": unittest.main()
