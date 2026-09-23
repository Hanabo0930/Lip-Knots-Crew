"""実クラウドへ接続せず、移行前診断の欠落・読取失敗・不整合を検証する。"""
import copy
import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("inspect-sheet-worker-migration.py"))
migration = importlib.util.module_from_spec(spec)
spec.loader.exec_module(migration)


def fixture():
    resources = {}
    for name in migration.FUNCTIONS:
        revision = name.lower() + "-00002-synthetic"
        resources[f"function:{name}"] = {"status": "found", "data": {
            "name": f"{migration.PREFIX}/functions/{name}", "state": "ACTIVE",
            "serviceConfig": {"service": f"{migration.PREFIX}/services/{name.lower()}", "revision": revision,
                              "environmentVariables": {"LKC_SHEET_WRITE_MODE": "paused"}}}}
        resources[f"service:{name}"] = {"status": "found", "data": {
            "metadata": {"name": name.lower()}, "status": {"latestReadyRevisionName": revision,
            "latestCreatedRevisionName": revision, "conditions": [{"type": "Ready", "status": "True"}],
            "traffic": [{"revisionName": revision, "percent": 100}]}}}
    resources["schedulers"] = {"status": "found", "data": [{"name": f"{migration.PREFIX}/jobs/{migration.JOB}",
        "state": "PAUSED", "schedule": "every 5 minutes", "timeZone": "Asia/Tokyo"}]}
    snapshot = {"schemaVersion": 1, "project": migration.PROJECT, "region": migration.REGION, "resources": resources}
    policy = {"projectId": migration.PROJECT, "region": migration.REGION, "allowedFunctions": list(migration.FUNCTIONS)}
    return snapshot, policy


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.snapshot, self.policy = fixture()
        self.function = self.snapshot["resources"]["function:processSafeSheetWrite"]["data"]
        self.service = self.snapshot["resources"]["service:processSafeSheetWrite"]["data"]

    def codes(self):
        return {x["code"] for x in migration.assess(self.snapshot, self.policy)["findings"]}

    def test_consistent_metadata_never_authorizes_deployment_or_drain(self):
        result = migration.assess(self.snapshot, self.policy)
        self.assertTrue(result["metadataChecksPassed"])
        self.assertFalse(result["deploymentAuthorized"])
        self.assertIn("OLD_REVISION_EXECUTION_DRAIN", result["unverified"])
        self.assertIn("DEPLOYED_SOURCE_IDENTITY", result["unverified"])

    def test_failed_retry_missing_service_and_job_are_independent(self):
        name = "retrySafeSheetWrites"
        self.snapshot["resources"][f"function:{name}"]["data"] = {"name": f"{migration.PREFIX}/functions/{name}", "state": "FAILED"}
        self.snapshot["resources"][f"service:{name}"] = {"status": "not_found"}
        self.snapshot["resources"]["schedulers"]["data"] = []
        self.policy["allowedFunctions"] = []
        self.assertTrue({"FUNCTION_NOT_ACTIVE", "RESOURCE_MISSING", "RETRY_SCHEDULER_MISSING", "FUNCTION_OUTSIDE_ALLOWLIST"} <= self.codes())

    def test_read_error_is_not_missing_resource(self):
        self.snapshot["resources"]["schedulers"] = {"status": "error", "reason": "READ_REJECTED"}
        self.assertIn("OBSERVATION_FAILED", self.codes())
        self.assertNotIn("RETRY_SCHEDULER_MISSING", self.codes())

    def test_absent_observation_is_not_cloud_absence(self):
        del self.snapshot["resources"]["schedulers"]
        self.assertEqual(self.codes(), {"OBSERVATION_MISSING"})

    def test_empty_or_malformed_function_does_not_pass(self):
        for value in ({}, [], None):
            with self.subTest(value=value):
                self.snapshot["resources"]["function:processSafeSheetWrite"]["data"] = value
                self.assertIn("OBSERVATION_INVALID", self.codes())

    def test_wrong_scope_rejected(self):
        for key, value in (("project", "unrelated-project"), ("region", "us-central1"), ("schemaVersion", 2)):
            snapshot = copy.deepcopy(self.snapshot)
            snapshot[key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                migration.assess(snapshot, self.policy)

    def test_invalid_policy_rejected(self):
        for patch in ({"projectId": "unrelated-project"}, {"allowedFunctions": "all"}, {"allowedFunctions": [None]}):
            with self.subTest(patch=patch), self.assertRaises(ValueError):
                migration.assess(self.snapshot, {**self.policy, **patch})

    def test_cross_project_resource_identity_rejected(self):
        self.function["name"] = "projects/unrelated/locations/asia-northeast1/functions/processSafeSheetWrite"
        self.assertIn("RESOURCE_IDENTITY_MISMATCH", self.codes())

    def test_wrong_function_service_binding_rejected(self):
        self.function["serviceConfig"]["service"] = f"{migration.PREFIX}/services/unrelated"
        self.assertIn("FUNCTION_SERVICE_MISMATCH", self.codes())

    def test_unset_or_active_or_unknown_mode_not_explicit_pause(self):
        for mode in (None, "active", "", "PAUSED", False):
            self.function["serviceConfig"]["environmentVariables"] = {"LKC_SHEET_WRITE_MODE": mode}
            with self.subTest(mode=mode):
                self.assertIn("EXPLICIT_PAUSE_NOT_OBSERVED", self.codes())

    def test_timeout_alone_never_proves_drain(self):
        self.function["serviceConfig"]["timeoutSeconds"] = 60
        self.snapshot["waitedSeconds"] = 600
        result = migration.assess(self.snapshot, self.policy)
        self.assertFalse(result["deploymentAuthorized"])
        self.assertIn("OLD_REVISION_EXECUTION_DRAIN", result["unverified"])

    def test_ready_false_or_unknown_rejected(self):
        for conditions in ([], None, [{"type": "Ready", "status": "False"}], [{"type": "Ready", "status": "Unknown"}]):
            self.service["status"]["conditions"] = conditions
            with self.subTest(conditions=conditions):
                self.assertIn("SERVICE_NOT_READY", self.codes())

    def test_function_run_revision_disagreement(self):
        self.service["status"]["latestCreatedRevisionName"] = "processsafesheetwrite-00003-pending"
        self.assertIn("FUNCTION_SERVICE_REVISION_MISMATCH", self.codes())

    def test_old_revision_traffic_and_tag_do_not_pass(self):
        current = self.service["status"]["traffic"][0]
        for traffic in ([{**current, "percent": 99}], [current, {"revisionName": "old", "percent": 0, "tag": "old"}], [{**current, "tag": "old"}], [{**current, "percent": True}], []):
            self.service["status"]["traffic"] = traffic
            with self.subTest(traffic=traffic):
                self.assertIn("TRAFFIC_NOT_SINGLE_VERIFIED_REVISION", self.codes())

    def test_enabled_scheduler_rejected(self):
        self.snapshot["resources"]["schedulers"]["data"][0]["state"] = "ENABLED"
        self.assertIn("RETRY_SCHEDULER_NOT_PAUSED", self.codes())

    def test_scheduler_configuration_mismatch(self):
        self.snapshot["resources"]["schedulers"]["data"][0]["timeZone"] = "UTC"
        self.assertIn("RETRY_SCHEDULER_CONFIG_MISMATCH", self.codes())

    def test_cron_representation_supported(self):
        self.snapshot["resources"]["schedulers"]["data"][0]["schedule"] = "*/5 * * * *"
        self.assertEqual(self.codes(), set())

    def test_other_schedulers_reported_without_claiming_pause(self):
        self.snapshot["resources"]["schedulers"]["data"].append({"name": f"{migration.PREFIX}/jobs/other-job", "state": "ENABLED"})
        result = migration.assess(self.snapshot, self.policy)
        self.assertEqual(result["otherSchedulers"], [{"name": "other-job", "state": "ENABLED"}])
        self.assertIn("OTHER_WRITERS_AND_LEGACY_NOTIFICATIONS", result["unverified"])

    def test_bad_or_duplicate_scheduler_inventory(self):
        job = self.snapshot["resources"]["schedulers"]["data"][0]
        for jobs in ([job, job], [None], [{"name": "projects/wrong/jobs/name"}]):
            self.snapshot["resources"]["schedulers"]["data"] = jobs
            with self.subTest(jobs=jobs):
                self.assertIn("SCHEDULER_INVENTORY_INVALID", self.codes())

    def test_reader_does_not_leak_diagnostic_text(self):
        for error, status in ((b"NOT_FOUND: synthetic", "not_found"), (b"PERMISSION_DENIED secret-value", "error"), (b"UNAUTHENTICATED NOT_FOUND secret-value", "error")):
            result = migration.read_one("synthetic", [], lambda *a, **k: SimpleNamespace(returncode=1, stdout=b"", stderr=error))
            self.assertEqual(result["status"], status)
            self.assertNotIn("secret-value", json.dumps(result))

    def test_gcloud_run_missing_service_requires_exact_command_and_identity(self):
        args = ["run", "services", "describe", "retrysafesheetwrites"]
        message = b"ERROR: (gcloud.run.services.describe) Cannot find service [retrysafesheetwrites]\r\n"
        def response(*a, **k):
            return SimpleNamespace(returncode=1, stdout=b"", stderr=message)
        self.assertEqual(migration.read_one("synthetic", args, response)["status"], "not_found")
        self.assertEqual(migration.read_one("synthetic", ["functions", "describe", "retrySafeSheetWrites"], response)["status"], "error")
        self.assertEqual(migration.read_one("synthetic", ["run", "services", "describe", "different"], response)["status"], "error")

    def test_invalid_json_and_timeout_are_errors(self):
        result = migration.read_one("synthetic", [], lambda *a, **k: SimpleNamespace(returncode=0, stdout=b"not-json", stderr=b""))
        self.assertEqual(result["status"], "error")
        def timeout(*args, **kwargs):
            raise subprocess.TimeoutExpired("synthetic", 60)
        self.assertEqual(migration.read_one("synthetic", [], timeout)["status"], "error")

    def test_offline_inspection_never_runs_cloud_reader(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "snapshot.json"
            evidence = Path(directory) / "evidence"
            source.write_text(json.dumps(self.snapshot), encoding="utf-8")
            with patch.object(migration, "collect", side_effect=AssertionError("cloud must not run")) as reader, patch("builtins.print"):
                code = migration.main(["--snapshot", str(source), "--evidence", str(evidence)])
            reader.assert_not_called()
            self.assertIn(code, (0, 2))
            self.assertFalse(json.loads((evidence / "assessment.json").read_text())["deploymentAuthorized"])

    def test_existing_evidence_rejected_before_cloud_read(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.object(migration, "collect", side_effect=AssertionError("cloud must not run")) as reader, patch.object(migration.sys, "stderr"):
                with self.assertRaises(SystemExit) as error:
                    migration.main(["--collect", "--evidence", directory])
            self.assertEqual(error.exception.code, 2)
            reader.assert_not_called()

    def test_commands_are_fixed_metadata_reads(self):
        commands = migration.read_commands()
        self.assertEqual(len(commands), 5)
        for args in commands.values():
            self.assertIn(f"--project={migration.PROJECT}", args)
            self.assertTrue("describe" in args or "list" in args)
            self.assertFalse(set(args) & {"deploy", "update", "create", "delete", "pause", "resume"})
            if args[0] == "run":
                self.assertEqual(args[1:3], ["services", "describe"])
            projection = next(x for x in args if x.startswith("--format="))
            self.assertNotIn("secret", projection.lower())
            if "environmentVariables" in projection:
                self.assertIn("environmentVariables.LKC_SHEET_WRITE_MODE", projection)


if __name__ == "__main__":
    unittest.main()
