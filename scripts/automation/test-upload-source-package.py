import importlib.util
import json
import pathlib
import subprocess
import tempfile
import unittest
import zipfile

spec = importlib.util.spec_from_file_location("source_package", pathlib.Path(__file__).with_name("package-upload-source-refresh.py"))
package = importlib.util.module_from_spec(spec)
spec.loader.exec_module(package)


class UploadPackageTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name) / "repository"
        self.output = pathlib.Path(self.temp.name) / "private"
        self.output.mkdir(mode=0o700)
        files = {"apps/admin/src/case-mail-release.json": '{"enabled":false}',
                 "functions/package.json": '{"main":"lib/index.js"}',
                 "functions/lib/index.js": "exports.test = true;\n", "functions/lib/uploads.js": "exports.paused = true;\n",
                 "functions/lib/uploads.js.map": '{"version":3}', "functions/src/uploads.ts": "export const paused = true;\n",
                 "functions/case-mail-runtime/core.cjs": "module.exports = {};\n", "functions/tsconfig.json": "{}",
                 "functions/.env.lip-knots-crew-staging": "UNTRUSTED_PRIVATE_FILE=must-not-be-packaged\n",
                 "functions/.env.example": "EXAMPLE=must-not-be-packaged\n", "functions/test/sample.ts": "export {};\n"}
        for name, body in files.items():
            file = self.root / name
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text(body)
        self.env = {key: "synthetic-private-" + key for key in package.readiness.DEPLOYMENT_CONFIG_KEYS}
        self.env.update(APP_ENVIRONMENT="staging", EXPECTED_FIREBASE_PROJECT_ID=package.readiness.PROJECT,
                        LKC_NOTIFICATION_DELIVERY_MODE="paused", LKC_SHEET_WRITE_MODE="paused", LKC_SUBMISSION_TRANSFER_MODE="paused")
        self.environments = {name: dict(self.env) for name in package.readiness.REQUIRED}

    def test_strict_current_inventory_and_maps_but_no_dotenv_or_private_values(self):
        self.environments["finalizeStagedUpload"]["ADMIN_EMAILS"] = "different@example.invalid"
        result = package.build_packages(self.root, self.environments, self.output)
        self.assertEqual(set(result), set(package.readiness.REQUIRED))
        for info in result.values():
            file = pathlib.Path(info["path"])
            self.assertEqual(file.stat().st_mode & 0o777, 0o600)
            with zipfile.ZipFile(file) as archive:
                self.assertIsNone(archive.testzip())
                self.assertIn("lib/uploads.js.map", archive.namelist())
                self.assertIn("test/sample.ts", archive.namelist())
                self.assertFalse(any(name.startswith(".env") for name in archive.namelist()))
                self.assertNotIn(b"synthetic-private-", b"".join(archive.read(name) for name in archive.namelist()))
        self.assertEqual(result["createUploadSession"]["sha256"], result["finalizeStagedUpload"]["sha256"])

    def test_readiness_gate_accepts_the_exact_packaged_bytes_without_a_policy_exception(self):
        result = package.build_packages(self.root, self.environments, self.output)
        expected = package.readiness.expected_files(self.root, strict=True)
        optional = package.readiness.expected_packaging_files(self.root)
        for info in result.values():
            package.readiness.verify_archive(pathlib.Path(info["path"]).read_bytes(), expected, strict=True, optional=optional)

    def test_missing_current_runtime_output_stops(self):
        (self.root / "functions/lib/uploads.js").unlink()
        with self.assertRaisesRegex(package.readiness.ReadinessError, "LOCAL_BUILD_REQUIRED"):
            package.build_packages(self.root, self.environments, self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_a_source_link_is_never_followed(self):
        file = self.root / "functions/src/uploads.ts"
        file.unlink()
        file.symlink_to(self.root / "functions/lib/uploads.js")
        with self.assertRaisesRegex(package.readiness.ReadinessError, "LINK_REJECTED"):
            package.build_packages(self.root, self.environments, self.output)

    def test_config_is_validated_privately_before_any_source_file_is_written(self):
        self.environments["createUploadSession"]["LKC_SHEET_WRITE_MODE"] = "active"
        with self.assertRaisesRegex(package.readiness.ReadinessError, "CONFIG_PAUSE_STATE_REJECTED"):
            package.build_packages(self.root, self.environments, self.output)
        self.assertEqual(list(self.output.iterdir()), [])

    def test_existing_output_is_not_overwritten(self):
        file = self.output / "createUploadSession.zip"
        file.write_bytes(b"preserve-existing-file")
        with self.assertRaises(FileExistsError):
            package.build_packages(self.root, self.environments, self.output)
        self.assertEqual(file.read_bytes(), b"preserve-existing-file")

    def test_cli_rejects_private_input_without_echoing_values(self):
        self.environments["createUploadSession"]["ADMIN_EMAILS"] = 'synthetic-private-invalid"value'
        result = subprocess.run(["python3", str(pathlib.Path(package.__file__)), "--root", str(self.root), "--output", str(self.output)],
                                input=json.dumps(self.environments), capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertIn("CONFIG_FILE_FORMAT_REJECTED", result.stderr)
        self.assertNotIn("synthetic-private", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
