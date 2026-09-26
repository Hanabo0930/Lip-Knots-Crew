"""実クラウドを呼ばず、worker更新の副作用境界と不確定結果を検証する。"""
import copy
import datetime as dt
import importlib.util
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import zipfile

spec = importlib.util.spec_from_file_location("migration", Path(__file__).with_name("migrate-staging-worker.py"))
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
TARGET = m.TARGETS[0]
SOURCE_SHA = "a" * 40
UPLOAD = {"bucket": "synthetic-upload", "object": "source.zip", "generation": "0"}

FIXED = {"bucket": m.SOURCE_BUCKET, "object": TARGET + "/function-source.zip", "generation": "123"}


def zip_source(files=None):
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as archive:
        for name, data in (files or {"lib/index.js": "synthetic", "package.json": "{}"}).items():
            entry = zipfile.ZipInfo()
            entry.filename = name
            archive.writestr(entry, data)
    return stream.getvalue()


def fixture():
    data = {"functions": {}, "services": {}, "iam": {}, "jobs": {}, "triggers": {},
            "subscriptions": {}, "projectIam": {"bindings": [], "etag": "synthetic"}}
    for name in m.TARGETS + m.SENTINELS:
        data["functions"][name] = {
            "name": f"{m.PREFIX}/functions/{name}", "state": "ACTIVE", "environment": "GEN_2",
            "buildConfig": {"runtime": "nodejs22", "entryPoint": name, "source": {"storageSource": {"object": "old"}}},
            "serviceConfig": {"service": f"{m.PREFIX}/services/{name.lower()}", "revision": name.lower() + "-old",
                              "environmentVariables": {"APP_ENVIRONMENT": "staging", "KEEP": "synthetic"}}}
    for name in m.TARGETS:
        data["services"][name] = {"name": f"{m.PREFIX}/services/{name.lower()}",
                                  "terminalCondition": {"state": "CONDITION_SUCCEEDED"}}
        revision = name.lower() + "-old"
        revision_path = f"{m.PREFIX}/services/{name.lower()}/revisions/{revision}"
        data["services"][name].update({"latestReadyRevision": revision_path,
                                      "latestCreatedRevision": revision_path,
                                      "trafficStatuses": [{"revision": revision, "percent": 100}]})
        data["iam"][name] = {"bindings": [], "etag": "synthetic"}
    for name in m.PAUSED_JOBS:
        full = f"{m.PREFIX}/jobs/firebase-schedule-{name}-{m.REGION}"
        data["jobs"][full] = {"name": full, "state": "PAUSED",
                             "httpTarget": {"uri": f"https://{m.REGION}-{m.PROJECT}.cloudfunctions.net/{name}"}}
    for name in m.EVENT_TARGETS:
        trigger = f"{m.PREFIX}/triggers/{name.lower()}-synthetic"
        sub = f"projects/{m.PROJECT}/subscriptions/{name.lower()}-synthetic"
        topic = f"projects/{m.PROJECT}/topics/{name.lower()}-synthetic"
        data["functions"][name]["eventTrigger"] = {"trigger": trigger, "retryPolicy": "RETRY_POLICY_DO_NOT_RETRY"}
        data["triggers"][name] = {"name": trigger, "uid": "synthetic", "destination": {
            "cloudFunction": f"{m.PREFIX}/functions/{name}"}, "transport": {"pubsub": {"subscription": sub, "topic": topic}}}
        data["subscriptions"][name] = {"name": sub, "topic": topic, "state": "ACTIVE",
                                        "pushConfig": {}, "messageRetentionDuration": "172800s"}
    return data


def clearance(before):
    now = dt.datetime.now(dt.timezone.utc)
    return {"schemaVersion": 1, "project": m.PROJECT, "region": m.REGION, "target": TARGET,
            "sourceSha": SOURCE_SHA, "issuedAt": (now - dt.timedelta(minutes=1)).isoformat(),
            "expiresAt": (now + dt.timedelta(minutes=30)).isoformat(), "reviewedBy": "synthetic-reviewer",
            "beforeSha256": m.snapshot_digest(before), "evidence": {key: "a" * 64 for key in (
                "arrivalControl", "oldExecutionCompletion", "externalEffectsCompletion",
                "retainedEventRecovery", "sourceBackup")},
            "confirmed": {key: True for key in ("newArrivalsHeld", "oldExecutionsFinished",
                                               "externalEffectsSettled", "retainedEventsRecoverable")}}


def after_snapshot(before):
    after = copy.deepcopy(before)
    fn = after["functions"][TARGET]
    fn["buildConfig"]["source"] = {"storageSource": FIXED}
    fn["buildConfig"]["sourceProvenance"] = {"resolvedStorageSource": FIXED}
    fn["serviceConfig"]["environmentVariables"].update(m.PAUSED_ENV)
    fn["serviceConfig"]["revision"] = TARGET.lower() + "-new"
    service = after["services"][TARGET]
    service.update({"latestReadyRevision": f"{m.PREFIX}/services/{TARGET.lower()}/revisions/{TARGET.lower()}-new",
                    "latestCreatedRevision": f"{m.PREFIX}/services/{TARGET.lower()}/revisions/{TARGET.lower()}-new",
                    "trafficStatuses": [{"revision": TARGET.lower() + "-new", "percent": 100}]})
    return after


class FakeApi:
    def __init__(self, patch_error=False):
        self.calls = []
        self.patch_error = patch_error

    def json(self, method, url, body=None):
        self.calls.append((method, url, body))
        if method == "POST":
            return {"uploadUrl": "https://storage.googleapis.com/synthetic", "storageSource": UPLOAD}
        if self.patch_error:
            raise ValueError("API_RESULT_UNKNOWN_READ_BEFORE_RETRY")
        return {"name": m.PREFIX + "/operations/synthetic", "done": True}

    def download_source(self, fn, target):
        return zip_source()

    def upload(self, url, data):
        self.calls.append(("PUT", url, data))


class MigrationTests(unittest.TestCase):
    def setUp(self):
        self.before = fixture()
        self.clearance = clearance(self.before)

    def run_migration(self, api, snapshots):
        with patch.object(m, "collect", side_effect=snapshots):
            m.migrate(api, self.before, TARGET, SOURCE_SHA, self.clearance, zip_source(), lambda value: None)

    def test_success_changes_only_source_and_paused_environment(self):
        api = FakeApi()
        self.run_migration(api, [self.before, after_snapshot(self.before)])
        self.assertEqual([method for method, _, _ in api.calls], ["POST", "PUT", "PATCH"])
        request = api.calls[-1]
        self.assertEqual(request[1], m.CF + f"{m.PREFIX}/functions/{TARGET}?updateMask={m.MASK}")
        self.assertEqual(set(request[2]), {"name", "buildConfig", "serviceConfig"})
        self.assertEqual(request[2]["serviceConfig"]["environmentVariables"],
                         {"APP_ENVIRONMENT": "staging", "KEEP": "synthetic", **m.PAUSED_ENV})

    def test_no_authorization_from_missing_clearance(self):
        api = FakeApi()
        self.clearance = {}
        with self.assertRaises(ValueError):
            self.run_migration(api, [])
        self.assertEqual(api.calls, [])

    def test_unconfirmed_or_missing_private_evidence_stops_before_cloud(self):
        for category in ("confirmed", "evidence"):
            for key in list(self.clearance[category]):
                evidence = clearance(self.before)
                evidence[category][key] = False if category == "confirmed" else ""
                with self.subTest(key=key), self.assertRaises(ValueError):
                    m.validate_clearance(evidence, TARGET, SOURCE_SHA)

    def test_scope_and_expiry_not_reusable(self):
        variants = [{"target": "retrySafeSheetWrites"}, {"sourceSha": "b" * 40}, {"project": "production"},
                    {"region": "us-central1"}, {"expiresAt": "2020-01-01T00:00:00+00:00"},
                    {"issuedAt": "2020-01-01T00:00:00"}, {"reviewedBy": ""}]
        for change in variants:
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.validate_clearance({**self.clearance, **change}, TARGET, SOURCE_SHA)

    def test_live_push_and_24_hour_retention_each_reject(self):
        for change in ({"pushConfig": {"pushEndpoint": "https://synthetic.invalid"}},
                       {"messageRetentionDuration": "86400s"}, {"state": "RESOURCE_ERROR"}):
            altered = copy.deepcopy(self.before)
            altered["subscriptions"][TARGET].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.validate_snapshot(altered, TARGET)

    def test_enabled_scheduler_and_wrong_destination_reject(self):
        key = next(iter(self.before["jobs"]))
        for change in ({"state": "ENABLED"}, {"httpTarget": {"uri": "https://synthetic.invalid"}}):
            altered = copy.deepcopy(self.before)
            altered["jobs"][key].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                m.validate_snapshot(altered, TARGET)

    def test_unauthenticated_invocation_rejected(self):
        for variant in ("disabled", "public"):
            altered = copy.deepcopy(self.before)
            if variant == "disabled":
                altered["services"][TARGET]["invokerIamDisabled"] = True
            else:
                altered["iam"][TARGET]["bindings"] = [{"role": "roles/run.invoker", "members": ["allUsers"]}]
            with self.subTest(variant=variant), self.assertRaises(ValueError):
                m.validate_snapshot(altered, TARGET)

    def test_configuration_changed_during_upload_never_patches(self):
        changed = copy.deepcopy(self.before)
        changed["functions"][TARGET]["serviceConfig"]["revision"] = "unexpected"
        api = FakeApi()
        with self.assertRaisesRegex(ValueError, "BEFORE_CHANGED_DURING_UPLOAD"):
            self.run_migration(api, [changed])
        self.assertFalse(any(method == "PATCH" for method, _, _ in api.calls))

    def test_unknown_patch_result_never_retries_or_rolls_back(self):
        api = FakeApi(patch_error=True)
        with self.assertRaisesRegex(ValueError, "API_RESULT_UNKNOWN"):
            self.run_migration(api, [self.before])
        self.assertEqual(sum(method == "PATCH" for method, _, _ in api.calls), 1)

    def test_post_checks_detect_every_protected_resource_change(self):
        for key in ("jobs", "triggers", "subscriptions", "iam", "projectIam"):
            after = after_snapshot(self.before)
            after[key]["unexpected"] = {}
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.verify_after(self.before, after, TARGET)

    def test_completed_retry_recovery_never_changes(self):
        after = after_snapshot(self.before)
        after["functions"]["retrySafeSheetWrites"]["serviceConfig"]["revision"] = "changed"
        with self.assertRaisesRegex(ValueError, "UNRELATED_FUNCTION_CHANGED"):
            m.verify_after(self.before, after, TARGET)

    def test_runtime_config_or_traffic_change_rejected(self):
        for kind in ("timeout", "traffic", "source"):
            after = after_snapshot(self.before)
            if kind == "timeout":
                after["functions"][TARGET]["serviceConfig"]["timeoutSeconds"] = 999
            elif kind == "traffic":
                after["services"][TARGET]["trafficStatuses"][0]["percent"] = 50
            else:
                after["functions"][TARGET]["buildConfig"]["sourceProvenance"] = {"resolvedStorageSource": {**FIXED, "object": "wrong"}}
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                m.verify_after(self.before, after, TARGET)

    def test_unready_during_upload_never_patches_even_with_same_digest(self):
        for change in ({"terminalCondition": {"state": "CONDITION_FAILED"}}, {"reconciling": True}):
            changed = copy.deepcopy(self.before)
            changed["services"][TARGET].update(change)
            self.assertEqual(m.snapshot_digest(changed), self.clearance["beforeSha256"])
            api = FakeApi()
            with self.subTest(change=change), self.assertRaises(ValueError):
                self.run_migration(api, [changed])
            self.assertFalse(any(method == "PATCH" for method, _, _ in api.calls))

    def test_run_and_function_revision_must_match_before_upload(self):
        for key, value in (("latestReadyRevision", "wrong"), ("latestCreatedRevision", "wrong"),
                           ("trafficStatuses", [{"revision": "wrong", "percent": 100}])):
            changed = copy.deepcopy(self.before)
            changed["services"][TARGET][key] = value
            with self.subTest(key=key), self.assertRaises(ValueError):
                m.validate_snapshot(changed, TARGET)

    def test_unrelated_run_configuration_must_remain_unchanged(self):
        after = after_snapshot(self.before)
        after["services"][m.TARGETS[1]]["ingress"] = "INGRESS_TRAFFIC_ALL"
        with self.assertRaisesRegex(ValueError, "UNRELATED_RUN_SERVICE_CHANGED"):
            m.verify_after(self.before, after, TARGET)

    def test_different_missing_or_extra_source_file_cannot_pass_verification(self):
        for files in ({"lib/index.js": "changed", "package.json": "{}"}, {"package.json": "{}"},
                      {"lib/index.js": "synthetic", "package.json": "{}", "extra.js": "unexpected"}):
            api = FakeApi()
            with patch.object(api, "download_source", return_value=zip_source(files)), self.subTest(files=files), self.assertRaisesRegex(ValueError, "DEPLOYED_SOURCE_MISMATCH"):
                self.run_migration(api, [self.before, after_snapshot(self.before)])
            self.assertEqual(sum(method == "PATCH" for method, _, _ in api.calls), 1)

    def test_source_download_requires_staging_target_and_fixed_generation(self):
        api = m.Api()
        for change in ({"bucket": "other"}, {"object": "other/function-source.zip"},
                       {"generation": "0"}, {"generation": ""}):
            fn = after_snapshot(self.before)["functions"][TARGET]
            fn["buildConfig"]["sourceProvenance"] = {"resolvedStorageSource": {**FIXED, **change}}
            with self.subTest(change=change), patch.object(api, "headers", side_effect=AssertionError("no auth")), self.assertRaises(ValueError):
                api.download_source(fn, TARGET)
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.read.return_value = zip_source()
        with patch.object(api, "headers", return_value={}), patch.object(m.urllib.request, "urlopen", return_value=response) as send:
            api.download_source(after_snapshot(self.before)["functions"][TARGET], TARGET)
        self.assertTrue(send.call_args.args[0].full_url.endswith("processSafeSheetWrite%2Ffunction-source.zip?alt=media&generation=123"))

    def test_source_manifest_rejects_unsafe_or_duplicate_paths(self):
        for name in ("../escape", "/absolute", "a/../escape", "a\\escape", "C:escape"):
            with self.subTest(name=name), self.assertRaises(ValueError):
                m.archive_manifest(zip_source({name: "unexpected"}))
        stream = io.BytesIO()
        import warnings
        with warnings.catch_warnings(), zipfile.ZipFile(stream, "w") as archive:
            warnings.simplefilter("ignore", UserWarning)
            archive.writestr("same", "first")
            archive.writestr("same", "second")
        with self.assertRaisesRegex(ValueError, "SOURCE_ARCHIVE_DUPLICATE"):
            m.archive_manifest(stream.getvalue())

    def test_transport_never_accepts_iam_scheduler_or_trigger_mutations(self):
        api = m.Api()
        for url in (m.SCHED + m.PREFIX + "/jobs/synthetic:resume",
                    m.RUN + m.PREFIX + "/services/synthetic:setIamPolicy",
                    m.EVENT + m.PREFIX + "/triggers/synthetic",
                    m.CF + m.PREFIX + "/functions/retrySafeSheetWrites"):
            with self.subTest(url=url), patch.object(api, "headers", side_effect=AssertionError("no auth")), self.assertRaises(ValueError):
                api.json("POST", url, {})

    def test_signed_upload_does_not_send_bearer(self):
        api = m.Api()
        response = unittest.mock.MagicMock()
        response.__enter__.return_value.status = 200
        with patch.object(m.urllib.request, "urlopen", return_value=response) as send:
            api.upload("https://storage.googleapis.com/synthetic?signature=private", b"zip")
        headers = dict(send.call_args.args[0].header_items())
        self.assertNotIn("Authorization", headers)
        with self.assertRaises(ValueError):
            api.upload("https://synthetic.invalid/source", b"zip")

    def test_archive_excludes_env_and_dependencies(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            for name in ("package.json", "tsconfig.json", "src/index.ts", "lib/index.js",
                         "case-mail-runtime/provider.cjs", ".env.staging", "node_modules/private.txt"):
                file = root / name
                file.parent.mkdir(parents=True, exist_ok=True)
                file.write_text("synthetic")
            archive = zipfile.ZipFile(io.BytesIO(m.archive_source(root)))
            self.assertEqual(set(archive.namelist()), {"package.json", "tsconfig.json", "src/index.ts",
                                                     "lib/index.js", "case-mail-runtime/provider.cjs"})


if __name__ == "__main__":
    unittest.main()
