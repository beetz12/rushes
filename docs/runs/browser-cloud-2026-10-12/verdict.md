# Independent complete browser-candidate verdict

**FAIL for release readiness.** Short capture, recovery, UI and tenant-service
fixtures pass, but the protected M1 maximum/background outcome is not achieved.
Three supported P2 integration findings were found; the history and reassessment
below distinguish repaired code from remaining release conditions.

Review base: `853ff16`. Initial candidate: `37c7838`. Root path repair: `95aa8f7`,
copied as `7987d00` with equal Git tree hashes. This checker authored no business
code. It used its own checkout/dependencies, Node22.22.0, synthetic media, actual
SQLite/RSA/HMAC fixtures and isolated browser profiles. No sharedGUI, real screen,
camera/microphone, provider account, sharedBeads, public push or PR was operated.

The review opened the implementation contract, run log, paid plan and C2 verdict,
original capture/upload/service design notes, applicable development/evidence and
clean-room guidance, and the full changed-surface inventory. It inspected capture,
OPFS/recovery, React controls/accounts/sharing, API/upload protocol, Worker routes,
auth/session families, tenancy/schema/quotas, providers/billing, cleanup/budget,
numbered migrations and deployment/CI seams. CSS and fixture surfaces were covered
by targeted source inspection plus actual responsive UI tests/screenshots. This
scope is not a claim of exhaustive formal verification or deployed-provider proof.

## Supported findings and repair history

### R1 — P2: Windows filesystem URLs were used as native paths

At `37c7838`, `browser/test/ui-studio.test.mjs:18` passed file-URL `.pathname` as
both Vite entry and cwd. `ui-upload.test.mjs:4/6` and `ui-service.test.mjs:5` passed
it to esbuild. A Windows `file:///D:/a/...` URL produces `/D:/a/...`; encoded spaces
remain `%20`. The pinned-runtime probe records both the wrong Windows value and
the correct native `fileURLToPath(...,{windows:true})` value. A real esbuild
positive control in a private directory with a space failed for `.pathname` and
passed for `fileURLToPath`. This would prevent the planned Windows UI gate from
starting correctly. [Node URL documentation](https://nodejs.org/api/url.html#urlfileurltopathurl-options).

**Repaired at `95aa8f7`:** all four esbuild/Vite filesystem entry points and cwd use
`fileURLToPath`; HTTP routes still use pathname. This reviewer copied the repair,
read the exact diff, confirmed equal root/reviewer trees, and reran the actual UI
gate:36/36 pass on namedChrome155. Physical Windows/remoteCI acceptance is still
pending; the portable conversion and Mac positive control do not establish it.

### R2 — P2: a Windows CI native failure could be masked by a later success

At `95aa8f7`, `.github/workflows/browser.yml:44–47` executes service check then
browser build in one default PowerShell step. Dependency installation at32–35 has
the same shape. GitHub prepends its PowerShell error preference but reports the
last native exit; PowerShell defaults native error-preference propagation off.
Therefore a failed native npm service check followed by a successful build can
return a passing step. Split the commands into separate steps or guard every
native exit explicitly. This is a source/primary-documentation finding; PowerShell
was not installed on this Mac and no remote Windows run was fabricated.
[GitHub shell exit semantics](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#exit-codes-and-error-action-preference),
[PowerShell native-command preference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_preference_variables#psnativecommanduseerroractionpreference).

**Repaired at `bb1d818`:** each install/check/build runs in its own step. The
checker copied this as `58c2c43`, inspected the exact source diff, and verified
that all ten run steps contain one command. This removes the later-success
overwrite path. `ci-step-recheck.json` is a source/shape check; remote Windows
execution remains pending publication approval.

### R3 — P2: normal limit-stop metadata exceeds the service's exact bound

`browser/src/capture/index.ts:170/194` preserves actual elapsed wall time;
automatic-stop checks at159/298 wait until elapsed reaches the nominal limit.
`browser-worker/src/records.ts:74` accepts no manifest beyond600000ms. Scheduling
and first-sample offsets mean a completed limit take can be rejected before the
provider can validate its encoded duration.

A bounded real-time analog used an isolated one-second limit with the production
coordinator/worker/recorders/storage unchanged otherwise. Chrome155 stopped
complete at1016.9ms, while the decoded composition was969ms. The actual Worker
rejected manifest600016.9ms with400 `INVALID_REQUEST`. This is a reproduced timing
seam, not a ten-minute recording test. Coordinate bounded clock-metadata tolerance
with provider-measured≤600s and the existing≤250ms decoded-duration agreement;
do not enlarge the provider duration, reservations or protected sync assertions.

**Reassessment pending the coordinated root repair.**

## Fresh passing checks

| Surface / command | Actual result |
|---|---|
| Worker `npm --prefix browser-worker run check` | Build0;67tests/67pass/0fail, real SQLite/cryptography and injected provider/clock faults. |
| Browser `npm --prefix browser run build` | TypeScript0; Vite0, actual worker/UI assets. |
| Capture `npm --prefix browser run test:capture`, Chrome155.0.8059.39 | Exit0;18/18. |
| Same capture command, officialChrome154.0.8037.92, sequential | Exit0;18/18. |
| `node --test browser/test/ui*.mjs`, Chrome155, after R1 repair | Exit0;36/36, including actual Worker binary-PUT/CSRF and already-ready re-entry seams. |
| Full source clean scan | Exit0, first output0. |
| Clean-input / notice negative controls | Exit0;3 and5 controls pass. |
| Notice verification | Exit0;2derived files,36 pinned direct npm dependencies. |
| Node syntax for deployment and official-Chrome installer | Exit0. No remote provisioning was attempted. |
| C3 independent late-ready/source-release probe | Pass: late ready cannot return a released session, every input ended, no draft. See separate C3 verdict. |

The built browser JavaScript scan found zero occurrences of six privileged
server-binding names in both UI and worker assets; it is a narrow bundle-boundary
scan, not a claim that arbitrary secret detection is complete. Responsive fixture
screenshots at1440/1024/768/390 were produced; this reviewer visually opened the
1440studio and390account captures. They fit their intended layout and show explicit
permissions/local backup and test-mode billing. This is synthetic UI evidence.

## M1 and release conditions remain explicit

This reviewer opened the retained metrics for `long-565fdf4`,
`long-preview-565fdf4` and `diagnostic240-2-d023ba4`. Their actual final states are
interrupted; the long runs did not complete five pauses, the target duration or
five minutes offline. The observer-free diagnostic also failed to complete240s.
The recorded virtual pages remained visible/focused. Original source565fdf4 and
its fixture hashes remain retained; C3 startup success does not replace those
failed sustained outcomes or prove the current candidate's long behavior.

No new long matrix was run here. Protected ten-minute decoded sync/gaps/duration,
bounded recording/finalization memory, app/tab switching, physical minimization,
actual external-folder kill durability and the named Windows/Mac physical picker
matrix remain unverified. The source/GPU allocation explanation remains a
hypothesis, not a diagnosis inferred from these short tests.

The unmodified native baseline log ends319tests/31issues after554.399s. Native
VideoToolbox finalization was the retained failure area; browser diffs do not
establish its cause. Per root's hold, this reviewer did not repeat heavy Swift
tests while the host was locked. The declared merged umbrella gate remains due.

Local provider fixtures do not establish real Google login, Stream private
creation/ingestion/tus/process/playback/deletion, Stripe test Checkout/webhooks,
provider-origin anonymity, restart read-back, invoice/metric reconciliation,
token replay exposure, restore/alerts or the deployed source revision. M2–M4 have
useful local evidence but remain subject to these deployment/operations gates.
M5 additionally requires reviewed product/privacy/retention/refund/support copy
and David's exact audience/live-payment/service-spend approval. Public repository
publication is a separate pending approval; this checker made no push or PR.

Private proof: `~/.goal-loop/loom-clone/host/2026-10-12-browser/candidate-review/`.
Files include service/browser-build/capture155/capture154/UI/clean/notices logs,
path-probe.json, late-ready.json, limit-probe.mjs/json/log, bundle scan and UI
screenshots. Failed/earlier probes remain retained with their actual browser scope.
