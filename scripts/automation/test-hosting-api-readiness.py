import copy
import importlib.util
import io
import json
import pathlib
import stat
import struct
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
    "recruitment-mail-core.cjs",
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

    def test_strict_archive_exact_inventory_and_known_directories(self):
        expected = g.expected_files(self.root)
        blob = archive([("lib/", b""), ("src/", b""), ("case-mail-runtime/", b"")] + self.files)
        with patch.object(zipfile.ZipFile, "extract", side_effect=AssertionError("EXTRACTION_FORBIDDEN")), \
             patch.object(zipfile.ZipFile, "extractall", side_effect=AssertionError("EXTRACTION_FORBIDDEN")):
            self.assertIsNone(g.verify_archive(blob, expected, strict=True))

    def test_strict_source_maps_are_in_exact_current_build_inventory(self):
        map_file = self.root / "functions/lib/uploads.js.map"
        map_bytes = b'{"version":3,"sources":["../src/uploads.ts"],"mappings":""}'
        map_file.write_bytes(map_bytes)
        legacy = g.expected_files(self.root)
        expected = g.expected_files(self.root, strict=True)
        self.assertNotIn("lib/uploads.js.map", legacy)
        self.assertEqual(expected["lib/uploads.js.map"], g.digest(map_bytes))
        self.assertIsNone(g.verify_archive(archive(self.files + [("lib/uploads.js.map", map_bytes)]),
                                           expected, strict=True))
        for files, code in (
            (self.files, "DEPLOYED_PACKAGE_INCOMPLETE"),
            (self.files + [("lib/uploads.js.map", map_bytes + b"changed")], "DEPLOYED_SOURCE_MISMATCH"),
            (self.files + [("lib/uploads.js.map", map_bytes), ("lib/unknown.js.map", map_bytes)],
             "ARCHIVE_UNEXPECTED_FILE"),
        ):
            with self.subTest(code=code):
                with self.assertRaisesRegex(g.ReadinessError, code):
                    g.verify_archive(archive(files), expected, strict=True)

    def test_strict_rejects_secret_and_unexpected_files_without_exposing_contents(self):
        for name in (".env", ".env.synthetic", "credentials.json", "private.pem", "package-extra.json",
                     "README.md", "lib/extra.js", "src/extra.py", "case-mail-runtime/extra.wasm"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_UNEXPECTED_FILE") as caught:
                    g.verify_archive(archive(self.files + [(name, b"SYNTHETIC_PRIVATE_VALUE")]),
                                     g.expected_files(self.root), strict=True)
                self.assertNotIn(name, str(caught.exception))
                self.assertNotIn("SYNTHETIC_PRIVATE_VALUE", str(caught.exception))

    def test_strict_rejects_alias_paths_and_unknown_directories(self):
        for name in ("./lib/uploads.js", "lib//uploads.js", "lib/../uploads.js", "/lib/uploads.js",
                     "lib\\uploads.js", "lib:uploads.js", "lib/uploads.js\x01", "lib/./", "lib//"):
            with self.subTest(name=name):
                with self.assertRaisesRegex(g.ReadinessError, "UNSAFE_ARCHIVE_PATH"):
                    g.verify_archive(archive(self.files + [(name, b"")]), g.expected_files(self.root), strict=True)
        for name, value in (("unknown/", b""), ("lib/", b"nonempty")):
            with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_DIRECTORY_REJECTED"):
                g.verify_archive(archive(self.files + [(name, value)]), g.expected_files(self.root), strict=True)
        # ZipInfo truncates filename at NUL while retaining orig_filename.
        # Validate the original field too, rather than accepting its alias.
        nul_alias = self.blob.replace(b"package.json", b"package\x00json")
        with self.assertRaisesRegex(g.ReadinessError, "UNSAFE_ARCHIVE_PATH"):
            g.verify_archive(nul_alias, g.expected_files(self.root), strict=True)

    def test_strict_rejects_special_entries_even_when_the_contents_match(self):
        name, value = self.files[0]
        for kind in (stat.S_IFLNK, stat.S_IFIFO, stat.S_IFCHR, stat.S_IFBLK, stat.S_IFSOCK, stat.S_IFDIR):
            info = zipfile.ZipInfo(name)
            info.create_system = 3
            info.external_attr = (kind | 0o600) << 16
            with self.subTest(kind=kind):
                with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_SPECIAL_ENTRY_REJECTED"):
                    g.verify_archive(archive([(info, value)] + self.files[1:]),
                                     g.expected_files(self.root), strict=True)

    def test_strict_rejects_encryption_and_unsupported_compression(self):
        encrypted = bytearray(self.blob)
        # Set encryption on the first central-directory record. The validator
        # must refuse it before attempting to open or decrypt a member.
        central = encrypted.index(b"PK\x01\x02")
        flags = struct.unpack_from("<H", encrypted, central + 8)[0]
        struct.pack_into("<H", encrypted, central + 8, flags | 1)
        with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_ENCRYPTION_REJECTED"):
            g.verify_archive(encrypted, g.expected_files(self.root), strict=True)
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_BZIP2) as z:
            for name, value in self.files:
                z.writestr(name, value)
        with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_COMPRESSION_REJECTED"):
            g.verify_archive(stream.getvalue(), g.expected_files(self.root), strict=True)

    def test_strict_limits_entry_count_and_expansion_before_opening_members(self):
        with patch.object(g, "MAX_ARCHIVE_ENTRIES", len(self.files) - 1), \
             patch.object(zipfile.ZipFile, "open", side_effect=AssertionError("MEMBER_OPEN_FORBIDDEN")):
            with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_ENTRY_LIMIT"):
                g.verify_archive(self.blob, g.expected_files(self.root), strict=True)
        oversized = bytearray(self.blob)
        central = oversized.index(b"PK\x01\x02")
        struct.pack_into("<I", oversized, central + 24, g.MAX_ARCHIVE + 1)
        with patch.object(zipfile.ZipFile, "open", side_effect=AssertionError("MEMBER_OPEN_FORBIDDEN")):
            with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_TOO_LARGE"):
                g.verify_archive(oversized, g.expected_files(self.root), strict=True)
        # Each declaration fits the per-member limit, but their total exceeds
        # the independent expanded-size bound. Refuse before decompression.
        expanded = bytearray(self.blob)
        central = expanded.index(b"PK\x01\x02")
        while expanded[central:central + 4] == b"PK\x01\x02":
            struct.pack_into("<I", expanded, central + 24, g.MAX_ARCHIVE // len(self.files) + 1)
            name_size, extra_size, comment_size = struct.unpack_from("<HHH", expanded, central + 28)
            central += 46 + name_size + extra_size + comment_size
        with patch.object(zipfile.ZipFile, "open", side_effect=AssertionError("MEMBER_OPEN_FORBIDDEN")):
            with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_TOO_LARGE"):
                g.verify_archive(expanded, g.expected_files(self.root), strict=True)
        with patch.object(g, "MAX_FIXED_ARCHIVE", len(self.blob) - 1):
            with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_TOO_LARGE"):
                g.verify_archive(self.blob, g.expected_files(self.root), strict=True)

    def test_strict_rejects_corruption_duplicates_missing_or_changed_contents(self):
        with zipfile.ZipFile(io.BytesIO(self.blob)) as z:
            member = z.infolist()[0]
            offset = member.header_offset + 30 + len(member.filename.encode()) + len(member.extra)
        corrupted = bytearray(self.blob)
        corrupted[offset] ^= 1
        with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_UNREADABLE"):
            g.verify_archive(corrupted, g.expected_files(self.root), strict=True)
        for blob, code in (
            (archive(self.files + [self.files[0]]), "DUPLICATE_ARCHIVE_PATH"),
            (archive(self.files[:-1]), "DEPLOYED_PACKAGE_INCOMPLETE"),
            (archive([(name, value + b"changed" if name == self.files[0][0] else value)
                      for name, value in self.files]), "DEPLOYED_SOURCE_MISMATCH"),
        ):
            with self.subTest(code=code):
                with self.assertRaisesRegex(g.ReadinessError, code):
                    g.verify_archive(blob, g.expected_files(self.root), strict=True)

    def test_strict_accepts_classic_deflate_and_both_descriptor_forms(self):
        class Unseekable(io.BytesIO):
            def seek(self, *args):
                raise io.UnsupportedOperation("unseekable fixture")
        contents = b'{"main":"lib/index.js"}'
        expected = {"package.json": g.digest(contents)}
        for compression in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
            stream = Unseekable()
            with zipfile.ZipFile(stream, "w", compression=compression) as z:
                z.writestr("package.json", contents)
            signed = stream.getvalue()
            self.assertIsNone(g.verify_archive(signed, expected, strict=True))
            with zipfile.ZipFile(io.BytesIO(signed)) as z:
                entry = z.infolist()[0]
                self.assertTrue(entry.flag_bits & 8)
                descriptor = entry.header_offset + 30 + len(entry.filename) + entry.compress_size
            self.assertEqual(signed[descriptor:descriptor + 4], b"PK\x07\x08")
            unsigned = bytearray(signed[:descriptor] + signed[descriptor + 4:])
            central = struct.unpack_from("<I", signed, len(signed) - 6)[0]
            struct.pack_into("<I", unsigned, len(unsigned) - 6, central - 4)
            self.assertIsNone(g.verify_archive(unsigned, expected, strict=True))
            changed = bytearray(signed)
            changed[descriptor + 4] ^= 1
            with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_LAYOUT_REJECTED"):
                g.verify_archive(changed, expected, strict=True)

    def test_strict_rejects_unindexed_bytes_comments_and_special_flags(self):
        expected = g.expected_files(self.root)
        central = struct.unpack_from("<I", self.blob, len(self.blob) - 6)[0]
        gap = bytearray(self.blob[:central] + b"UNINDEXED_PRIVATE_PAYLOAD" + self.blob[central:])
        struct.pack_into("<I", gap, len(gap) - 6, central + len(b"UNINDEXED_PRIVATE_PAYLOAD"))
        commented = io.BytesIO()
        with zipfile.ZipFile(commented, "w") as z:
            for name, value in self.files:
                z.writestr(name, value)
            z.comment = b"PRIVATE_ARCHIVE_COMMENT"
        info = zipfile.ZipInfo(self.files[0][0])
        info.comment = b"PRIVATE_ENTRY_COMMENT"
        flags = bytearray(self.blob)
        struct.pack_into("<H", flags, central + 8, 0x0010)
        multi_disk = bytearray(self.blob)
        struct.pack_into("<H", multi_disk, len(multi_disk) - 18, 1)
        for blob in (b"PRIVATE_PREFIX" + self.blob, self.blob + b"PRIVATE_TRAILER", gap,
                     commented.getvalue(), archive([(info, self.files[0][1])] + self.files[1:]),
                     flags, multi_disk):
            with self.subTest(length=len(blob)):
                with self.assertRaises(g.ReadinessError) as caught:
                    g.verify_archive(blob, expected, strict=True)
                self.assertIn(str(caught.exception), {"ARCHIVE_LAYOUT_REJECTED", "ARCHIVE_UNREADABLE"})

    def test_strict_rejects_central_and_local_only_extra_fields_and_zip64(self):
        contents = b"synthetic package"
        expected = {"package.json": g.digest(contents)}
        base = archive([("package.json", contents)])
        central = struct.unpack_from("<I", base, len(base) - 6)[0]
        payload = 30 + len("package.json")
        extra = b"\xfe\xca\x00\x00"
        local_extra = bytearray(base[:payload] + extra + base[payload:])
        struct.pack_into("<H", local_extra, 28, len(extra))
        struct.pack_into("<I", local_extra, len(local_extra) - 6, central + len(extra))
        info = zipfile.ZipInfo("package.json")
        info.extra = extra
        zip64 = io.BytesIO()
        with zipfile.ZipFile(zip64, "w") as z:
            with z.open("package.json", "w", force_zip64=True) as member:
                member.write(contents)
        for blob in (local_extra, archive([(info, contents)]), zip64.getvalue()):
            with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_LAYOUT_REJECTED"):
                g.verify_archive(blob, expected, strict=True)

    def test_strict_rejects_junk_hidden_inside_declared_compressed_size(self):
        contents = b"synthetic package"
        expected = {"package.json": g.digest(contents)}
        stream = io.BytesIO()
        with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as z:
            z.writestr("package.json", contents)
        base = stream.getvalue()
        central = struct.unpack_from("<I", base, len(base) - 6)[0]
        hidden = b"PRIVATE_UNUSED_DEFLATE_BYTES"
        changed = bytearray(base[:central] + hidden + base[central:])
        compressed = struct.unpack_from("<I", base, 18)[0]
        struct.pack_into("<I", changed, 18, compressed + len(hidden))
        struct.pack_into("<I", changed, central + len(hidden) + 20, compressed + len(hidden))
        struct.pack_into("<I", changed, len(changed) - 6, central + len(hidden))
        # The generic ZIP reader ignores the hidden bytes and returns matching
        # contents. Strict acquisition must reject that unverified payload.
        with zipfile.ZipFile(io.BytesIO(changed)) as z:
            self.assertEqual(z.read("package.json"), contents)
        with self.assertRaisesRegex(g.ReadinessError, "ARCHIVE_UNREADABLE"):
            g.verify_archive(changed, expected, strict=True)

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
