"""Trusted collector fixtures only. No credentials, real source, network or writes to cloud."""
import base64
import contextlib
import copy
import datetime as dt
import hashlib
import hmac
import importlib.util
import io
import json
import os
import pathlib
import socket
import sys
import tempfile
import unittest
import zipfile
from unittest.mock import patch

HERE = pathlib.Path(__file__).resolve().parent


def load(name, file):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


g = load("fixed_test_readiness", "check-hosting-api-readiness.py")
e = load("fixed_test_evidence", "hosting_source_evidence.py")
SHA = "a" * 40
NOW = dt.datetime(2026, 10, 31, 0, 5, tzinfo=dt.timezone.utc)
BUILD = f"projects/{g.PROJECT}/locations/{g.REGION}/builds/11111111-1111-1111-1111-111111111111"
SECOND = BUILD.replace("11111111-1111-1111-1111-111111111111", "22222222-2222-2222-2222-222222222222")


def archive(files):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as z:
        for name, value in files.items():
            z.writestr(name, value)
    return stream.getvalue()


class FixedSourceEvidenceTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.directory = self.root / "hosting-fixed-source-evidence"
        self.directory.mkdir(mode=0o700)
        self.files = {"package.json": b'{"main":"lib/index.js"}',
                      "lib/index.js": b"exports.synthetic=1;\n",
                      "lib/uploads.js": b"exports.synthetic=1;\n",
                      "lib/uploads.js.map": b'{"version":3,"mappings":""}',
                      "src/uploads.ts": b"export const synthetic=1;\n",
                      "case-mail-runtime/adapter.cjs": b"module.exports={};\n"}
        for name, value in self.files.items():
            file = self.root / "functions" / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
        release = self.root / "apps/admin/src/case-mail-release.json"
        release.parent.mkdir(parents=True)
        release.write_text('{"enabled":false}')
        self.key = b"\x01" * 32
        self.env = {"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "Hanabo0930/Lip-Knots-Crew",
                    "GITHUB_REF": "refs/heads/main", "GITHUB_REF_NAME": "main", "GITHUB_JOB": "promote",
                    "GITHUB_WORKFLOW_REF": e.WORKFLOW, "GITHUB_EVENT_NAME": "workflow_dispatch",
                    "GITHUB_RUN_ATTEMPT": "1", "GITHUB_RUN_ID": "123456", "GITHUB_SHA": SHA,
                    "LKC_PROJECT_ID": g.PROJECT, "LKC_REGION": g.REGION, "LKC_EVIDENCE_POLICY": "source-provenance",
                    "LKC_METADATA_ONLY": "false", "LKC_SOURCE_SHA": SHA, "LKC_OPERATION": "readiness",
                    "LKC_CONFIRMATION": "CHECK_LKC_STAGING_HOSTING_READINESS",
                    "LKC_SOURCE_ACQUISITION": "fixed-source-once",
                    "LKC_SOURCE_ACQUISITION_CONFIRMATION": e.FIXED_CONFIRMATION, "RUNNER_TEMP": str(self.root)}
        self.plan = {"schemaVersion": 1, "repository": self.env["GITHUB_REPOSITORY"], "workflowRef": e.WORKFLOW,
                     "runId": "123456", "runAttempt": 1, "sourceSha": SHA, "operation": "readiness",
                     "createdAt": "2026-10-31T00:01:00Z"}
        self.attempt = {**self.plan, "startedAt": "2026-10-31T00:02:00Z"}
        prefix = f"projects/{g.PROJECT}/locations/{g.REGION}"
        functions = {name: {"name": f"{prefix}/functions/{name}", "environment": "GEN_2", "state": "ACTIVE",
            "updateTime": "2026-10-31T00:00:00Z", "buildConfig": {"build": BUILD, "runtime": "nodejs22",
            "entryPoint": name, "sourceProvenance": {"resolvedStorageSource": {"bucket": g.BUCKET,
            "object": name + "/function-source.zip", "generation": str(123 + index)}}},
            "serviceConfig": {"service": f"{prefix}/services/{name.lower()}", "revision": name.lower() + "-00001-abc",
                              "allTrafficOnLatestRevision": True}} for index, name in enumerate(e.FUNCTIONS)}
        build = {"name": BUILD, "id": BUILD.rsplit("/", 1)[1], "projectId": g.PROJECT, "status": "SUCCESS",
                 "createTime": "2026-10-30T23:50:00Z", "startTime": "2026-10-30T23:51:00Z",
                 "finishTime": "2026-10-30T23:52:00Z", "sourceProvenance": {}, "results": {}}
        self.capture = {**self.plan, "method": e.FIXED_METHOD, "capturedAt": "2026-10-31T00:03:00Z",
                        "endsAt": "2026-10-31T00:04:00Z", "expiresAt": "2026-10-31T00:13:00Z",
                        "before": functions, "after": copy.deepcopy(functions), "builds": {BUILD: build},
                        "afterBuilds": {BUILD: copy.deepcopy(build)}, "objects": {}, "archives": {},
                        "requestCount": 10, "bytesDownloaded": 0}
        self.blobs = {name: archive(self.files) for name in e.FUNCTIONS}
        self.update_archives()
        self.save()
        self.addCleanup(patch.stopall)
        patch.object(socket, "create_connection", side_effect=AssertionError("NETWORK_FORBIDDEN")).start()
        patch.object(g.subprocess, "run", side_effect=AssertionError("SUBPROCESS_FORBIDDEN")).start()
        self.git = patch.object(g.subprocess, "check_output", return_value=SHA.encode()).start()

    def write(self, name, data):
        file = self.directory / name
        file.write_bytes(data)
        file.chmod(0o600)

    def update_archives(self):
        total = 0
        for name, blob in self.blobs.items():
            source = self.capture["before"][name]["buildConfig"]["sourceProvenance"]["resolvedStorageSource"]
            self.capture["objects"][name] = {"bucket": source["bucket"], "name": source["object"],
                "generation": source["generation"], "metageneration": "1", "storageClass": "STANDARD",
                "size": str(len(blob)), "crc32c": base64.b64encode(e._crc32c(blob)).decode(),
                "md5Hash": base64.b64encode(hashlib.md5(blob).digest()).decode()}
            self.capture["archives"][name] = {"file": e.FIXED_ARCHIVES[name], "size": len(blob),
                                               "sha256": hashlib.sha256(blob).hexdigest()}
            total += len(blob)
        self.capture["bytesDownloaded"] = total

    def save(self):
        self.write("collector.key", self.key)
        for name, value in [("plan", self.plan), ("attempt", self.attempt), ("capture", self.capture)]:
            raw = json.dumps(value, separators=(",", ":")).encode()
            self.write(name + ".json", raw)
            if name != "attempt":
                self.write(name + ".hmac", hmac.new(self.key, raw, hashlib.sha256).hexdigest().encode())
        for name, blob in self.blobs.items():
            self.write(e.FIXED_ARCHIVES[name], blob)

    def verify(self, *, now=NOW, env=None, preflight=False):
        return e.verify_fixed_capture(self.root, SHA, self.directory, g, env=self.env if env is None else env,
                                      now=now, preflight=preflight)

    def reject_capture(self, mutate, code=None):
        mutate(self.capture)
        self.save()
        with self.assertRaises((e.EvidenceError, g.ReadinessError)) as caught:
            self.verify()
        if code:
            self.assertIn(code, str(caught.exception))

    def test_signed_same_run_capture_matches_complete_build_without_retained_pin(self):
        result = self.verify()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["evidenceMethod"], e.FIXED_METHOD)
        self.assertTrue(result["deployedSourceVerified"])
        self.assertFalse(result["hostingPromotionAuthorized"])
        self.assertEqual(result["authenticatedStaffAcceptance"], "UNVERIFIED")
        self.assertEqual(result["verifiedFileCount"], len(self.files))
        self.assertNotIn("gs://", json.dumps(result))
        self.assertNotIn("LKC_APPROVED_SOURCE_EVIDENCE_SHA256", self.env)
        with self.assertRaisesRegex(e.EvidenceError, "VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED"):
            e.protected_context(SHA, self.env)

    def test_castagnoli_known_vector(self):
        self.assertEqual(base64.b64encode(e._crc32c(b"123456789")).decode(), "4waSgw==")

    def test_fixed_context_rejects_rerun_auto_event_wrong_scope_and_confirmation(self):
        for field, value in {"GITHUB_RUN_ATTEMPT": "2", "GITHUB_EVENT_NAME": "workflow_run",
            "GITHUB_JOB": "other", "GITHUB_SHA": "b" * 40, "GITHUB_REF": "refs/heads/other",
            "GITHUB_WORKFLOW_REF": "other", "LKC_PROJECT_ID": "other", "LKC_REGION": "global",
            "LKC_METADATA_ONLY": "true", "LKC_EVIDENCE_POLICY": "limited-staff-pilot",
            "LKC_SOURCE_ACQUISITION": "retained", "LKC_SOURCE_ACQUISITION_CONFIRMATION": "",
            "LKC_CONFIRMATION": "wrong"}.items():
            with self.subTest(field=field), self.assertRaises(e.EvidenceError):
                self.verify(env={**self.env, field: value})

    def test_promote_context_uses_existing_confirmation(self):
        self.plan["operation"] = self.attempt["operation"] = self.capture["operation"] = "promote"
        self.save()
        result = self.verify(env={**self.env, "LKC_OPERATION": "promote", "LKC_CONFIRMATION": "PROMOTE_LKC_STAGING_HOSTING"})
        self.assertEqual(result["status"], "PASS")

    def test_no_preflight_can_claim_source_verified_before_collection(self):
        with self.assertRaisesRegex(e.EvidenceError, "FIXED_SOURCE_PREFLIGHT_NOT_ACCEPTANCE"):
            self.verify(preflight=True)

    def test_capture_or_plan_cannot_select_its_own_trust(self):
        for name in ["capture.hmac", "plan.hmac"]:
            self.save()
            self.write(name, b"0" * 64)
            with self.subTest(name=name), self.assertRaisesRegex(e.EvidenceError, "SIGNATURE"):
                self.verify()
        self.save()
        self.write("collector.key", b"\x02" * 32)
        with self.assertRaisesRegex(e.EvidenceError, "SIGNATURE"):
            self.verify()

    def test_unsigned_tampering_duplicate_keys_or_verified_flags_stop(self):
        file = self.directory / "capture.json"
        raw = file.read_bytes()
        self.write("capture.json", raw.replace(SHA.encode(), b"b" * 40))
        with self.assertRaisesRegex(e.EvidenceError, "SIGNATURE"):
            self.verify()
        duplicate = raw.replace(b'{"schemaVersion":1', b'{"schemaVersion":1,"schemaVersion":1', 1)
        self.write("capture.json", duplicate)
        self.write("capture.hmac", hmac.new(self.key, duplicate, hashlib.sha256).hexdigest().encode())
        with self.assertRaisesRegex(e.EvidenceError, "DUPLICATE_KEY"):
            self.verify()
        self.reject_capture(lambda c: c.update(verified=True), "FIELDS")

    def test_capture_context_and_method_are_exact(self):
        baseline = copy.deepcopy(self.capture)
        for field, value in {"schemaVersion": True, "runAttempt": 2, "runId": "123457", "sourceSha": "b" * 40,
            "workflowRef": "other", "repository": "other/repo", "operation": "promote", "method": "retained"}.items():
            self.capture = copy.deepcopy(baseline)
            with self.subTest(field=field):
                self.reject_capture(lambda c: c.update({field: value}))

    def test_latch_required_and_bound_to_original_plan(self):
        (self.directory / "attempt.json").unlink()
        with self.assertRaisesRegex(e.EvidenceError, "PRIVATE_INVENTORY"):
            self.verify()
        self.attempt["runId"] = "999"
        self.save()
        with self.assertRaisesRegex(e.EvidenceError, "ATTEMPT"):
            self.verify()

    def test_temporal_order_expiry_future_and_old_guard_stop(self):
        baseline = copy.deepcopy(self.capture)
        for field, value in [("expiresAt", "2026-10-31T00:05:00Z"), ("expiresAt", "2026-10-31T00:13:01Z"),
                             ("capturedAt", "2026-10-31T00:02:00Z"), ("endsAt", "2026-10-31T00:06:00Z")]:
            self.capture = copy.deepcopy(baseline)
            with self.subTest(field=field, value=value):
                self.reject_capture(lambda c: c.update({field: value}), "STALE_OR_FUTURE")
        self.capture = baseline
        self.plan["createdAt"] = self.attempt["createdAt"] = self.capture["createdAt"] = "2026-10-30T23:00:00Z"
        self.save()
        with self.assertRaisesRegex(e.EvidenceError, "STALE_OR_FUTURE"):
            self.verify()

    def test_exact_ten_or_twelve_gets_and_byte_accounting(self):
        baseline = copy.deepcopy(self.capture)
        for value in [0, 9, 11, 13, True]:
            self.capture = copy.deepcopy(baseline)
            with self.subTest(value=value):
                self.reject_capture(lambda c: c.update(requestCount=value), "REQUEST_LIMIT")
        self.capture = copy.deepcopy(baseline)
        self.reject_capture(lambda c: c.update(bytesDownloaded=c["bytesDownloaded"] + 1), "TOTAL_TOO_LARGE")
        self.capture = baseline
        for phase in ["before", "after"]:
            self.capture[phase]["finalizeStagedUpload"]["buildConfig"]["build"] = SECOND
        for phase in ["builds", "afterBuilds"]:
            self.capture[phase][SECOND] = {**copy.deepcopy(self.capture[phase][BUILD]), "name": SECOND,
                                          "id": SECOND.rsplit("/", 1)[1]}
        self.capture["requestCount"] = 12
        self.save()
        self.assertEqual(self.verify()["status"], "PASS")

    def test_function_and_build_changes_or_secret_fields_stop(self):
        baseline = copy.deepcopy(self.capture)
        mutations = [lambda c: c["after"]["createUploadSession"]["serviceConfig"].update(revision="createuploadsession-00002-abc"),
                     lambda c: c["afterBuilds"][BUILD].update(status="FAILURE"),
                     lambda c: c["before"]["createUploadSession"]["serviceConfig"].update(environmentVariables={"secret": "DO_NOT_RECORD"})]
        for mutate in mutations:
            self.capture = copy.deepcopy(baseline)
            self.reject_capture(mutate)

    def test_present_build_provenance_and_digests_are_not_ignored(self):
        source = copy.deepcopy(self.capture["before"]["createUploadSession"]["buildConfig"]["sourceProvenance"]["resolvedStorageSource"])
        for phase in ["builds", "afterBuilds"]:
            self.capture[phase][BUILD]["sourceProvenance"] = {"resolvedStorageSource": source}
        self.save()
        with self.assertRaisesRegex(e.EvidenceError, "GENERATION_MISMATCH"):
            self.verify()
        for phase in ["builds", "afterBuilds"]:
            uri = f"gs://{source['bucket']}/{source['object']}#{source['generation']}"
            self.capture[phase][BUILD]["sourceProvenance"] = {"fileHashes": {uri: {"fileHash": [
                {"type": "SHA256", "value": base64.b64encode(hashlib.sha256(self.blobs['createUploadSession']).digest()).decode()}]}}}
        self.save()
        self.assertEqual(self.verify()["status"], "PASS")
        for phase in ["builds", "afterBuilds"]:
            self.capture[phase][BUILD]["sourceProvenance"]["fileHashes"][uri]["fileHash"][0]["value"] = base64.b64encode(b"\0" * 32).decode()
        self.save()
        with self.assertRaisesRegex(e.EvidenceError, "BUILD_HASH_MISMATCH"):
            self.verify()

    def test_object_metadata_scope_storage_conditions_and_checksum_stop(self):
        baseline = copy.deepcopy(self.capture)
        for field, value in [("bucket", "foreign"), ("name", "other.zip"), ("generation", "999"),
                             ("storageClass", "NEARLINE"), ("size", "99999999"), ("crc32c", "AAAAAA=="),
                             ("md5Hash", "AA=="), ("contentEncoding", "gzip"), ("customerEncryption", {})]:
            self.capture = copy.deepcopy(baseline)
            with self.subTest(field=field):
                self.reject_capture(lambda c: c["objects"]["createUploadSession"].update({field: value}))

    def test_modified_archive_raw_digest_fails_before_inventory(self):
        file = self.directory / e.FIXED_ARCHIVES["createUploadSession"]
        self.write(file.name, file.read_bytes() + b"SYNTHETIC_PRIVATE")
        with self.assertRaisesRegex(e.EvidenceError, "SIZE_REJECTED|BYTES_MISMATCH"):
            self.verify()

    def test_exact_archive_names_numeric_sizes_and_individual_size_limit(self):
        baseline = copy.deepcopy(self.capture)
        for field, value in [("file", "../createuploadsession.zip"), ("file", "other.zip"),
                             ("size", True), ("size", "1024"), ("sha256", "not-a-digest")]:
            self.capture = copy.deepcopy(baseline)
            with self.subTest(field=field):
                self.reject_capture(lambda c: c["archives"]["createUploadSession"].update({field: value}))
        self.capture = baseline
        self.save()
        file = self.directory / e.FIXED_ARCHIVES["createUploadSession"]
        with file.open("wb") as stream:
            stream.truncate(e.FIXED_ARCHIVE_MAX + 1)
        with self.assertRaisesRegex(e.EvidenceError, "SIZE_REJECTED"):
            self.verify()

    def test_same_size_semantic_code_change_cannot_match_current_build(self):
        modified = {**self.files, "lib/uploads.js": b"exports.synthetic=2;\n"}
        self.blobs["createUploadSession"] = archive(modified)
        self.update_archives()
        self.save()
        with self.assertRaisesRegex(g.ReadinessError, "DEPLOYED_SOURCE_MISMATCH"):
            self.verify()

    def test_signed_hidden_or_secret_zip_payload_is_still_rejected(self):
        baseline = self.blobs.copy()
        for blob in [archive({**self.files, ".env": b"SYNTHETIC_SECRET"}), self.blobs["createUploadSession"] + b"SYNTHETIC_SECRET"]:
            self.blobs = {**baseline, "createUploadSession": blob}
            self.update_archives()
            self.save()
            with self.assertRaises(g.ReadinessError) as caught:
                self.verify()
            self.assertNotIn("SYNTHETIC_SECRET", str(caught.exception))

    def test_private_modes_directory_links_hardlinks_and_unknown_files_rejected(self):
        file = self.directory / "capture.json"
        file.chmod(0o644)
        with self.assertRaisesRegex(e.EvidenceError, "PRIVATE_MODE"):
            self.verify()
        file.chmod(0o600)
        self.directory.chmod(0o755)
        with self.assertRaisesRegex(e.EvidenceError, "PRIVATE_MODE"):
            self.verify()
        self.directory.chmod(0o700)
        link = self.root / "hardlink"
        os.link(file, link)
        with self.assertRaisesRegex(e.EvidenceError, "SIZE_REJECTED"):
            self.verify()
        link.unlink()
        self.write("extra.json", b"{}")
        with self.assertRaisesRegex(e.EvidenceError, "PRIVATE_INVENTORY"):
            self.verify()

    def test_private_symlinks_do_not_enter_or_escape_the_fixed_folder(self):
        original = self.directory / "capture.json"
        outside = self.root / "outside.json"
        outside.write_bytes(original.read_bytes())
        original.unlink()
        original.symlink_to(outside)
        with self.assertRaises(e.EvidenceError):
            self.verify()
        original.unlink()
        self.save()
        alternate = self.root / "alternate"
        self.directory.rename(alternate)
        self.directory.symlink_to(alternate, target_is_directory=True)
        with self.assertRaisesRegex(e.EvidenceError, "LINK_REJECTED"):
            self.verify()

    def test_current_git_and_generated_source_map_must_still_match(self):
        self.git.return_value = ("b" * 40).encode()
        with self.assertRaisesRegex(e.EvidenceError, "SOURCE_SHA_MISMATCH"):
            self.verify()
        self.git.return_value = SHA.encode()
        (self.root / "functions/lib/uploads.js.map").write_text('{"version":4}')
        with self.assertRaisesRegex(g.ReadinessError, "DEPLOYED_SOURCE_MISMATCH"):
            self.verify()

    def test_fixed_route_checks_present_optional_packaging_without_requiring_it(self):
        values = {"tsconfig.json": b'{"compilerOptions":{"sourceMap":true}}',
                  "test/synthetic.test.ts": b"export const syntheticTest=true;\n"}
        for name, value in values.items():
            file = self.root / "functions" / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_bytes(value)
        # A packager may omit these non-runtime files completely.
        self.assertEqual(self.verify()["status"], "PASS")
        self.blobs = {name: archive({**self.files, **values}) for name in e.FUNCTIONS}
        self.update_archives()
        self.save()
        self.assertEqual(self.verify()["status"], "PASS")
        # Per-write revalidation hashes the current optional files as well.
        (self.root / "functions/test/synthetic.test.ts").write_text("export const syntheticTest=false;\n")
        with self.assertRaisesRegex(g.ReadinessError, "DEPLOYED_SOURCE_MISMATCH"):
            self.verify()

    def test_mutation_receipt_is_method_run_and_current_source_bound(self):
        result = self.verify()
        receipt = e.bind_fixed_acceptance(result, self.env, NOW)
        file = self.root / "api-readiness.json"
        file.write_text(json.dumps(receipt))
        later = NOW + dt.timedelta(seconds=1)
        proof = e.require_current_fixed_acceptance(file, self.verify(now=later), self.env, later)
        self.assertEqual(set(proof), {"status", "sourceSha", "evidenceMethod", "evidenceDigest", "runId", "runAttempt", "expiresAt"})
        self.assertEqual(proof["runId"], "123456")
        for field, value in [("evidenceMethod", "retained"), ("evidenceDigest", "0" * 64), ("sourceSha", "b" * 40),
                             ("checkedAt", "2026-10-31T00:06:00Z")]:
            file.write_text(json.dumps({**receipt, field: value}))
            with self.subTest(field=field), self.assertRaises(e.EvidenceError):
                e.require_current_fixed_acceptance(file, self.verify(now=later), self.env, later)

    def test_expiry_after_verification_cannot_be_renewed_by_binding_or_write(self):
        result = self.verify()
        with self.assertRaisesRegex(e.EvidenceError, "EXPIRED"):
            e.bind_fixed_acceptance(result, self.env, NOW + dt.timedelta(minutes=9))
        with self.assertRaisesRegex(e.EvidenceError, "STALE_OR_FUTURE"):
            self.verify(now=NOW + dt.timedelta(minutes=9))

    def test_cli_routes_fixed_receipt_and_mutation_guard_without_retained_pin(self):
        evidence_file = self.root / "api-readiness.json"
        argv = ["check", "--root", str(self.root), "--source-sha", SHA, "--evidence", str(evidence_file)]
        class FixtureDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, "argv", argv), \
             patch.object(g, "source_evidence_module", return_value=e), patch.object(e.dt, "datetime", FixtureDateTime):
            output = io.StringIO()
            with contextlib.redirect_stdout(output):
                self.assertEqual(g.main(), 0)
            self.assertIn("HOSTING_API_READINESS=PASS", output.getvalue())
            original = evidence_file.read_bytes()
            with patch.object(sys, "argv", argv + ["--mutation-guard"]), contextlib.redirect_stdout(io.StringIO()) as guard:
                self.assertEqual(g.main(), 0)
            self.assertEqual(len(json.loads(guard.getvalue())), 7)
            self.assertEqual(evidence_file.read_bytes(), original)
            self.env["LKC_SOURCE_ACQUISITION"] = "unknown"
            with patch.dict(os.environ, self.env, clear=True), contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(g.main(), 1)
            self.assertEqual(json.loads(evidence_file.read_text())["reason"], "SOURCE_ACQUISITION_REJECTED")

    def enable_config_diagnostic(self):
        self.env.update(LKC_SOURCE_PACKAGING_POLICY=e.CONFIG_POLICY,
                        LKC_SOURCE_ACQUISITION_CONFIRMATION=e.CONFIG_CONFIRMATION)
        for record in (self.plan, self.attempt, self.capture):
            record["packagingPolicy"] = e.CONFIG_POLICY
        self.capture["method"] = e.CONFIG_METHOD
        values = {key: "SYNTHETIC_PRIVATE_VALUE" for key in g.DEPLOYMENT_CONFIG_KEYS}
        values.update(APP_ENVIRONMENT="staging", EXPECTED_FIREBASE_PROJECT_ID=g.PROJECT,
                      LKC_NOTIFICATION_DELIVERY_MODE="paused", LKC_SHEET_WRITE_MODE="paused",
                      LKC_SUBMISSION_TRANSFER_MODE="paused")
        config = "".join(key + "=" + values[key] + "\n" for key in sorted(values)).encode()
        examples = {name: b"PUBLIC_EXAMPLE=synthetic\n" for name in g.CONFIG_EXAMPLES}
        for name, raw in examples.items():
            (self.root / "functions" / name).write_bytes(raw)
        for name in e.FUNCTIONS:
            for phase in ("before", "after"):
                self.capture[phase][name]["serviceConfig"]["environmentVariables"] = copy.deepcopy(values)
            self.blobs[name] = archive({**self.files, **examples, g.DEPLOYMENT_CONFIG: config})
        self.update_archives()
        self.save()

    def test_config_diagnostic_verified_code_never_authorizes_mutation(self):
        self.enable_config_diagnostic()
        result = self.verify()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["evidenceMethod"], e.CONFIG_METHOD)
        self.assertFalse(result["hostingPromotionAuthorized"])
        self.assertNotIn("SYNTHETIC_PRIVATE_VALUE", json.dumps(result))
        for forged in (result, {**result, "evidenceMethod": e.FIXED_METHOD}):
            with self.assertRaisesRegex(e.EvidenceError, "CONFIG_DIAGNOSTIC_NOT_MUTATION_AUTH"):
                e.bind_fixed_acceptance(forged, self.env, NOW)

    def test_config_diagnostic_rejects_wrong_mode_literal_or_policy_binding(self):
        self.enable_config_diagnostic()
        for changed in ({"LKC_OPERATION": "promote", "LKC_CONFIRMATION": "PROMOTE_LKC_STAGING_HOSTING"},
                        {"LKC_METADATA_ONLY": "true"},
                        {"LKC_SOURCE_ACQUISITION_CONFIRMATION": e.FIXED_CONFIRMATION},
                        {"LKC_SOURCE_PACKAGING_POLICY": "unknown"}):
            with self.subTest(changed=tuple(changed)), self.assertRaises(e.EvidenceError):
                self.verify(env={**self.env, **changed})
        self.capture["packagingPolicy"] = "strict"
        self.save()
        with self.assertRaisesRegex(e.EvidenceError, "FIXED_SOURCE_POLICY_REJECTED"):
            self.verify()

    def test_config_diagnostic_stops_if_official_settings_change(self):
        self.enable_config_diagnostic()
        self.capture["after"]["createUploadSession"]["serviceConfig"]["environmentVariables"]["DEFAULT_COMPANY_ID"] = "CHANGED_PRIVATE"
        self.save()
        with self.assertRaisesRegex(e.EvidenceError, "SOURCE_DEPLOYMENT_CHANGED_DURING_CAPTURE") as caught:
            self.verify()
        self.assertNotIn("CHANGED_PRIVATE", str(caught.exception))

    def test_cli_config_diagnostic_has_no_publication_receipt_and_guard_is_read_only(self):
        self.enable_config_diagnostic()
        evidence_file = self.root / "api-readiness.json"
        argv = ["check", "--root", str(self.root), "--source-sha", SHA, "--evidence", str(evidence_file)]
        class FixtureDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, "argv", argv), \
             patch.object(g, "source_evidence_module", return_value=e), \
             patch.object(e.dt, "datetime", FixtureDateTime), \
             patch.object(e, "bind_fixed_acceptance", side_effect=AssertionError("ACCEPTANCE_FORBIDDEN")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(g.main(), 0)
            report = json.loads(evidence_file.read_text())
            self.assertTrue(report["readinessOnly"])
            self.assertFalse(report["acceptanceEligible"])
            self.assertNotIn("acceptanceRun", report)
            original = evidence_file.read_bytes()
            with patch.object(sys, "argv", argv + ["--mutation-guard"]), contextlib.redirect_stdout(io.StringIO()) as guard:
                self.assertEqual(g.main(), 1)
            self.assertEqual(json.loads(guard.getvalue())["reason"], "CONFIG_DIAGNOSTIC_NOT_MUTATION_AUTH")
            self.assertEqual(evidence_file.read_bytes(), original)
            self.assertNotIn("SYNTHETIC_PRIVATE_VALUE", original.decode() + output.getvalue() + guard.getvalue())

    def test_cli_fixed_unknown_files_emit_bounded_hashes_and_never_accept_or_rewrite_receipt(self):
        names = [".env.SYNTHETIC_PRIVATE_NAME", "test/private-é.key"]
        names += [f"unlisted-{i:03d}.synthetic" for i in range(24)]
        self.blobs["createUploadSession"] = archive({**self.files,
            **{name: b"SYNTHETIC_PRIVATE_CONTENT" for name in names}})
        self.update_archives()
        self.save()
        evidence_file = self.root / "api-readiness.json"
        argv = ["check", "--root", str(self.root), "--source-sha", SHA, "--evidence", str(evidence_file)]
        class FixtureDateTime(dt.datetime):
            @classmethod
            def now(cls, tz=None):
                return NOW
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, "argv", argv), \
             patch.object(g, "source_evidence_module", return_value=e), \
             patch.object(e.dt, "datetime", FixtureDateTime), \
             patch.object(e, "bind_fixed_acceptance", side_effect=AssertionError("ACCEPTANCE_FORBIDDEN")):
            with contextlib.redirect_stdout(io.StringIO()) as output:
                self.assertEqual(g.main(), 1)
            report = json.loads(evidence_file.read_text())
            self.assertEqual(set(report), {"status", "reason", "diagnostics"})
            self.assertEqual((report["status"], report["reason"]), ("STOPPED", "ARCHIVE_UNEXPECTED_FILE"))
            self.assertEqual(report["diagnostics"], {
                "unexpectedFileCount": len(names),
                "pathSha256": sorted(hashlib.sha256(name.encode("utf-8")).hexdigest() for name in names)[:16],
                "truncated": True})
            original = evidence_file.read_bytes()
            with patch.object(sys, "argv", argv + ["--mutation-guard"]), \
                 contextlib.redirect_stdout(io.StringIO()) as guard:
                self.assertEqual(g.main(), 1)
            self.assertEqual(json.loads(guard.getvalue()), report)
            self.assertEqual(evidence_file.read_bytes(), original)
            retained = original.decode() + output.getvalue() + guard.getvalue()
            for private in names + ["SYNTHETIC_PRIVATE_CONTENT"]:
                self.assertNotIn(private, retained)

    def test_caller_supplied_diagnostics_are_rejected_before_inventory_and_not_reported(self):
        self.capture["diagnostics"] = {"status": "PASS", "pathSha256": ["SYNTHETIC_PRIVATE_VALUE"]}
        self.save()
        evidence_file = self.root / "api-readiness.json"
        argv = ["check", "--root", str(self.root), "--source-sha", SHA, "--evidence", str(evidence_file)]
        with patch.dict(os.environ, self.env, clear=True), patch.object(sys, "argv", argv), \
             patch.object(g, "source_evidence_module", return_value=e), \
             patch.object(e, "bind_fixed_acceptance", side_effect=AssertionError("ACCEPTANCE_FORBIDDEN")), \
             contextlib.redirect_stdout(io.StringIO()) as output:
            self.assertEqual(g.main(), 1)
        report = json.loads(evidence_file.read_text())
        self.assertEqual(set(report), {"status", "reason"})
        self.assertEqual(report["status"], "STOPPED")
        self.assertIn("FIELDS", report["reason"])
        self.assertNotIn("SYNTHETIC_PRIVATE_VALUE", evidence_file.read_text() + output.getvalue())


if __name__ == "__main__":
    unittest.main()
