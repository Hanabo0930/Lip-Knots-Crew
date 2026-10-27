import copy
import importlib.util
import io
import json
import pathlib
import tempfile
import unittest
import warnings
import zipfile
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("readiness", pathlib.Path(__file__).with_name("check-hosting-api-readiness.py"))
g = importlib.util.module_from_spec(spec)
spec.loader.exec_module(g)
SHA = "a" * 40
CASE_LIST_ASSETS = (
    "case-list-projection.cjs", "case-list-monthly-compact.cjs",
    "case-list-monthly-controller.cjs", "case-list-monthly-adapter.cjs",
)

def metadata(function):
    prefix = f"projects/{g.PROJECT}/locations/{g.REGION}"
    return {"name": f"{prefix}/functions/{function}", "environment": "GEN_2", "state": "ACTIVE",
            "buildConfig": {"entryPoint": function, "runtime": "nodejs22", "sourceProvenance": {"resolvedStorageSource":
                {"bucket": g.BUCKET, "object": "synthetic/source.zip", "generation": "123"}}},
            "serviceConfig": {"service": f"{prefix}/services/{function.lower()}", "revision": function.lower() + "-00001-abc", "allTrafficOnLatestRevision": True}}

def archive(files):
    stream = io.BytesIO()
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        with zipfile.ZipFile(stream, "w") as z:
            for key, value in files:
                z.writestr(key, value)
    return stream.getvalue()

class ReadinessTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        files = {"apps/admin/src/case-mail-release.json": '{"enabled":false}',
                 "functions/package.json": '{"main":"lib/index.js"}',
                 "functions/lib/index.js": "exports.createUploadSession = 1;\n",
                 "functions/lib/uploads.js": "exports.version = 2;\n",
                 "functions/src/uploads.ts": "export const version = 2;\n",
                 "functions/case-mail-runtime/adapter.cjs": "module.exports = {};\n"}
        files.update({f"functions/src/{name}": "module.exports = {synthetic: true};\n" for name in CASE_LIST_ASSETS})
        for name, value in files.items():
            p = self.root / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(value, "utf-8")
        self.files = [(p.relative_to(self.root / "functions").as_posix(), p.read_bytes()) for p in (self.root / "functions").rglob("*") if p.is_file()]
        self.blob = archive(self.files)

    def run_check(self, describe=metadata, blob=None, sha=SHA):
        with patch.object(g.subprocess, "check_output", return_value=SHA.encode()):
            return g.check(self.root, sha, describe, lambda _: self.blob if blob is None else blob)

    def test_matching_package_and_revisions(self):
        result = self.run_check()
        self.assertEqual(result["status"], "PASS")
        self.assertEqual(len(result["functions"]), 2)
        self.assertNotIn("source", json.dumps(result["functions"]))

    def test_case_list_source_cjs_assets_are_in_exact_inventory(self):
        expected = g.expected_files(self.root)
        for name in CASE_LIST_ASSETS:
            with self.subTest(asset=name):
                self.assertIn(f"src/{name}", expected)
        self.assertEqual(self.run_check()["verifiedFileCount"], len(self.files))

    def test_changed_case_list_source_cjs_asset_stops(self):
        for name in CASE_LIST_ASSETS:
            with self.subTest(asset=name):
                changed = [(k, v + b"// changed\n" if k == f"src/{name}" else v) for k, v in self.files]
                with self.assertRaisesRegex(g.ReadinessError, "DEPLOYED_SOURCE_MISMATCH"):
                    self.run_check(blob=archive(changed))

    def test_missing_case_list_source_cjs_asset_stops(self):
        for name in CASE_LIST_ASSETS:
            with self.subTest(asset=name):
                missing = [(k, v) for k, v in self.files if k != f"src/{name}"]
                with self.assertRaisesRegex(g.ReadinessError, "DEPLOYED_CODE_INVENTORY_MISMATCH"):
                    self.run_check(blob=archive(missing))

    def test_extra_source_cjs_asset_stops_even_with_matching_contents(self):
        known = next(v for k, v in self.files if k == f"src/{CASE_LIST_ASSETS[0]}")
        with self.assertRaisesRegex(g.ReadinessError, "DEPLOYED_CODE_INVENTORY_MISMATCH"):
            self.run_check(blob=archive(self.files + [("src/unexpected.cjs", known)]))

    def test_invalid_metadata_stops_before_download(self):
        variants = [
            ("state", "DEPLOYING"), ("environment", "GEN_1"), ("name", "other"),
            ("buildConfig.entryPoint", "other"), ("buildConfig.runtime", "nodejs20"),
            ("serviceConfig.service", "projects/other/locations/asia-northeast1/services/createuploadsession"),
            ("serviceConfig.revision", "other-00001-abc"), ("serviceConfig.allTrafficOnLatestRevision", False),
            ("serviceConfig.allTrafficOnLatestRevision", "true"),
            ("buildConfig.sourceProvenance.resolvedStorageSource.bucket", "untrusted"),
            ("buildConfig.sourceProvenance.resolvedStorageSource.generation", ""),
            ("buildConfig.sourceProvenance.resolvedStorageSource.object", "../secret.zip"),
        ]
        for key, value in variants:
            with self.subTest(key=key, value=value):
                def invalid(function):
                    d = metadata(function); node = d
                    parts = key.split(".")
                    for part in parts[:-1]: node = node[part]
                    node[parts[-1]] = value
                    return d
                with self.assertRaises(g.ReadinessError):
                    self.run_check(invalid)

    def test_missing_metadata_or_read_permission_stops(self):
        for reader in (lambda _: None, lambda _: {}, lambda _: (_ for _ in ()).throw(g.ReadinessError("READ_ONLY_METADATA_FAILED"))):
            with self.assertRaises(g.ReadinessError): self.run_check(reader)

    def test_wrong_or_missing_source(self):
        variants = [self.files + [("lib/injected.js", b"unexpected")], self.files[:-1], [(k, b"old-code" if k == "lib/uploads.js" else v) for k, v in self.files]]
        for files in variants:
            with self.assertRaises(g.ReadinessError): self.run_check(blob=archive(files))

    def test_zip_not_extracted_and_unsafe_paths_rejected(self):
        for extra in (("../outside", b"no"), ("/absolute", b"no"), ("lib\\uploads.js", b"no")):
            with self.assertRaises(g.ReadinessError): self.run_check(blob=archive(self.files + [extra]))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore")
            with self.assertRaises(g.ReadinessError): self.run_check(blob=archive(self.files + [self.files[0]]))
        with self.assertRaises(g.ReadinessError): self.run_check(blob=b"not-a-zip")

    def test_line_endings_and_ignored_environment_contents(self):
        # 環境ファイルの存在/内容を検査結果へ露出させない。
        blob = archive([(k, v.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")) for k, v in self.files] + [(".env.synthetic", b"DO_NOT_READ=synthetic")])
        self.assertEqual(self.run_check(blob=blob)["status"], "PASS")

    def test_deployment_changes_during_read_stops(self):
        calls = 0
        def changing(function):
            nonlocal calls
            calls += 1
            d = metadata(function)
            if calls > 2: d["serviceConfig"]["revision"] = function.lower() + "-00002-def"
            return d
        with self.assertRaisesRegex(g.ReadinessError, "DEPLOYMENT_CHANGED"): self.run_check(changing)

    def test_sha_and_unapproved_mail_release_stops(self):
        for sha in ("", "main", "b" * 40):
            with self.assertRaises(g.ReadinessError): self.run_check(sha=sha)
        (self.root / "apps/admin/src/case-mail-release.json").write_text('{"enabled":true}')
        with self.assertRaisesRegex(g.ReadinessError, "CASE_MAIL_RELEASE_NOT_APPROVED"): self.run_check()

    def test_false_like_release_values_rejected(self):
        for value in (0, None, "false", True):
            (self.root / "apps/admin/src/case-mail-release.json").write_text(json.dumps({"enabled": value}))
            with self.assertRaises(g.ReadinessError): self.run_check()

    def test_no_build_cannot_pass(self):
        (self.root / "functions/lib/uploads.js").unlink()
        with self.assertRaises(g.ReadinessError): self.run_check()

    def test_no_default_network_reader(self):
        with patch.object(g.subprocess, "run", side_effect=AssertionError("NETWORK_FORBIDDEN")):
            with self.assertRaisesRegex(g.ReadinessError, "VERIFIED_EVIDENCE_INPUT_REQUIRED"):
                g.check(self.root, SHA)

    def test_workflow_gate_precedes_live_mutations(self):
        workflow = (ROOT / ".github/workflows/staging-hosting-promote.yml").read_text("utf-8")
        check = workflow.index("      - name: Verify deployed upload APIs")
        self.assertLess(check, workflow.index("      - name: Back up both current live channels"))
        self.assertLess(check, workflow.index("      - name: Promote the already-tested versions"))
        next_step = workflow.find("\n      - name:", check)
        self.assertNotEqual(next_step, -1)
        step = workflow[check:next_step]
        self.assertNotIn("continue-on-error", step)
        # Default source-provenance promote/readiness still require deployed
        # source verification. Limited policy has an independent evidence gate;
        # metadata-only collects observations without source reads or promotion.
        # Restore uses immutable successful-promotion evidence instead.
        conditions = [line.strip() for line in step.splitlines() if line.strip().startswith("if:")]
        strict_condition = "if: env.LKC_OPERATION != 'restore' && env.LKC_METADATA_ONLY != 'true' && env.LKC_EVIDENCE_POLICY == 'source-provenance'"
        self.assertEqual(conditions, [strict_condition])
        # Evaluate the exact validated condition without eval.
        for operation, metadata_only, expected in (
            ("readiness", "false", True), ("promote", "false", True), ("restore", "false", False),
            ("readiness", "true", False), ("promote", "true", False), ("restore", "true", False),
        ):
            for policy in ("source-provenance", "limited-staff-pilot"):
                with self.subTest(operation=operation, metadata_only=metadata_only, policy=policy):
                    gate_runs = operation != "restore" and metadata_only != "true" and policy == "source-provenance"
                    self.assertEqual(gate_runs, expected and policy == "source-provenance")
        fee_start = workflow.index("      - name: Stop source verification unless a no-fee path is established")
        fee_end = workflow.index("\n      - name:", fee_start)
        fee_step = workflow[fee_start:fee_end]
        self.assertIn(strict_condition, fee_step)
        self.assertIn("--no-fee-source-guard", fee_step)
        self.assertLess(fee_start, workflow.index("      - name: Authenticate with the short-lived staging identity"))
        self.assertIn('npm run build -w @lkc/functions', step)
        self.assertIn('--source-sha "$LKC_SOURCE_SHA"', step)
        for name in ("Back up both current live channels", "Promote the already-tested versions"):
            start = workflow.index("      - name: " + name)
            end = workflow.find("\n      - name:", start)
            self.assertNotEqual(end, -1)
            mutation = workflow[start:end]
            conditions = [line.strip() for line in mutation.splitlines() if line.strip().startswith("if:")]
            self.assertEqual(conditions, ["if: env.LKC_OPERATION == 'promote'"])

def load_tests(loader, tests, pattern):
    spec = importlib.util.spec_from_file_location("source_evidence_tests", pathlib.Path(__file__).with_name("test-hosting-source-evidence.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    tests.addTests(loader.loadTestsFromModule(module))
    return tests


if __name__ == "__main__":
    unittest.main()
