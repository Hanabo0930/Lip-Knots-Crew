"""Accept a separately reviewed, already-retained source bundle. No network I/O.

The protected environment's digest is the trust anchor for official observations,
not any flag in the bundle. Provisioning that digest and retained bytes is outside
this module. A digest chosen by the bundle producer is not an approval.
"""
import base64
import datetime as dt
import hashlib
import json
import os
import pathlib
import re
import stat

PROJECT = "lip-knots-crew-staging"
REGION = "asia-northeast1"
PROJECT_IDS = {PROJECT, "740154137290"}
FUNCTIONS = ("createUploadSession", "finalizeStagedUpload")
WORKFLOW = "Hanabo0930/Lip-Knots-Crew/.github/workflows/staging-hosting-promote.yml@refs/heads/main"
MAX_JSON = 2 * 1024 * 1024
MAX_ARCHIVE = 64 * 1024 * 1024
MAX_AGE = dt.timedelta(minutes=10)


class EvidenceError(Exception):
    pass


def need(condition, code):
    if not condition:
        raise EvidenceError(code)


def keys(value, required, optional=()):
    need(type(value) is dict and set(required) <= set(value)
         and set(value) <= set(required) | set(optional), "SOURCE_EVIDENCE_FIELDS_REJECTED")


def timestamp(value):
    need(type(value) is str and re.fullmatch(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z", value),
        "SOURCE_EVIDENCE_TIME_REJECTED")
    try:
        return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        raise EvidenceError("SOURCE_EVIDENCE_TIME_REJECTED") from None


def sha(value):
    need(type(value) is str and re.fullmatch(r"[a-f0-9]{64}", value),
         "SOURCE_EVIDENCE_DIGEST_REJECTED")
    return value


def pairs(items):
    result = {}
    for key, value in items:
        need(key not in result, "SOURCE_EVIDENCE_DUPLICATE_KEY")
        result[key] = value
    return result


def regular_read(file, maximum):
    # Reject links/reparse points before opening; never resolve an input link.
    file = pathlib.Path(file)
    need(file.is_absolute(), "SOURCE_EVIDENCE_PATH_REJECTED")
    for item in (file, *file.parents):
        info = item.lstat()
        need(not stat.S_ISLNK(info.st_mode)
             and not getattr(info, "st_file_attributes", 0) & 0x400,
             "SOURCE_EVIDENCE_LINK_REJECTED")
    initial = file.lstat()
    need(stat.S_ISREG(initial.st_mode) and initial.st_nlink == 1
         and 0 < initial.st_size <= maximum, "SOURCE_EVIDENCE_SIZE_REJECTED")
    fd = os.open(file, os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0))
    with os.fdopen(fd, "rb") as stream:
        opened = os.fstat(stream.fileno())
        need((initial.st_dev, initial.st_ino, initial.st_size, initial.st_mtime_ns)
             == (opened.st_dev, opened.st_ino, opened.st_size, opened.st_mtime_ns),
             "SOURCE_EVIDENCE_CHANGED")
        data = stream.read(maximum + 1)
        ended = os.fstat(stream.fileno())
    need(len(data) == initial.st_size and len(data) <= maximum
         and (opened.st_size, opened.st_mtime_ns) == (ended.st_size, ended.st_mtime_ns),
         "SOURCE_EVIDENCE_CHANGED")
    return data


def protected_context(source_sha, env=None):
    env = os.environ if env is None else env
    need(env.get("GITHUB_ACTIONS") == "true"
         and env.get("GITHUB_REPOSITORY") == "Hanabo0930/Lip-Knots-Crew"
         and env.get("GITHUB_REF") == "refs/heads/main"
         and env.get("GITHUB_REF_NAME") == "main"
         and env.get("GITHUB_JOB") == "promote"
         and env.get("GITHUB_WORKFLOW_REF") == WORKFLOW
         and env.get("GITHUB_RUN_ATTEMPT") == "1",
         "PROTECTED_WORKFLOW_CONTEXT_REQUIRED")
    operation = env.get("LKC_OPERATION")
    need(operation in {"readiness", "promote"}
         and env.get("GITHUB_EVENT_NAME") in {"workflow_dispatch", "workflow_run"}
         and (env.get("GITHUB_EVENT_NAME") != "workflow_run" or operation == "promote")
         and env.get("LKC_CONFIRMATION") == {
             "readiness": "CHECK_LKC_STAGING_HOSTING_READINESS",
             "promote": "PROMOTE_LKC_STAGING_HOSTING"}[operation],
         "SOURCE_EVIDENCE_OPERATION_REJECTED")
    need(env.get("LKC_PROJECT_ID") == PROJECT and env.get("LKC_REGION") == REGION
         and env.get("LKC_EVIDENCE_POLICY") == "source-provenance"
         and env.get("LKC_METADATA_ONLY") == "false"
         and env.get("LKC_SOURCE_SHA") == source_sha
         and re.fullmatch(r"[a-f0-9]{40}", source_sha or ""),
         "SOURCE_EVIDENCE_CONTEXT_REJECTED")
    # Only the protected workflow maps its independently reviewed environment
    # variable here. There is deliberately no CLI/dispatch/bundle digest option.
    approved = env.get("LKC_APPROVED_SOURCE_EVIDENCE_SHA256")
    need(bool(approved), "VERIFIED_NO_FEE_SOURCE_PATH_REQUIRED")
    sha(approved)
    runner_temp = pathlib.Path(env.get("RUNNER_TEMP", ""))
    need(runner_temp.is_absolute(), "SOURCE_EVIDENCE_PATH_REJECTED")
    return runner_temp / "hosting-source-evidence", approved


def fixed_source(value, readiness):
    keys(value, ["bucket", "object", "generation"])
    need(value["bucket"] == readiness.BUCKET, "SOURCE_BUCKET_UNVERIFIED")
    obj, generation = value["object"], value["generation"]
    need(type(obj) is str and re.fullmatch(r"[A-Za-z0-9_./-]+\.zip", obj)
         and not obj.startswith("/") and all(p not in {"", ".", ".."} for p in obj.split("/")),
         "SOURCE_OBJECT_UNVERIFIED")
    need(type(generation) is str and re.fullmatch(r"[1-9][0-9]{0,31}", generation),
         "SOURCE_GENERATION_REQUIRED")
    return f"gs://{value['bucket']}/{obj}#{generation}"


def build_name(value):
    match = type(value) is str and re.fullmatch(
        r"projects/([^/]+)/locations/([^/]+)/builds/([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})", value)
    need(match and match[1] in PROJECT_IDS and match[2] == REGION, "SOURCE_BUILD_SCOPE_REJECTED")
    return match[3]


def function_record(document, name, observed, readiness):
    keys(document, ["name", "environment", "state", "updateTime", "buildConfig", "serviceConfig"])
    keys(document["buildConfig"], ["build", "runtime", "entryPoint", "sourceProvenance"])
    keys(document["buildConfig"]["sourceProvenance"], ["resolvedStorageSource"])
    keys(document["serviceConfig"], ["service", "revision", "allTrafficOnLatestRevision"])
    result = readiness.identify(document, name)
    need(timestamp(document["updateTime"]) <= observed, "SOURCE_FUNCTION_TIME_REJECTED")
    result["build"] = document["buildConfig"]["build"]
    build_name(result["build"])
    result["source"] = fixed_source(document["buildConfig"]["sourceProvenance"]["resolvedStorageSource"], readiness)
    return result


def build_record(document, name, source_uri, observed, readiness):
    keys(document, ["id", "projectId", "status", "createTime", "startTime", "finishTime", "sourceProvenance"], ["name"])
    need(document["id"] == build_name(name) and document["projectId"] in PROJECT_IDS
         and ("name" not in document or document["name"] == name)
         and document["status"] == "SUCCESS", "SOURCE_BUILD_IDENTITY_OR_STATUS_REJECTED")
    need(timestamp(document["createTime"]) <= timestamp(document["startTime"])
         <= timestamp(document["finishTime"]) <= observed, "SOURCE_BUILD_TIME_REJECTED")
    provenance = document["sourceProvenance"]
    keys(provenance, ["resolvedStorageSource", "fileHashes"])
    need(fixed_source(provenance["resolvedStorageSource"], readiness) == source_uri,
         "SOURCE_BUILD_GENERATION_MISMATCH")
    hashes = provenance["fileHashes"]
    need(type(hashes) is dict and len(hashes) == 1, "SOURCE_BUILD_HASH_SCOPE_REJECTED")
    key = next(iter(hashes))
    # GCS source hashes describe the archive, not a per-file inventory. The
    # resolved generation above is mandatory even when the map key omits it.
    need(key in {source_uri, source_uri.rsplit("#", 1)[0]}, "SOURCE_BUILD_HASH_SCOPE_REJECTED")
    keys(hashes[key], ["fileHash"])
    entries = hashes[key]["fileHash"]
    need(type(entries) is list and 1 <= len(entries) <= 3, "SOURCE_BUILD_HASH_REJECTED")
    seen = set()
    digest = None
    for item in entries:
        keys(item, ["type", "value"])
        kind = item["type"]
        need(type(kind) is str and kind in {"MD5", "SHA256", "SHA512"} and kind not in seen,
             "SOURCE_BUILD_HASH_REJECTED")
        seen.add(kind)
        try:
            raw = base64.b64decode(item["value"], validate=True)
        except (ValueError, TypeError):
            raise EvidenceError("SOURCE_BUILD_HASH_REJECTED") from None
        need(len(raw) == {"MD5": 16, "SHA256": 32, "SHA512": 64}[kind]
             and base64.b64encode(raw).decode() == item["value"], "SOURCE_BUILD_HASH_REJECTED")
        if kind == "SHA256":
            digest = raw.hex()
    need(digest is not None, "SOURCE_BUILD_SHA256_REQUIRED")
    return digest


def load_bundle(directory, approved_digest, source_sha, readiness, now=None):
    """Pure local validation. Caller must supply the independently trusted pin."""
    sha(approved_digest)
    data = regular_read(pathlib.Path(directory) / "bundle.json", MAX_JSON)
    need(hashlib.sha256(data).hexdigest() == approved_digest, "SOURCE_REVIEW_DIGEST_MISMATCH")
    try:
        bundle = json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                            parse_constant=lambda _: (_ for _ in ()).throw(EvidenceError("SOURCE_EVIDENCE_JSON_REJECTED")))
    except (UnicodeError, ValueError):
        raise EvidenceError("SOURCE_EVIDENCE_JSON_REJECTED") from None
    keys(bundle, ["schemaVersion", "projectId", "region", "sourceSha", "expiresAt",
                  "observations", "expectedInventory", "archives"])
    need(type(bundle["schemaVersion"]) is int and bundle["schemaVersion"] == 1
         and bundle["projectId"] == PROJECT and bundle["region"] == REGION
         and type(source_sha) is str and re.fullmatch(r"[a-f0-9]{40}", source_sha)
         and bundle["sourceSha"] == source_sha, "SOURCE_EVIDENCE_IDENTITY_REJECTED")
    observations = bundle["observations"]
    keys(observations, ["before", "builds", "after"])
    for phase in ["before", "after"]:
        keys(observations[phase], ["capturedAt", "functions"])
        keys(observations[phase]["functions"], FUNCTIONS)
    keys(observations["builds"], ["capturedAt", "records"])
    before = timestamp(observations["before"]["capturedAt"])
    builds_at = timestamp(observations["builds"]["capturedAt"])
    after = timestamp(observations["after"]["capturedAt"])
    expires = timestamp(bundle["expiresAt"])
    now = now or dt.datetime.now(dt.timezone.utc)
    need(before <= builds_at <= after <= now < expires <= before + MAX_AGE
         and now - before <= MAX_AGE, "SOURCE_EVIDENCE_STALE_OR_FUTURE")
    pins = {}
    for name in FUNCTIONS:
        first, last = (observations[phase]["functions"][name] for phase in ["before", "after"])
        pins[name] = function_record(first, name, before, readiness)
        need(function_record(last, name, after, readiness) == pins[name] and last == first,
             "SOURCE_DEPLOYMENT_CHANGED_DURING_CAPTURE")
    records = observations["builds"]["records"]
    keys(records, {p["build"] for p in pins.values()})
    source_hashes = {}
    for pin in pins.values():
        digest = build_record(records[pin["build"]], pin["build"], pin["source"], builds_at, readiness)
        need(pin["source"] not in source_hashes or source_hashes[pin["source"]] == digest,
             "SOURCE_BUILD_HASH_CONFLICT")
        source_hashes[pin["source"]] = digest
    inventory = bundle["expectedInventory"]
    need(type(inventory) is dict and 4 <= len(inventory) <= 10000
         and {"package.json", "lib/index.js", "lib/uploads.js"} <= set(inventory),
         "SOURCE_EXPECTED_INVENTORY_REJECTED")
    for name, digest in inventory.items():
        need(type(name) is str and (name in {"package.json", "package-lock.json"}
             or re.fullmatch(r"(?:lib|src|case-mail-runtime)/[A-Za-z0-9_./-]+\.(?:js|cjs|ts|json)", name))
             and all(part not in {"", ".", ".."} for part in name.split("/")),
             "SOURCE_EXPECTED_INVENTORY_REJECTED")
        sha(digest)
    archives = bundle["archives"]
    keys(archives, source_hashes)
    blobs, names = {}, set()
    for uri, entry in archives.items():
        keys(entry, ["file", "sha256"])
        name = entry["file"]
        need(type(name) is str and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,79}\.zip", name)
             and name not in names, "SOURCE_ARCHIVE_PATH_REJECTED")
        names.add(name)
        need(sha(entry["sha256"]) == source_hashes[uri], "SOURCE_ARCHIVE_BUILD_HASH_MISMATCH")
        blob = regular_read(pathlib.Path(directory) / name, MAX_ARCHIVE)
        need(hashlib.sha256(blob).hexdigest() == source_hashes[uri], "SOURCE_ARCHIVE_BYTES_MISMATCH")
        readiness.verify_archive(blob, inventory)
        blobs[uri] = blob
    return bundle, pins, blobs


def verify_bundle(root, source_sha, directory, approved_digest, readiness, *, preflight=False, now=None):
    bundle, pins, blobs = load_bundle(directory, approved_digest, source_sha, readiness, now)
    need((now or dt.datetime.now(dt.timezone.utc)) < timestamp(bundle["expiresAt"]),
         "SOURCE_EVIDENCE_EXPIRED_DURING_CHECK")
    if preflight:
        return {"status": "PREFLIGHT_READY", "sourceSha": source_sha,
                "evidenceDigest": approved_digest, "externalApiInvoked": False,
                "deployedSourceVerified": False, "hostingPromotionAuthorized": False}
    try:
        head = readiness.subprocess.check_output(
            ["git", "-C", str(root), "rev-parse", "HEAD"], stderr=readiness.subprocess.DEVNULL).decode().strip()
    except (OSError, readiness.subprocess.SubprocessError):
        raise EvidenceError("SOURCE_SHA_UNVERIFIED") from None
    need(head == source_sha, "SOURCE_SHA_MISMATCH")
    expected = readiness.expected_files(root)
    need(expected == bundle["expectedInventory"], "SOURCE_APPROVED_INVENTORY_MISMATCH")
    # Reuse the existing complete inventory/content validator, never a declared
    # verified/CONSISTENT result. The reviewed SHA256 binds each retained ZIP.
    for blob in blobs.values():
        readiness.verify_archive(blob, expected)
    need((now or dt.datetime.now(dt.timezone.utc)) < timestamp(bundle["expiresAt"]),
         "SOURCE_EVIDENCE_EXPIRED_DURING_CHECK")
    return {"status": "PASS", "sourceSha": source_sha, "evidenceDigest": approved_digest,
            "functions": [{"name": f, "revision": pins[f]["revision"]} for f in FUNCTIONS],
            "verifiedFileCount": len(expected), "caseMailEnabled": False,
            "observationEndsAt": bundle["observations"]["after"]["capturedAt"],
            "expiresAt": bundle["expiresAt"], "externalApiInvoked": False,
            "hostingPromotionAuthorized": False, "authenticatedStaffAcceptance": "UNVERIFIED"}
