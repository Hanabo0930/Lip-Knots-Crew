"""Synthetic fixtures only: no real observation, source archive, credential or API."""
import base64
import copy
import datetime as dt
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch
from types import SimpleNamespace

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[1]
def load(name, filename):
    spec = importlib.util.spec_from_file_location(name, HERE / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

g = load("source_test_readiness", "check-hosting-api-readiness.py")
e = load("source_test_evidence", "hosting_source_evidence.py")
SHA = "a" * 40
NOW = dt.datetime(2026, 10, 22, 6, 5, tzinfo=dt.timezone.utc)
BEFORE, BUILDS, AFTER = "2026-10-22T06:01:00Z", "2026-10-22T06:02:00Z", "2026-10-22T06:03:00Z"
BUILD = f"projects/{g.PROJECT}/locations/{g.REGION}/builds/11111111-1111-1111-1111-111111111111"


class SourceEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.bundle_dir = self.root / "hosting-source-evidence"
        self.bundle_dir.mkdir()
        values = {"apps/admin/src/case-mail-release.json": '{"enabled":false}',
                  "functions/package.json": '{"main":"lib/index.js"}',
                  "functions/lib/index.js": "exports.synthetic = true;\n",
                  "functions/lib/uploads.js": "exports.synthetic = true;\n",
                  "functions/src/uploads.ts": "export const synthetic = true;\n",
                  "functions/case-mail-runtime/adapter.cjs": "module.exports = {};\n"}
        for name, value in values.items():
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(value, encoding="utf-8")
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w") as z:
            for p in (self.root / "functions").rglob("*"):
                if p.is_file():
                    z.writestr(p.relative_to(self.root / "functions").as_posix(), p.read_bytes())
        self.blob = stream.getvalue()
        (self.bundle_dir / "synthetic-source.zip").write_bytes(self.blob)
        raw_hash = hashlib.sha256(self.blob).digest()
        self.source = {"bucket": g.BUCKET, "object": "synthetic/source.zip", "generation": "123"}
        self.uri = f"gs://{g.BUCKET}/synthetic/source.zip#123"
        prefix = f"projects/{g.PROJECT}/locations/{g.REGION}"
        functions = {name: {
            "name": f"{prefix}/functions/{name}", "environment": "GEN_2", "state": "ACTIVE",
            "updateTime": "2026-10-22T05:59:00Z",
            "buildConfig": {"build": BUILD, "runtime": "nodejs22", "entryPoint": name,
                            "sourceProvenance": {"resolvedStorageSource": copy.deepcopy(self.source)}},
            "serviceConfig": {"service": f"{prefix}/services/{name.lower()}",
                              "revision": name.lower() + "-00001-test", "allTrafficOnLatestRevision": True},
        } for name in e.FUNCTIONS}
        build = {"name": BUILD, "id": BUILD.rsplit("/", 1)[1], "projectId": g.PROJECT,
                 "status": "SUCCESS", "createTime": "2026-10-22T05:55:00Z",
                 "startTime": "2026-10-22T05:56:00Z", "finishTime": "2026-10-22T05:58:00Z",
                 "sourceProvenance": {"resolvedStorageSource": copy.deepcopy(self.source),
                   "fileHashes": {self.uri: {"fileHash": [{"type": "SHA256", "value": base64.b64encode(raw_hash).decode()}]}}}}
        self.bundle = {"schemaVersion": 1, "projectId": g.PROJECT, "region": g.REGION,
                       "sourceSha": SHA, "expiresAt": "2026-10-22T06:10:00Z",
                       "observations": {
                           "before": {"capturedAt": BEFORE, "functions": functions},
                           "builds": {"capturedAt": BUILDS, "records": {BUILD: build}},
                           "after": {"capturedAt": AFTER, "functions": copy.deepcopy(functions)}},
                       "expectedInventory": g.expected_files(self.root),
                       "archives": {self.uri: {"file": "synthetic-source.zip", "sha256": raw_hash.hex()}}}
        self.env = {
            "GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "Hanabo0930/Lip-Knots-Crew",
            "GITHUB_REF": "refs/heads/main", "GITHUB_REF_NAME": "main", "GITHUB_JOB": "promote",
            "GITHUB_WORKFLOW_REF": e.WORKFLOW, "GITHUB_RUN_ATTEMPT": "1",
            "GITHUB_EVENT_NAME": "workflow_dispatch", "LKC_OPERATION": "readiness",
            "LKC_CONFIRMATION": "CHECK_LKC_STAGING_HOSTING_READINESS",
            "LKC_PROJECT_ID": g.PROJECT, "LKC_REGION": g.REGION, "LKC_EVIDENCE_POLICY": "source-provenance",
            "LKC_METADATA_ONLY": "false", "LKC_SOURCE_SHA": SHA, "RUNNER_TEMP": str(self.root),
        }

    def save(self, bundle=None):
        raw = json.dumps(self.bundle if bundle is None else bundle, separators=(",", ":")).encode()
        (self.bundle_dir / "bundle.json").write_bytes(raw)
        return hashlib.sha256(raw).hexdigest()

    def verify(self, bundle=None, **kwargs):
        approved = self.save(bundle)
        # Fail immediately if a regression attempts a cloud reader or subprocess.
        with patch.object(socket, "create_connection", side_effect=AssertionError("NETWORK_FORBIDDEN")), \
             patch.object(g.subprocess, "run", side_effect=AssertionError("SUBPROCESS_FORBIDDEN")), \
             patch.object(g.subprocess, "check_output", return_value=SHA.encode()) as git:
            result = e.verify_bundle(self.root, SHA, self.bundle_dir, approved, g, now=NOW, **kwargs)
            if kwargs.get("preflight"):
                git.assert_not_called()
            else:
                self.assertEqual(git.call_args.args[0], ["git", "-C", str(self.root), "rev-parse", "HEAD"])
            return result

    def reject(self, mutate, code=None):
        bundle = copy.deepcopy(self.bundle)
        mutate(bundle)
        with self.assertRaises((e.EvidenceError, g.ReadinessError)) as caught:
            self.verify(bundle)
        if code:
            self.assertIn(code, str(caught.exception))

    def test_complete_reviewed_bundle_matches_exact_build(self):
        result = self.verify()
        self.assertEqual(result["status"], "PASS")
        self.assertFalse(result["externalApiInvoked"])
        self.assertFalse(result["hostingPromotionAuthorized"])
        self.assertEqual(result["authenticatedStaffAcceptance"], "UNVERIFIED")
        self.assertEqual(result["verifiedFileCount"], len(self.bundle["expectedInventory"]))
        self.assertNotIn("gs://", json.dumps(result))

    def test_preflight_is_not_readiness_or_promotion_pass(self):
        result = self.verify(preflight=True)
        self.assertEqual(result["status"], "PREFLIGHT_READY")
        self.assertFalse(result["deployedSourceVerified"])
        self.assertFalse(result["hostingPromotionAuthorized"])

    def test_bundle_cannot_supply_its_own_trust(self):
        for name, value in [("verified", True), ("status", "CONSISTENT"), ("approvedDigest", "a" * 64),
                            ("originVerified", True)]:
            with self.subTest(field=name):
                self.reject(lambda b: b.update({name: value}), "FIELDS")
        approved = self.save()
        with self.assertRaisesRegex(e.EvidenceError, "SOURCE_REVIEW_DIGEST_MISMATCH"):
            e.load_bundle(self.bundle_dir, "0" * 64, SHA, g, NOW)
        with self.assertRaisesRegex(e.EvidenceError, "DIGEST"):
            e.load_bundle(self.bundle_dir, "", SHA, g, NOW)
        self.assertEqual(len(approved), 64)

    def test_duplicate_json_keys_even_with_pinned_bytes_rejected(self):
        self.save()
        p = self.bundle_dir / "bundle.json"
        raw = p.read_bytes().replace(b'{"schemaVersion":1', b'{"schemaVersion":1,"schemaVersion":1', 1)
        p.write_bytes(raw)
        with self.assertRaisesRegex(e.EvidenceError, "DUPLICATE_KEY"):
            e.load_bundle(self.bundle_dir, hashlib.sha256(raw).hexdigest(), SHA, g, NOW)

    def test_context_and_independent_pin_are_mandatory(self):
        env = {**self.env, "LKC_APPROVED_SOURCE_EVIDENCE_SHA256": self.save()}
        self.assertEqual(e.protected_context(SHA, env)[0], self.bundle_dir)
        for field, invalid in [
            ("GITHUB_ACTIONS", "false"), ("GITHUB_REPOSITORY", "other/repo"),
            ("GITHUB_REF", "refs/heads/feature"), ("GITHUB_JOB", "other"),
            ("GITHUB_WORKFLOW_REF", e.WORKFLOW.replace("@refs/heads/main", "@refs/heads/feature")),
            ("GITHUB_RUN_ATTEMPT", "2"), ("LKC_OPERATION", "restore"), ("LKC_METADATA_ONLY", "true"),
            ("LKC_EVIDENCE_POLICY", "limited-staff-pilot"), ("LKC_PROJECT_ID", "other"),
            ("LKC_REGION", "us-central1"), ("LKC_CONFIRMATION", "wrong"),
            ("LKC_SOURCE_SHA", "b" * 40), ("RUNNER_TEMP", "relative"),
            ("LKC_APPROVED_SOURCE_EVIDENCE_SHA256", ""),
        ]:
            with self.subTest(field=field), self.assertRaises(e.EvidenceError):
                e.protected_context(SHA, {**env, field: invalid})

    def test_expired_future_and_inverted_observations_stop(self):
        for phase, value in [("before", "2026-10-22T06:06:00Z"),
                             ("before", "2026-10-22T05:54:59Z"),
                             ("builds", "2026-10-22T06:00:00Z"),
                             ("after", "2026-10-22T06:06:00Z")]:
            with self.subTest(phase=phase, value=value):
                self.reject(lambda b: b["observations"][phase].update(capturedAt=value), "STALE_OR_FUTURE")
        for expires in ["2026-10-22T06:05:00Z", "2026-10-22T06:11:01Z", "invalid"]:
            with self.subTest(expires=expires):
                self.reject(lambda b: b.update(expiresAt=expires))

    def test_wrong_source_identity_and_partial_records_stop(self):
        for field, value in [("sourceSha", "b" * 40), ("projectId", "other"), ("region", "us-central1"),
                             ("schemaVersion", True)]:
            with self.subTest(field=field):
                self.reject(lambda b: b.update({field: value}))
        self.reject(lambda b: b["observations"]["before"]["functions"].pop("finalizeStagedUpload"))
        self.reject(lambda b: b["observations"]["builds"]["records"].clear())

    def test_function_revision_generation_build_and_traffic_changes_stop(self):
        mutations = [
            lambda d: d["serviceConfig"].update(revision="createuploadsession-00002-test"),
            lambda d: d["serviceConfig"].update(allTrafficOnLatestRevision=False),
            lambda d: d["buildConfig"]["sourceProvenance"]["resolvedStorageSource"].update(generation="124"),
            lambda d: d["buildConfig"].update(build=BUILD.replace("11111111-", "22222222-", 1)),
            lambda d: d.update(updateTime="2026-10-22T06:02:30Z"),
        ]
        for mutate in mutations:
            with self.subTest(mutation=mutate):
                self.reject(lambda b: mutate(b["observations"]["after"]["functions"]["createUploadSession"]))

    def test_secret_and_nonallowlisted_metadata_fields_rejected(self):
        self.reject(lambda b: b["observations"]["before"]["functions"]["createUploadSession"]["serviceConfig"].update(
            environmentVariables={"SYNTHETIC": "DO_NOT_ECHO"}), "FIELDS")
        self.reject(lambda b: b["observations"]["builds"]["records"][BUILD].update(
            secrets=["DO_NOT_ECHO"]), "FIELDS")

    def test_exact_existing_successful_build_and_fixed_generation_required(self):
        changes = [
            lambda d: d.update(status="FAILURE"),
            lambda d: d.update(projectId="other"),
            lambda d: d.update(id="22222222-2222-2222-2222-222222222222"),
            lambda d: d.update(name=BUILD.replace("asia-northeast1", "us-central1")),
            lambda d: d.update(finishTime="2026-10-22T06:04:00Z"),
            lambda d: d["sourceProvenance"]["resolvedStorageSource"].update(generation="124"),
            lambda d: d["sourceProvenance"]["resolvedStorageSource"].update(bucket="other"),
        ]
        for mutate in changes:
            with self.subTest(mutation=mutate):
                self.reject(lambda b: mutate(b["observations"]["builds"]["records"][BUILD]))

    def test_build_hash_must_describe_this_archive(self):
        def hashes(b):
            return b["observations"]["builds"]["records"][BUILD]["sourceProvenance"]["fileHashes"]
        self.reject(lambda b: hashes(b).update({"unrelated": hashes(b).pop(self.uri)}), "HASH_SCOPE")
        self.reject(lambda b: hashes(b)[self.uri]["fileHash"].clear(), "HASH")
        self.reject(lambda b: hashes(b)[self.uri]["fileHash"][0].update(value="bad-base64"), "HASH")
        self.reject(lambda b: hashes(b)[self.uri]["fileHash"][0].update(
            type="MD5", value=base64.b64encode(b"x" * 16).decode()), "SHA256_REQUIRED")
        self.reject(lambda b: hashes(b)[self.uri]["fileHash"].append(
            copy.deepcopy(hashes(b)[self.uri]["fileHash"][0])), "HASH")
        self.reject(lambda b: hashes(b)[self.uri]["fileHash"][0].update(
            value=base64.b64encode(b"x" * 32).decode()), "BUILD_HASH_MISMATCH")

    def test_all_supplementary_build_hashes_must_match_retained_bytes(self):
        b = copy.deepcopy(self.bundle)
        hashes = b["observations"]["builds"]["records"][BUILD]["sourceProvenance"]["fileHashes"][self.uri]["fileHash"]
        for kind in ["MD5", "SHA512"]:
            hashes.append({"type": kind, "value": base64.b64encode(
                hashlib.new(kind.lower(), self.blob).digest()).decode()})
        self.assertEqual(self.verify(b)["status"], "PASS")
        for index in [1, 2]:
            with self.subTest(kind=hashes[index]["type"]):
                changed = copy.deepcopy(b)
                record = changed["observations"]["builds"]["records"][BUILD]["sourceProvenance"]["fileHashes"][self.uri]["fileHash"][index]
                record["value"] = base64.b64encode(hashlib.new(
                    record["type"].lower(), b"different retained bytes").digest()).decode()
                with self.assertRaisesRegex(e.EvidenceError, "BYTES_MISMATCH"):
                    self.verify(changed)

    def test_hash_key_without_generation_requires_matching_resolved_generation(self):
        b = copy.deepcopy(self.bundle)
        hashes = b["observations"]["builds"]["records"][BUILD]["sourceProvenance"]["fileHashes"]
        hashes[self.uri.rsplit("#", 1)[0]] = hashes.pop(self.uri)
        self.assertEqual(self.verify(b)["status"], "PASS")

    def test_archive_bytes_paths_and_hardlinks_are_checked(self):
        for value in ["../source.zip", "/tmp/source.zip", "nested/source.zip", "source.txt"]:
            with self.subTest(value=value):
                self.reject(lambda b: b["archives"][self.uri].update(file=value), "PATH")
        p = self.bundle_dir / "synthetic-source.zip"
        p.write_bytes(self.blob + b"tampered")
        with self.assertRaisesRegex(e.EvidenceError, "BYTES_MISMATCH"):
            self.verify()
        p.write_bytes(self.blob)
        link = self.bundle_dir / "linked-source.zip"
        if os.name == "nt":
            # Windows sandbox denies link creation. Exercise the stat boundary;
            # the standard Linux CI below uses an actual hard link.
            info = SimpleNamespace(st_mode=stat.S_IFREG, st_file_attributes=0, st_nlink=2, st_size=1)
            with patch.object(pathlib.Path, "lstat", return_value=info), self.assertRaisesRegex(e.EvidenceError, "SIZE_REJECTED"):
                e.regular_read(p, e.MAX_ARCHIVE)
        else:
            os.link(p, link)
            with self.assertRaisesRegex(e.EvidenceError, "SIZE_REJECTED"):
                self.verify()

    def test_mismatched_or_incomplete_inventory_cannot_pass(self):
        self.reject(lambda b: b["expectedInventory"].pop("lib/uploads.js"), "INVENTORY")
        self.reject(lambda b: b["expectedInventory"].update({"src/uploads.ts": "0" * 64}), "SOURCE_MISMATCH")
        (self.root / "functions/src/additional.ts").write_text("export const extra = true;")
        with self.assertRaisesRegex(e.EvidenceError, "APPROVED_INVENTORY"):
            self.verify()

    def test_absent_archive_does_not_trigger_fallback(self):
        (self.bundle_dir / "synthetic-source.zip").unlink()
        with self.assertRaises(FileNotFoundError), patch.object(
                subprocess, "run", side_effect=AssertionError("NO_NETWORK_SOURCE_FALLBACK")):
            self.verify()

    def test_default_legacy_checker_cannot_start_cloud_reader(self):
        with patch.object(subprocess, "run", side_effect=AssertionError("NO_SUBPROCESS")):
            with self.assertRaisesRegex(g.ReadinessError, "VERIFIED_EVIDENCE_INPUT_REQUIRED"):
                g.check(self.root, SHA)

    def test_actual_cli_has_no_digest_or_archive_override(self):
        result = subprocess.run([sys.executable, "-B", str(HERE / "check-hosting-api-readiness.py"),
                                 "--root", str(self.root), "--source-sha", SHA,
                                 "--evidence", str(self.root / "result.json")],
                                env={**os.environ, "GITHUB_ACTIONS": "false"}, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0)
        report = json.loads((self.root / "result.json").read_text())
        self.assertEqual(report, {"status": "STOPPED", "reason": "PROTECTED_WORKFLOW_CONTEXT_REQUIRED"})
        self.assertNotIn("DO_NOT_ECHO", result.stdout + result.stderr)


    def test_actual_cli_preflight_uses_only_the_pinned_local_bundle(self):
        current = dt.datetime.now(dt.timezone.utc).replace(microsecond=0)
        stamp = lambda seconds: (current + dt.timedelta(seconds=seconds)).isoformat().replace("+00:00", "Z")
        for phase, seconds in [("before", -180), ("builds", -150), ("after", -120)]:
            self.bundle["observations"][phase]["capturedAt"] = stamp(seconds)
        self.bundle["expiresAt"] = stamp(60)
        for phase in ["before", "after"]:
            for record in self.bundle["observations"][phase]["functions"].values():
                record["updateTime"] = stamp(-240)
        build = self.bundle["observations"]["builds"]["records"][BUILD]
        build.update(createTime=stamp(-420), startTime=stamp(-360), finishTime=stamp(-300))
        approved = self.save()
        args = [sys.executable, "-B", str(HERE / "check-hosting-api-readiness.py"),
                "--root", str(self.root), "--source-sha", SHA, "--preflight",
                "--evidence", str(self.root / "preflight.json")]
        env = {**os.environ, **self.env, "LKC_APPROVED_SOURCE_EVIDENCE_SHA256": approved}
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        report = json.loads((self.root / "preflight.json").read_text())
        self.assertEqual(report["status"], "PREFLIGHT_READY")
        self.assertFalse(report["deployedSourceVerified"])
        (self.bundle_dir / "synthetic-source.zip").unlink()
        result = subprocess.run(args, env=env, capture_output=True, text=True, timeout=10)
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(json.loads((self.root / "preflight.json").read_text())["status"], "STOPPED")
    def test_workflow_preserves_trust_and_mutation_boundaries(self):
        workflow = (ROOT / ".github/workflows/staging-hosting-promote.yml").read_text("utf-8")
        binding = "          LKC_APPROVED_SOURCE_EVIDENCE_SHA256: ${{ vars.LKC_STAGING_SOURCE_EVIDENCE_SHA256 }}"
        self.assertEqual(workflow.count(binding), 2)
        job = workflow[workflow.index("  promote:"):]
        self.assertNotIn("LKC_APPROVED_SOURCE_EVIDENCE_SHA256", job[:job.index("    steps:")])
        for name in ["Stop source verification unless a no-fee path is established", "Verify deployed upload APIs before any live Hosting change"]:
            start = workflow.index("      - name: " + name)
            end = workflow.index("\n      - name:", start + 1)
            self.assertIn("        env:\n" + binding, workflow[start:end])
        self.assertNotIn("inputs.source_evidence", workflow)
        self.assertNotIn("setup-gcloud", workflow)
        self.assertLess(workflow.index("--no-fee-source-guard"),
                        workflow.index("Authenticate with the short-lived staging identity"))
        self.assertLess(workflow.index("Verify deployed upload APIs"),
                        workflow.index("Back up both current live channels"))
        self.assertIn("environment: lkc-staging-hosting", workflow)
        self.assertIn("Validate limited evidence against fresh pinned API metadata", workflow)
        self.assertIn("Recheck limited trial capture and API revisions before live write", workflow)


if __name__ == "__main__":
    unittest.main()
