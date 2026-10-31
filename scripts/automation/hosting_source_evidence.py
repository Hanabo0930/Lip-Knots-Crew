"""Validate retained source or an explicit protected collector capture. No network I/O.

The protected environment's digest is the trust anchor for official observations,
not any flag in the bundle. Provisioning that digest and retained bytes is outside
this module. A digest chosen by the bundle producer is not an approval.
The fixed-generation route uses a different trust boundary: the main protected
workflow's authenticated collector plus private same-run integrity. Its HMAC
is neither a Google signature nor the retained route's independent review pin.
"""
import base64
import datetime as dt
import hashlib
import hmac
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
FIXED_METHOD = "authenticated-fixed-generation"
FIXED_CONFIRMATION = "ACQUIRE_LKC_STAGING_FIXED_SOURCE_ONCE_20MIB"
FIXED_ARCHIVE_MAX = 10 * 1024 * 1024
FIXED_PLAN_MAX_AGE = dt.timedelta(minutes=30)
FIXED_ARCHIVES = {name: name.lower() + ".zip" for name in FUNCTIONS}


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


def _protected_context_base(source_sha, env=None):
    env = os.environ if env is None else env
    need(env.get("GITHUB_ACTIONS") == "true"
         and env.get("GITHUB_REPOSITORY") == "Hanabo0930/Lip-Knots-Crew"
         and env.get("GITHUB_REF") == "refs/heads/main"
         and env.get("GITHUB_REF_NAME") == "main"
         and env.get("GITHUB_JOB") == "promote"
         and env.get("GITHUB_WORKFLOW_REF") == WORKFLOW
         and re.fullmatch(r"[1-9][0-9]{0,19}", env.get("GITHUB_RUN_ID", ""))
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


def protected_context(source_sha, env=None):
    env = os.environ if env is None else env
    _protected_context_base(source_sha, env)
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
    digests = {}
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
        digests[kind.lower()] = raw.hex()
    need("sha256" in digests, "SOURCE_BUILD_SHA256_REQUIRED")
    return digests


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
        need(sha(entry["sha256"]) == source_hashes[uri]["sha256"], "SOURCE_ARCHIVE_BUILD_HASH_MISMATCH")
        blob = regular_read(pathlib.Path(directory) / name, MAX_ARCHIVE)
        need(all(hashlib.new(kind, blob).hexdigest() == digest
                 for kind, digest in source_hashes[uri].items()), "SOURCE_ARCHIVE_BYTES_MISMATCH")
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


def bind_acceptance(result, env=None, now=None):
    """Bind a freshly verified result to this protected execution, not a caller flag."""
    env = os.environ if env is None else env
    need(result.get("status") == "PASS", "SOURCE_ACCEPTANCE_REQUIRED")
    protected_context(result["sourceSha"], env)
    need(result["evidenceDigest"] == env["LKC_APPROVED_SOURCE_EVIDENCE_SHA256"],
         "SOURCE_ACCEPTANCE_PIN_MISMATCH")
    checked = now or dt.datetime.now(dt.timezone.utc)
    need(timestamp(result["observationEndsAt"]) <= checked < timestamp(result["expiresAt"]),
         "SOURCE_ACCEPTANCE_EXPIRED_OR_FUTURE")
    return {**result, "checkedAt": checked.isoformat().replace("+00:00", "Z"),
            "acceptanceRun": {"repository": env["GITHUB_REPOSITORY"],
                              "workflowRef": env["GITHUB_WORKFLOW_REF"],
                              "runId": env["GITHUB_RUN_ID"], "runAttempt": 1}}


def require_current_acceptance(file, fresh_result, env=None, now=None):
    # The caller has just revalidated the pinned bundle, archive bytes and local
    # inventory. The old PASS receipt alone is never sufficient for a write.
    expected = bind_acceptance(fresh_result, env, now)
    raw = regular_read(pathlib.Path(file), MAX_JSON)
    try:
        saved = json.loads(raw.decode("utf-8"), object_pairs_hook=pairs)
    except (UnicodeError, ValueError):
        raise EvidenceError("SOURCE_ACCEPTANCE_RECEIPT_REJECTED") from None
    keys(saved, expected.keys())
    need(json.dumps({k: v for k, v in saved.items() if k != "checkedAt"}, sort_keys=True)
         == json.dumps({k: v for k, v in expected.items() if k != "checkedAt"}, sort_keys=True),
         "SOURCE_ACCEPTANCE_RECEIPT_MISMATCH")
    need(timestamp(expected["observationEndsAt"]) <= timestamp(saved["checkedAt"])
         <= timestamp(expected["checkedAt"]) < timestamp(expected["expiresAt"]),
         "SOURCE_ACCEPTANCE_EXPIRED_OR_FUTURE")
    return {"status": "PASS", "sourceSha": expected["sourceSha"],
            "evidenceDigest": expected["evidenceDigest"],
            "runId": expected["acceptanceRun"]["runId"], "runAttempt": 1,
            "expiresAt": expected["expiresAt"]}


def fixed_protected_context(source_sha, env=None):
    """The explicit authenticated route never borrows the retained review pin."""
    env = os.environ if env is None else env
    _protected_context_base(source_sha, env)
    need(env.get("GITHUB_EVENT_NAME") == "workflow_dispatch"
         and env.get("GITHUB_SHA") == source_sha
         and env.get("LKC_SOURCE_ACQUISITION") == "fixed-source-once"
         and env.get("LKC_SOURCE_ACQUISITION_CONFIRMATION") == FIXED_CONFIRMATION,
         "FIXED_SOURCE_EXPLICIT_REVIEW_REQUIRED")
    runner_temp = pathlib.Path(env.get("RUNNER_TEMP", ""))
    need(runner_temp.is_absolute(), "SOURCE_EVIDENCE_PATH_REJECTED")
    return runner_temp / "hosting-fixed-source-evidence"


def _private_directory(directory):
    directory = pathlib.Path(directory)
    need(directory.is_absolute(), "FIXED_SOURCE_PRIVATE_PATH_REJECTED")
    for item in (directory, *directory.parents):
        need(not stat.S_ISLNK(item.lstat().st_mode), "SOURCE_EVIDENCE_LINK_REJECTED")
    info = directory.lstat()
    need(stat.S_ISDIR(info.st_mode) and stat.S_IMODE(info.st_mode) == 0o700
         and (not hasattr(os, "geteuid") or info.st_uid == os.geteuid()),
         "FIXED_SOURCE_PRIVATE_MODE_REJECTED")


def _private_read(file, maximum):
    file = pathlib.Path(file)
    before = file.lstat()
    need(stat.S_IMODE(before.st_mode) == 0o600
         and (not hasattr(os, "geteuid") or before.st_uid == os.geteuid()),
         "FIXED_SOURCE_PRIVATE_MODE_REJECTED")
    value = regular_read(file, maximum)
    after = file.lstat()
    need((before.st_mode, before.st_uid, before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns)
         == (after.st_mode, after.st_uid, after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns),
         "SOURCE_EVIDENCE_CHANGED")
    return value


def _fixed_json(data):
    try:
        return json.loads(data.decode("utf-8"), object_pairs_hook=pairs,
                          parse_constant=lambda _: (_ for _ in ()).throw(EvidenceError("FIXED_SOURCE_JSON_REJECTED")))
    except (UnicodeError, ValueError):
        raise EvidenceError("FIXED_SOURCE_JSON_REJECTED") from None


def _same_run_record(document, env):
    need(type(document["schemaVersion"]) is int and document["schemaVersion"] == 1
         and document["repository"] == env["GITHUB_REPOSITORY"]
         and document["workflowRef"] == env["GITHUB_WORKFLOW_REF"]
         and document["runId"] == env["GITHUB_RUN_ID"]
         and type(document["runAttempt"]) is int and document["runAttempt"] == 1
         and document["sourceSha"] == env["LKC_SOURCE_SHA"]
         and document["operation"] == env["LKC_OPERATION"], "FIXED_SOURCE_RUN_BINDING_REJECTED")


def _canonical_base64(value, length):
    try:
        raw = base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        raise EvidenceError("FIXED_SOURCE_HASH_REJECTED") from None
    need(len(raw) == length and base64.b64encode(raw).decode() == value,
         "FIXED_SOURCE_HASH_REJECTED")
    return raw


def _fixed_build(document, name, sources, observed, readiness):
    keys(document, ["id", "projectId", "status", "createTime", "startTime", "finishTime"],
         ["name", "sourceProvenance", "results"])
    need(document["id"] == build_name(name) and document["projectId"] in PROJECT_IDS
         and ("name" not in document or document["name"] == name)
         and document["status"] == "SUCCESS", "SOURCE_BUILD_IDENTITY_OR_STATUS_REJECTED")
    need(timestamp(document["createTime"]) <= timestamp(document["startTime"])
         <= timestamp(document["finishTime"]) <= observed, "SOURCE_BUILD_TIME_REJECTED")
    if "results" in document:
        keys(document["results"], [], ["images"])
        images = document["results"].get("images", [])
        need(type(images) is list and len(images) <= 100, "FIXED_SOURCE_BUILD_RESULTS_REJECTED")
        for image in images:
            keys(image, ["digest"])
            need(type(image["digest"]) is str and len(image["digest"]) <= 256
                 and not re.search(r"[\x00-\x1f]", image["digest"]), "FIXED_SOURCE_BUILD_RESULTS_REJECTED")
    provenance = document.get("sourceProvenance", {})
    keys(provenance, [], ["resolvedStorageSource", "fileHashes"])
    if "resolvedStorageSource" in provenance:
        resolved = fixed_source(provenance["resolvedStorageSource"], readiness)
        need(all(resolved == source for source in sources), "SOURCE_BUILD_GENERATION_MISMATCH")
    hashes = provenance.get("fileHashes", {})
    need(type(hashes) is dict and len(hashes) <= 2 * len(sources), "SOURCE_BUILD_HASH_SCOPE_REJECTED")
    allowed = set(sources) | {source.rsplit("#", 1)[0] for source in sources}
    result = {}
    for uri, item in hashes.items():
        need(uri in allowed, "SOURCE_BUILD_HASH_SCOPE_REJECTED")
        keys(item, ["fileHash"])
        need(type(item["fileHash"]) is list and 1 <= len(item["fileHash"]) <= 3,
             "SOURCE_BUILD_HASH_REJECTED")
        digests = {}
        for value in item["fileHash"]:
            keys(value, ["type", "value"])
            kind = value["type"]
            need(type(kind) is str and kind in {"MD5", "SHA256", "SHA512"}
                 and kind.lower() not in digests, "SOURCE_BUILD_HASH_REJECTED")
            digests[kind.lower()] = _canonical_base64(value["value"], {"MD5": 16, "SHA256": 32, "SHA512": 64}[kind]).hex()
        result[uri] = digests
    return result


def _crc32c(blob):
    # Storage CRC32C uses Castagnoli, not zlib's ZIP/IEEE CRC32.
    table = []
    for initial in range(256):
        value = initial
        for _ in range(8):
            value = (value >> 1) ^ (0x82F63B78 if value & 1 else 0)
        table.append(value)
    value = 0xFFFFFFFF
    for byte in blob:
        value = (value >> 8) ^ table[(value ^ byte) & 255]
    return (value ^ 0xFFFFFFFF).to_bytes(4, "big")


def _fixed_object(document, source, blob):
    keys(document, ["bucket", "name", "generation", "metageneration", "size", "storageClass", "crc32c"], ["md5Hash"])
    need(document["bucket"] == source["bucket"] and document["name"] == source["object"]
         and document["generation"] == source["generation"], "FIXED_SOURCE_OBJECT_IDENTITY_MISMATCH")
    need(document["storageClass"] == "STANDARD", "FIXED_SOURCE_STORAGE_CONDITIONS_REJECTED")
    need(type(document["metageneration"]) is str
         and re.fullmatch(r"[1-9][0-9]{0,31}", document["metageneration"]), "FIXED_SOURCE_OBJECT_IDENTITY_MISMATCH")
    need(type(document["size"]) is str and re.fullmatch(r"[1-9][0-9]{0,7}", document["size"])
         and int(document["size"]) == len(blob) <= FIXED_ARCHIVE_MAX, "FIXED_SOURCE_SIZE_REJECTED")
    need(_canonical_base64(document["crc32c"], 4) == _crc32c(blob), "FIXED_SOURCE_BODY_HASH_MISMATCH")
    if "md5Hash" in document:
        need(_canonical_base64(document["md5Hash"], 16) == hashlib.md5(blob).digest(),
             "FIXED_SOURCE_BODY_HASH_MISMATCH")


def verify_fixed_capture(root, source_sha, directory, readiness, *, preflight=False, env=None, now=None):
    """Revalidate this protected runner's collector receipt, never caller flags.

    The HMAC is local same-run integrity, NOT an independent review pin or a
    Google signature. Origin comes from the trusted main workflow's bounded
    authenticated collector. Neither private files nor key are public artifacts.
    """
    env = os.environ if env is None else env
    need(not preflight, "FIXED_SOURCE_PREFLIGHT_NOT_ACCEPTANCE")
    need(pathlib.Path(directory) == fixed_protected_context(source_sha, env), "FIXED_SOURCE_PRIVATE_PATH_REJECTED")
    directory = pathlib.Path(directory)
    _private_directory(directory)
    expected_names = {"collector.key", "plan.json", "plan.hmac", "attempt.json", "capture.json", "capture.hmac",
                      *FIXED_ARCHIVES.values()}
    need(set(os.listdir(directory)) == expected_names, "FIXED_SOURCE_PRIVATE_INVENTORY_REJECTED")
    key = _private_read(directory / "collector.key", 32)
    need(len(key) == 32, "FIXED_SOURCE_KEY_REJECTED")
    plan_raw = _private_read(directory / "plan.json", MAX_JSON)
    capture_raw = _private_read(directory / "capture.json", MAX_JSON)
    for name, data in [("plan", plan_raw), ("capture", capture_raw)]:
        signature = _private_read(directory / (name + ".hmac"), 64)
        need(re.fullmatch(b"[a-f0-9]{64}", signature)
             and hmac.compare_digest(signature, hmac.new(key, data, hashlib.sha256).hexdigest().encode()),
             "FIXED_SOURCE_SIGNATURE_REJECTED")
    plan = _fixed_json(plan_raw)
    plan_fields = ["schemaVersion", "repository", "workflowRef", "runId", "runAttempt", "sourceSha", "operation", "createdAt"]
    keys(plan, plan_fields)
    _same_run_record(plan, env)
    attempt = _fixed_json(_private_read(directory / "attempt.json", MAX_JSON))
    keys(attempt, [*plan_fields, "startedAt"])
    need({name: attempt[name] for name in plan_fields} == plan, "FIXED_SOURCE_ATTEMPT_REJECTED")
    capture = _fixed_json(capture_raw)
    keys(capture, [*plan_fields, "method", "capturedAt", "endsAt", "expiresAt", "before", "builds", "objects",
                   "after", "afterBuilds", "archives", "requestCount", "bytesDownloaded"])
    _same_run_record(capture, env)
    need(capture["method"] == FIXED_METHOD and capture["createdAt"] == plan["createdAt"], "FIXED_SOURCE_METHOD_REJECTED")
    created, started, before, after, expires = map(timestamp, [plan["createdAt"], attempt["startedAt"],
        capture["capturedAt"], capture["endsAt"], capture["expiresAt"]])
    checked = now or dt.datetime.now(dt.timezone.utc)
    need(created <= started <= before <= after <= checked < expires <= before + MAX_AGE
         and checked - before <= MAX_AGE and before - created <= FIXED_PLAN_MAX_AGE,
         "FIXED_SOURCE_STALE_OR_FUTURE")
    keys(capture["before"], FUNCTIONS)
    keys(capture["after"], FUNCTIONS)
    keys(capture["objects"], FUNCTIONS)
    keys(capture["archives"], FUNCTIONS)
    pins, sources = {}, {}
    for name in FUNCTIONS:
        first, last = capture["before"][name], capture["after"][name]
        # The update may immediately precede the first GET. endsAt bounds both
        # observations; equality below binds their complete allowlisted content.
        pins[name] = function_record(first, name, after, readiness)
        need(function_record(last, name, after, readiness) == pins[name] and first == last,
             "SOURCE_DEPLOYMENT_CHANGED_DURING_CAPTURE")
        sources[name] = first["buildConfig"]["sourceProvenance"]["resolvedStorageSource"]
        need(sources[name]["object"] == name + "/function-source.zip", "SOURCE_OBJECT_UNVERIFIED")
    builds = {pin["build"] for pin in pins.values()}
    keys(capture["builds"], builds)
    keys(capture["afterBuilds"], builds)
    need(capture["builds"] == capture["afterBuilds"], "FIXED_SOURCE_BUILD_CHANGED")
    need(type(capture["requestCount"]) is int and capture["requestCount"] == 8 + 2 * len(builds) <= 12,
         "FIXED_SOURCE_REQUEST_LIMIT")
    build_hashes = {}
    for name in builds:
        build_hashes[name] = _fixed_build(capture["builds"][name], name,
            [pin["source"] for pin in pins.values() if pin["build"] == name], after, readiness)
    try:
        head = readiness.subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"],
                                                stderr=readiness.subprocess.DEVNULL).decode().strip()
    except (OSError, readiness.subprocess.SubprocessError):
        raise EvidenceError("SOURCE_SHA_UNVERIFIED") from None
    need(head == source_sha, "SOURCE_SHA_MISMATCH")
    expected = readiness.expected_files(root, strict=True)
    optional = readiness.expected_packaging_files(root)
    total = 0
    for name in FUNCTIONS:
        entry = capture["archives"][name]
        keys(entry, ["file", "sha256", "size"])
        need(entry["file"] == FIXED_ARCHIVES[name], "SOURCE_ARCHIVE_PATH_REJECTED")
        blob = _private_read(directory / FIXED_ARCHIVES[name], FIXED_ARCHIVE_MAX)
        need(type(entry["size"]) is int and entry["size"] == len(blob), "FIXED_SOURCE_SIZE_REJECTED")
        total += len(blob)
        need(hashlib.sha256(blob).hexdigest() == sha(entry["sha256"]), "SOURCE_ARCHIVE_BYTES_MISMATCH")
        _fixed_object(capture["objects"][name], sources[name], blob)
        uri = pins[name]["source"]
        for key_uri in (uri, uri.rsplit("#", 1)[0]):
            for kind, digest in build_hashes[pins[name]["build"]].get(key_uri, {}).items():
                need(hashlib.new(kind, blob).hexdigest() == digest, "SOURCE_ARCHIVE_BUILD_HASH_MISMATCH")
        readiness.verify_archive(blob, expected, strict=True, optional=optional)
    need(type(capture["bytesDownloaded"]) is int and capture["bytesDownloaded"] == total <= 2 * FIXED_ARCHIVE_MAX,
         "FIXED_SOURCE_TOTAL_TOO_LARGE")
    need((now or dt.datetime.now(dt.timezone.utc)) < expires, "SOURCE_EVIDENCE_EXPIRED_DURING_CHECK")
    return {"status": "PASS", "sourceSha": source_sha, "evidenceMethod": FIXED_METHOD,
            "evidenceDigest": hashlib.sha256(capture_raw).hexdigest(),
            "functions": [{"name": name, "revision": pins[name]["revision"]} for name in FUNCTIONS],
            "verifiedFileCount": len(expected), "caseMailEnabled": False,
            "observationEndsAt": capture["endsAt"], "expiresAt": capture["expiresAt"],
            "externalApiInvoked": True, "deployedSourceVerified": True,
            "hostingPromotionAuthorized": False, "authenticatedStaffAcceptance": "UNVERIFIED"}


def bind_fixed_acceptance(result, env=None, now=None):
    env = os.environ if env is None else env
    need(result.get("status") == "PASS" and result.get("evidenceMethod") == FIXED_METHOD,
         "SOURCE_ACCEPTANCE_REQUIRED")
    fixed_protected_context(result["sourceSha"], env)
    checked = now or dt.datetime.now(dt.timezone.utc)
    need(timestamp(result["observationEndsAt"]) <= checked < timestamp(result["expiresAt"]),
         "SOURCE_ACCEPTANCE_EXPIRED_OR_FUTURE")
    return {**result, "checkedAt": checked.isoformat().replace("+00:00", "Z"),
            "acceptanceRun": {"repository": env["GITHUB_REPOSITORY"], "workflowRef": env["GITHUB_WORKFLOW_REF"],
                              "runId": env["GITHUB_RUN_ID"], "runAttempt": 1}}


def require_current_fixed_acceptance(file, fresh_result, env=None, now=None):
    # The CLI first revalidates the signed capture, complete archives and the
    # current build inventory. A copied PASS is never accepted by itself.
    expected = bind_fixed_acceptance(fresh_result, env, now)
    saved = _fixed_json(regular_read(pathlib.Path(file), MAX_JSON))
    keys(saved, expected.keys())
    need({key: value for key, value in saved.items() if key != "checkedAt"}
         == {key: value for key, value in expected.items() if key != "checkedAt"},
         "SOURCE_ACCEPTANCE_RECEIPT_MISMATCH")
    need(timestamp(expected["observationEndsAt"]) <= timestamp(saved["checkedAt"])
         <= timestamp(expected["checkedAt"]) < timestamp(expected["expiresAt"]),
         "SOURCE_ACCEPTANCE_EXPIRED_OR_FUTURE")
    return {"status": "PASS", "sourceSha": expected["sourceSha"], "evidenceMethod": FIXED_METHOD,
            "evidenceDigest": expected["evidenceDigest"], "runId": expected["acceptanceRun"]["runId"],
            "runAttempt": 1, "expiresAt": expected["expiresAt"]}
