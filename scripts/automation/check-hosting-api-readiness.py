"""Hosting昇格前の読取専用検査。実行失敗・情報不足は必ず停止する。"""
import argparse
import hashlib
import io
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile

PROJECT = "lip-knots-crew-staging"
REGION = "asia-northeast1"
BUCKET = "gcf-v2-sources-740154137290-asia-northeast1"
REQUIRED = ("createUploadSession", "finalizeStagedUpload")
MAX_ARCHIVE = 64 * 1024 * 1024

class ReadinessError(Exception):
    pass

def require(condition, code):
    if not condition:
        raise ReadinessError(code)

def digest(data):
    return hashlib.sha256(data.replace(b"\r\n", b"\n")).hexdigest()

def expected_files(root):
    release = json.loads((root / "apps/admin/src/case-mail-release.json").read_text("utf-8"))
    # 受信7 APIの確認・有効化は別工程。フラグだけの開放を許可しない。
    require(isinstance(release, dict) and set(release) == {"enabled"} and release["enabled"] is False, "CASE_MAIL_RELEASE_NOT_APPROVED")
    base = root / "functions"
    files = [base / "package.json"]
    if (base / "package-lock.json").is_file():
        files.append(base / "package-lock.json")
    for folder, suffixes in (("lib", {".js"}), ("src", {".ts"}), ("case-mail-runtime", {".js", ".cjs", ".json"})):
        found = [p for p in (base / folder).rglob("*") if p.is_file() and p.suffix in suffixes]
        require(bool(found), "LOCAL_PACKAGE_INCOMPLETE")
        files.extend(found)
    require((base / "lib/index.js").is_file() and (base / "lib/uploads.js").is_file(), "LOCAL_BUILD_REQUIRED")
    require(json.loads((base / "package.json").read_text("utf-8")).get("main") == "lib/index.js", "LOCAL_ENTRY_UNEXPECTED")
    return {p.relative_to(base).as_posix(): digest(p.read_bytes()) for p in files}

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

def verify_archive(blob, expected):
    require(len(blob) <= MAX_ARCHIVE, "ARCHIVE_TOO_LARGE")
    try:
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            entries = archive.infolist()
            names = [i.filename for i in entries]
            require(len(names) == len(set(names)), "DUPLICATE_ARCHIVE_PATH")
            require(all(not n.startswith("/") and "\\" not in n and ".." not in n.split("/") for n in names), "UNSAFE_ARCHIVE_PATH")
            require(sum(i.file_size for i in entries) <= MAX_ARCHIVE, "ARCHIVE_TOO_LARGE")
            relevant = {n for n in names if n.startswith(("lib/", "src/", "case-mail-runtime/")) and n.endswith((".js", ".cjs", ".ts", ".json"))}
            require(relevant == {n for n in expected if n.startswith(("lib/", "src/", "case-mail-runtime/"))}, "DEPLOYED_CODE_INVENTORY_MISMATCH")
            for name, sha in expected.items():
                require(name in names, "DEPLOYED_PACKAGE_INCOMPLETE")
                require(digest(archive.read(name)) == sha, "DEPLOYED_SOURCE_MISMATCH")
    except (zipfile.BadZipFile, KeyError, RuntimeError):
        raise ReadinessError("ARCHIVE_UNREADABLE") from None

def gcloud_command(*arguments):
    executable = shutil.which("gcloud")
    require(executable is not None, "GCLOUD_NOT_FOUND")
    return [executable, *arguments]

def read_json(command):
    try:
        result = subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, timeout=60)
        return json.loads(result.stdout)
    except (OSError, subprocess.SubprocessError, ValueError):
        raise ReadinessError("READ_ONLY_METADATA_FAILED") from None

def describe(function):
    # 環境変数・Secret・IAMを取得/保存しない。
    fields = "name,environment,state,buildConfig.entryPoint,buildConfig.runtime,buildConfig.sourceProvenance,serviceConfig.service,serviceConfig.revision,serviceConfig.allTrafficOnLatestRevision"
    return read_json(gcloud_command("functions", "describe", function, "--gen2", f"--project={PROJECT}", f"--region={REGION}", f"--format=json({fields})"))

def read_archive(uri):
    # ZIPは一時ファイルだけに保持し、展開しない。環境ファイルは読み出さない。
    try:
        with tempfile.TemporaryFile() as stream:
            subprocess.run(gcloud_command("storage", "cat", uri), check=True, stdout=stream, stderr=subprocess.DEVNULL, timeout=120)
            require(stream.tell() <= MAX_ARCHIVE, "ARCHIVE_TOO_LARGE")
            stream.seek(0)
            return stream.read(MAX_ARCHIVE + 1)
    except (OSError, subprocess.SubprocessError):
        raise ReadinessError("READ_ONLY_SOURCE_FAILED") from None

def check(root, source_sha, describe_fn=describe, download_fn=read_archive):
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

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", type=pathlib.Path, default=pathlib.Path("."))
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--evidence", type=pathlib.Path, required=True)
    args = parser.parse_args()
    try:
        result = check(args.root.resolve(), args.source_sha)
    except (ReadinessError, OSError, ValueError, TypeError, AttributeError) as error:
        code = str(error) if isinstance(error, ReadinessError) else "READINESS_INPUT_INVALID"
        result = {"status": "STOPPED", "reason": code}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(result, indent=2) + "\n", "utf-8")
    print("HOSTING_API_READINESS=" + result["status"])
    if result["status"] != "PASS":
        print("HOSTING_API_READINESS_ERROR=" + result["reason"])
        return 1
    return 0

if __name__ == "__main__":
    sys.exit(main())
