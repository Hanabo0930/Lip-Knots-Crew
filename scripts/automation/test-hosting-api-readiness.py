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

    def test_gcloud_resolution_supports_windows_and_missing_cli(self):
        for executable in ("C:/SDK path/gcloud.cmd", "/usr/bin/gcloud"):
            with patch.object(g.shutil, "which", return_value=executable):
                self.assertEqual(g.gcloud_command("functions", "describe", "createUploadSession"),
                                 [executable, "functions", "describe", "createUploadSession"])
        with patch.object(g.shutil, "which", return_value=None):
            with self.assertRaisesRegex(g.ReadinessError, "GCLOUD_NOT_FOUND"):
                g.gcloud_command("version")

    def test_workflow_gate_precedes_live_mutations(self):
        workflow = (ROOT / ".github/workflows/staging-hosting-promote.yml").read_text("utf-8")
        check = workflow.index("      - name: Verify deployed upload APIs")
        self.assertLess(check, workflow.index("      - name: Back up both current live channels"))
        self.assertLess(check, workflow.index("      - name: Promote the already-tested versions"))
        step = workflow[check:workflow.index("      - name: Back up both current live channels")]
        self.assertNotIn("continue-on-error", step)
        self.assertNotIn("if:", step)
        self.assertIn('npm run build -w @lkc/functions', step)
        self.assertIn('--source-sha "$LKC_SOURCE_SHA"', step)

if __name__ == "__main__":
    unittest.main()
