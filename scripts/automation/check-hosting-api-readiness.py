"""Hosting昇格前の読取専用検査。実行失敗・情報不足は必ず停止する。"""
import argparse
import hashlib
import importlib.util
import io
import json
import os
import pathlib
import re
import stat
import struct
import subprocess
import sys
import zipfile
import zlib

PROJECT = "lip-knots-crew-staging"
REGION = "asia-northeast1"
BUCKET = "gcf-v2-sources-740154137290-asia-northeast1"
REQUIRED = ("createUploadSession", "finalizeStagedUpload")
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_FIXED_ARCHIVE = 10 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 10000
MAX_ARCHIVE_DIAGNOSTIC_PATHS = 16

class ReadinessError(Exception):
    pass

class UnexpectedArchiveFilesError(ReadinessError):
    def __init__(self, names):
        # Untrusted names may themselves contain secrets. Retain only bounded
        # hashes, never the names or file contents, in failure evidence.
        super().__init__("ARCHIVE_UNEXPECTED_FILE")
        hashes = sorted({hashlib.sha256(name.encode("utf-8")).hexdigest() for name in names})
        self.unexpected_file_count = len(names)
        self.path_sha256 = tuple(hashes[:MAX_ARCHIVE_DIAGNOSTIC_PATHS])
        self.truncated = len(hashes) > MAX_ARCHIVE_DIAGNOSTIC_PATHS

    @property
    def diagnostics(self):
        return {"unexpectedFileCount": self.unexpected_file_count,
                "pathSha256": list(self.path_sha256), "truncated": self.truncated}

def require(condition, code):
    if not condition:
        raise ReadinessError(code)

def digest(data):
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()

def expected_files(root, *, strict=False):
    release = json.loads((root / "apps/admin/src/case-mail-release.json").read_text("utf-8"))
    # 受信7 APIの確認・有効化は別工程。フラグだけの開放を許可しない。
    require(isinstance(release, dict) and set(release) == {"enabled"} and release["enabled"] is False, "CASE_MAIL_RELEASE_NOT_APPROVED")
    base = root / "functions"
    files = [base / "package.json"]
    if (base / "package-lock.json").is_file():
        files.append(base / "package-lock.json")
    for folder, suffixes in (("lib", {".js"}), ("src", {".ts", ".cjs"}), ("case-mail-runtime", {".js", ".cjs", ".json"})):
        found = [p for p in (base / folder).rglob("*") if p.is_file() and p.suffix in suffixes]
        require(bool(found), "LOCAL_PACKAGE_INCOMPLETE")
        files.extend(found)
    if strict:
        # functions/tsconfig.json emits JS source maps into lib. Treat these
        # actual build outputs as content to verify, never unchecked extras.
        files.extend(p for p in (base / "lib").rglob("*.js.map") if p.is_file())
    require((base / "lib/index.js").is_file() and (base / "lib/uploads.js").is_file(), "LOCAL_BUILD_REQUIRED")
    require(json.loads((base / "package.json").read_text("utf-8")).get("main") == "lib/index.js", "LOCAL_ENTRY_UNEXPECTED")
    return {p.relative_to(base).as_posix(): digest(p.read_bytes()) for p in files}

def expected_packaging_files(root):
    """Exact current non-runtime files a Firebase source ZIP may include.

    These names are optional, never a prefix allowance: a present archive member
    must match its current repository bytes. Runtime inventory remains required.
    The current package has root TS configs and TypeScript tests only; env/key
    files and other formats are deliberately not candidates.
    """
    base = pathlib.Path(root) / "functions"
    candidates = [*base.glob("tsconfig*.json"), *(base / "test").rglob("*.ts")]
    result = {}
    for file in candidates:
        name = file.relative_to(base).as_posix()
        require(bool(re.fullmatch(r"tsconfig(?:[.][A-Za-z0-9_-]+)*[.]json|test/[A-Za-z0-9_./-]+[.]ts", name))
                and all(part not in {"", ".", ".."} for part in name.split("/")),
                "LOCAL_PACKAGING_PATH_REJECTED")
        for ancestor in (file, *file.parents):
            require(not stat.S_ISLNK(ancestor.lstat().st_mode), "LOCAL_PACKAGING_LINK_REJECTED")
        before = file.lstat()
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and 0 < before.st_size <= 2 * 1024 * 1024,
                "LOCAL_PACKAGING_FILE_REJECTED")
        fd = os.open(file, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
        with os.fdopen(fd, "rb") as stream:
            opened = os.fstat(stream.fileno())
            require((before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
                    == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns), "LOCAL_PACKAGING_CHANGED")
            data = stream.read(2 * 1024 * 1024 + 1)
            after = os.fstat(stream.fileno())
        require(len(data) == before.st_size and (opened.st_size, opened.st_mtime_ns) == (after.st_size, after.st_mtime_ns),
                "LOCAL_PACKAGING_CHANGED")
        result[name] = digest(data)
    return result

def identify(document, function):
    require(function in REQUIRED, "FUNCTION_OUT_OF_SCOPE")
    require(isinstance(document, dict), "FUNCTION_METADATA_INVALID")
    prefix = f"projects/{PROJECT}/locations/{REGION}"
    require(document.get("name") == f"{prefix}/functions/{function}", "FUNCTION_IDENTITY_MISMATCH")
    require(document.get("environment") == "GEN_2" and document.get("state") == "ACTIVE", "FUNCTION_NOT_ACTIVE")
    build, service = document.get("buildConfig", {}), document.get("serviceConfig", {})
    require(isinstance(build, dict) and isinstance(service, dict), "FUNCTION_METADATA_INVALID")
    require(build.get("entryPoint") == function and build.get("runtime") == "nodejs22", "FUNCTION_BUILD_MISMATCH")
    require(service.get("service") == f"{prefix}/services/{function.lower()}", "SERVICE_IDENTITY_MISMATCH")
    revision = service.get("revision", "")
    require(bool(re.fullmatch(re.escape(function.lower()) + r"-[0-9]+-[a-z0-9]+", revision)), "REVISION_UNVERIFIED")
    require(service.get("allTrafficOnLatestRevision") is True, "TRAFFIC_NOT_ON_VERIFIED_REVISION")
    provenance = build.get("sourceProvenance")
    require(isinstance(provenance, dict), "SOURCE_PROVENANCE_REQUIRED")
    source = provenance.get("resolvedStorageSource")
    require(isinstance(source, dict), "SOURCE_PROVENANCE_REQUIRED")
    require(source.get("bucket") == BUCKET, "SOURCE_BUCKET_UNVERIFIED")
    obj, generation = source.get("object", ""), str(source.get("generation", ""))
    require(bool(re.fullmatch(r"[A-Za-z0-9_./-]+\.zip", obj)) and ".." not in obj.split("/") and not obj.startswith("/"), "SOURCE_OBJECT_UNVERIFIED")
    require(bool(re.fullmatch(r"[1-9][0-9]*", generation)), "SOURCE_GENERATION_REQUIRED")
    return {"function": function, "revision": revision, "source": f"gs://{BUCKET}/{obj}#{generation}"}

def strict_zip_layout(blob, entries):
    """Account for every raw byte of a conservative classic ZIP container."""
    require(len(blob) >= 22, "ARCHIVE_LAYOUT_REJECTED")
    end = struct.unpack_from("<4s4H2IH", blob, len(blob) - 22)
    signature, disk, central_disk, disk_count, count, size, start, comment = end
    require(signature == b"PK\x05\x06" and disk == central_disk == 0
            and disk_count == count == len(entries) and count < 0xffff
            and start < 0xffffffff and size < 0xffffffff and comment == 0
            and start + size == len(blob) - 22, "ARCHIVE_LAYOUT_REJECTED")
    cursor, records = start, []
    for entry in entries:
        require(cursor + 46 <= start + size, "ARCHIVE_LAYOUT_REJECTED")
        record = struct.unpack_from("<4s6H3I5H2I", blob, cursor)
        (signature, _made, needed, flags, method, mtime, mdate, crc, compressed,
         expanded, name_len, extra_len, comment_len, entry_disk, _attrs, _external, offset) = record
        require(signature == b"PK\x01\x02" and needed in {10, 20}
                and flags & ~0x0808 == 0 and method in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED}
                and extra_len == comment_len == entry_disk == 0
                and compressed < 0xffffffff and expanded < 0xffffffff and offset < 0xffffffff
                and cursor + 46 + name_len <= start + size, "ARCHIVE_LAYOUT_REJECTED")
        name = blob[cursor + 46:cursor + 46 + name_len]
        require(name == entry.orig_filename.encode("utf-8" if flags & 0x0800 else "cp437")
                and (flags, method, crc, compressed, expanded, offset)
                == (entry.flag_bits, entry.compress_type, entry.CRC, entry.compress_size,
                    entry.file_size, entry.header_offset), "ARCHIVE_LAYOUT_REJECTED")
        records.append((offset, entry, name, needed, mtime, mdate))
        cursor += 46 + name_len
    require(cursor == start + size, "ARCHIVE_LAYOUT_REJECTED")
    cursor, payloads = 0, {}
    records.sort(key=lambda item: item[0])
    for index, (offset, entry, name, needed, mtime, mdate) in enumerate(records):
        next_offset = records[index + 1][0] if index + 1 < len(records) else start
        require(offset == cursor and offset + 30 <= start, "ARCHIVE_LAYOUT_REJECTED")
        local = struct.unpack_from("<4s5H3I2H", blob, offset)
        (signature, version, flags, method, local_time, local_date, crc, compressed,
         expanded, name_len, extra_len) = local
        require(signature == b"PK\x03\x04" and (version, flags, method, local_time, local_date)
                == (needed, entry.flag_bits, entry.compress_type, mtime, mdate)
                and extra_len == 0 and name_len == len(name)
                and offset + 30 + name_len <= start
                and blob[offset + 30:offset + 30 + name_len] == name, "ARCHIVE_LAYOUT_REJECTED")
        expected_sizes = (entry.CRC, entry.compress_size, entry.file_size)
        require((crc, compressed, expanded) == expected_sizes or (
                    flags & 8 and (crc, compressed, expanded) == (0, 0, 0)),
                "ARCHIVE_LAYOUT_REJECTED")
        data_start = offset + 30 + name_len
        data_end = data_start + entry.compress_size
        require(data_start <= data_end <= next_offset <= start, "ARCHIVE_LAYOUT_REJECTED")
        if flags & 8:
            descriptor = blob[data_end:next_offset]
            require(len(descriptor) in {12, 16}, "ARCHIVE_LAYOUT_REJECTED")
            if len(descriptor) == 16:
                require(descriptor[:4] == b"PK\x07\x08", "ARCHIVE_LAYOUT_REJECTED")
                descriptor = descriptor[4:]
            require(struct.unpack("<3I", descriptor) == expected_sizes, "ARCHIVE_LAYOUT_REJECTED")
        else:
            require(data_end == next_offset, "ARCHIVE_LAYOUT_REJECTED")
        payloads[entry.filename] = (data_start, data_end)
        cursor = next_offset
    require(cursor == start, "ARCHIVE_LAYOUT_REJECTED")
    return payloads

def strict_zip_data(blob, entry, bounds):
    compressed = blob[bounds[0]:bounds[1]]
    if entry.compress_type == zipfile.ZIP_DEFLATED:
        decoder = zlib.decompressobj(-15)
        data = decoder.decompress(compressed, MAX_ARCHIVE + 1)
        require(len(data) <= MAX_ARCHIVE, "ARCHIVE_TOO_LARGE")
        require(decoder.eof and not decoder.unused_data and not decoder.unconsumed_tail,
                "ARCHIVE_UNREADABLE")
    else:
        data = compressed
    require(len(data) == entry.file_size and zlib.crc32(data) == entry.CRC, "ARCHIVE_UNREADABLE")
    return data

def verify_archive(blob, expected, *, strict=False, optional=None):
    # The existing retained-source route keeps its historical policy. Fresh
    # authenticated acquisition additionally rejects every unapproved file,
    # even when it would not participate in the legacy code inventory.
    require(len(blob) <= (MAX_FIXED_ARCHIVE if strict else MAX_ARCHIVE), "ARCHIVE_TOO_LARGE")
    optional = {} if optional is None or not strict else optional
    if strict:
        require(type(optional) is dict and not set(expected) & set(optional), "ARCHIVE_OPTIONAL_INVENTORY_REJECTED")
    allowed = {**expected, **optional} if strict else expected
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            entries = archive.infolist()
            names = [i.filename for i in entries]
            if strict:
                require(0 < len(entries) <= MAX_ARCHIVE_ENTRIES, "ARCHIVE_ENTRY_LIMIT")
                directories = {parent.as_posix() + "/" for name in allowed
                               for parent in pathlib.PurePosixPath(name).parents
                               if parent.as_posix() != "."}
                for entry in entries:
                    name = entry.filename
                    parts = name.rstrip("/").split("/")
                    require(name == entry.orig_filename and bool(name)
                            and not name.startswith("/") and "\\" not in name and ":" not in name
                            and not re.search(r"[\x00-\x1f\x7f]", name)
                            and all(part not in {"", ".", ".."} for part in parts)
                            and not name.endswith("//"), "UNSAFE_ARCHIVE_PATH")
                    mode = stat.S_IFMT(entry.external_attr >> 16)
                    require(mode in {0, stat.S_IFDIR if entry.is_dir() else stat.S_IFREG},
                            "ARCHIVE_SPECIAL_ENTRY_REJECTED")
                    require(not entry.flag_bits & 1, "ARCHIVE_ENCRYPTION_REJECTED")
                    require(entry.compress_type in {zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED},
                            "ARCHIVE_COMPRESSION_REJECTED")
                    require(0 <= entry.file_size <= MAX_ARCHIVE, "ARCHIVE_TOO_LARGE")
                    if entry.is_dir():
                        require(name in directories and entry.file_size == 0,
                                "ARCHIVE_DIRECTORY_REJECTED")
                    else:
                        if name not in allowed:
                            raise UnexpectedArchiveFilesError([
                                item.filename for item in entries
                                if not item.is_dir() and item.filename not in allowed])
                require(set(expected) <= {entry.filename for entry in entries if not entry.is_dir()},
                        "DEPLOYED_PACKAGE_INCOMPLETE")
            require(len(names) == len(set(names)), "DUPLICATE_ARCHIVE_PATH")
            require(all(not n.startswith("/") and "\\" not in n and ".." not in n.split("/") for n in names), "UNSAFE_ARCHIVE_PATH")
            require(sum(i.file_size for i in entries) <= MAX_ARCHIVE, "ARCHIVE_TOO_LARGE")
            if strict:
                payloads = strict_zip_layout(blob, entries)
                for entry in entries:
                    if entry.is_dir():
                        require(strict_zip_data(blob, entry, payloads[entry.filename]) == b"",
                                "ARCHIVE_DIRECTORY_REJECTED")
            suffixes = (".js", ".cjs", ".ts", ".json", ".js.map") if strict else (".js", ".cjs", ".ts", ".json")
            relevant = {n for n in names if n.startswith(("lib/", "src/", "case-mail-runtime/")) and n.endswith(suffixes)}
            require(relevant == {n for n in expected if n.startswith(("lib/", "src/", "case-mail-runtime/"))}, "DEPLOYED_CODE_INVENTORY_MISMATCH")
            checked = {**expected, **{name: value for name, value in optional.items() if name in names}} if strict else expected
            for name, sha in checked.items():
                require(name in names, "DEPLOYED_PACKAGE_INCOMPLETE")
                if strict:
                    # No extraction or unbounded decompression. Reject unused
                    # compressed bytes as well as CRC/content mismatches.
                    data = strict_zip_data(blob, archive.getinfo(name), payloads[name])
                else:
                    data = archive.read(name)
                require(digest(data) == sha, "DEPLOYED_SOURCE_MISMATCH")
    except (zipfile.BadZipFile, KeyError, RuntimeError, NotImplementedError, EOFError, UnicodeError, zlib.error, struct.error):
        raise ReadinessError("ARCHIVE_UNREADABLE") from None

def check(root, source_sha, describe_fn=None, download_fn=None):
    # Isolated validator adapter only. Release CLI requires reviewed evidence.
    require(describe_fn is not None and download_fn is not None, "VERIFIED_EVIDENCE_INPUT_REQUIRED")
    require(bool(re.fullmatch(r"[a-f0-9]{40}", source_sha)), "SOURCE_SHA_REQUIRED")
    try:
        head = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], stderr=subprocess.DEVNULL).decode().strip()
    except (OSError, subprocess.SubprocessError):
        raise ReadinessError("SOURCE_SHA_UNVERIFIED") from None
    require(head == source_sha, "SOURCE_SHA_MISMATCH")
    expected = expected_files(root)
    before = {f: identify(describe_fn(f), f) for f in REQUIRED}
    checked = set()
    for info in before.values():
        if info["source"] not in checked:
            verify_archive(download_fn(info["source"]), expected)
            checked.add(info["source"])
    after = {f: identify(describe_fn(f), f) for f in REQUIRED}
    require(before == after, "DEPLOYMENT_CHANGED_DURING_CHECK")
    # 情報は最小限。ソースZIP・環境変数・メタデータ全文を証跡へ残さない。
    return {"status": "PASS", "sourceSha": source_sha, "functions": [{"name": f, "revision": before[f]["revision"]} for f in REQUIRED], "verifiedFileCount": len(expected), "caseMailEnabled": False}

def source_evidence_module():
    spec = importlib.util.spec_from_file_location("hosting_source_evidence", pathlib.Path(__file__).with_name("hosting_source_evidence.py"))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--evidence", type=pathlib.Path, required=True)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--mutation-guard", action="store_true")
    args = parser.parse_args()
    evidence = source_evidence_module()
    try:
        from types import SimpleNamespace
        validators = SimpleNamespace(BUCKET=BUCKET, identify=identify, verify_archive=verify_archive,
                                     expected_files=expected_files, expected_packaging_files=expected_packaging_files,
                                     subprocess=subprocess)
        acquisition = os.environ.get("LKC_SOURCE_ACQUISITION", "retained")
        if acquisition == "fixed-source-once":
            directory = evidence.fixed_protected_context(args.source_sha)
            result = evidence.verify_fixed_capture(args.root.resolve(), args.source_sha, directory,
                                                   validators, preflight=args.preflight)
            if args.mutation_guard:
                result = evidence.require_current_fixed_acceptance(args.evidence.absolute(), result)
            else:
                result = evidence.bind_fixed_acceptance(result)
        else:
            evidence.need(acquisition in {"", "retained"}, "SOURCE_ACQUISITION_REJECTED")
            directory, approved = evidence.protected_context(args.source_sha)
            result = evidence.verify_bundle(args.root.resolve(), args.source_sha, directory, approved,
                                            validators, preflight=args.preflight)
            if args.mutation_guard:
                result = evidence.require_current_acceptance(args.evidence.absolute(), result)
            elif not args.preflight:
                result = evidence.bind_acceptance(result)
    except (ReadinessError, evidence.EvidenceError, OSError, ValueError, TypeError, AttributeError, RecursionError) as error:
        code = str(error) if isinstance(error, (ReadinessError, evidence.EvidenceError)) else "READINESS_INPUT_INVALID"
        result = {"status": "STOPPED", "reason": code}
        if os.environ.get("LKC_SOURCE_ACQUISITION") == "fixed-source-once" and type(error) is UnexpectedArchiveFilesError:
            result["diagnostics"] = error.diagnostics
    if args.mutation_guard:
        # Read-only revalidation: never overwrite/renew the accepted receipt.
        # This bounded, non-secret result is checked again immediately before POST.
        print(json.dumps(result, separators=(",", ":")))
        return 0 if result["status"] == "PASS" else 1
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(result, indent=2) + "\n", "utf-8")
    print("HOSTING_API_READINESS=" + result["status"])
    if result["status"] != ("PREFLIGHT_READY" if args.preflight else "PASS"):
        print("HOSTING_API_READINESS_ERROR=" + result["reason"])
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
