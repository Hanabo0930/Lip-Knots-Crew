"""保護環境専用。ソースと停止値だけを更新し、Trigger/Scheduler/IAMを書き換えない。"""
import argparse
import copy
import datetime as dt
import hashlib
import io
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from concurrent.futures import ThreadPoolExecutor

PROJECT = "lip-knots-crew-staging"
REGION = "asia-northeast1"
PREFIX = f"projects/{PROJECT}/locations/{REGION}"
TARGETS = ("processSafeSheetWrite", "updateExpenseReviewFromQueue", "dispatchDueNotifications",
           "scheduleOperationalReminders", "processSheetRowCreation", "retrySheetRowCreation")
EVENT_TARGETS = ("processSafeSheetWrite", "updateExpenseReviewFromQueue", "processSheetRowCreation")
SENTINELS = ("retrySafeSheetWrites", "finalizeStagedUpload", "processNotificationQueue")
PAUSED_JOBS = ("scheduleOperationalReminders", "retrySheetRowCreation")
MASK = "buildConfig.source,serviceConfig.environmentVariables"
PAUSED_ENV = {"LKC_SHEET_WRITE_MODE": "paused", "LKC_NOTIFICATION_DELIVERY_MODE": "paused"}
CONFIRMATION = "MIGRATE_LKC_STAGING_WORKER_PAUSED"
CF = "https://cloudfunctions.googleapis.com/v2/"
RUN = "https://run.googleapis.com/v2/"
SCHED = "https://cloudscheduler.googleapis.com/v1/"
EVENT = "https://eventarc.googleapis.com/v1/"
PUBSUB = "https://pubsub.googleapis.com/v1/"
SOURCE_BUCKET = "gcf-v2-sources-740154137290-asia-northeast1"
MAX_ARCHIVE = 100 * 1024 * 1024


def require(condition, code):
    if not condition:
        raise ValueError(code)


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


def sha(value):
    return isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value) and value != "0" * 64


def validate_clearance(clearance, target, source_sha, now=None):
    """証拠の中身を自動認定しない。独立したレビューと保護環境の承認が別途必須。"""
    now = now or dt.datetime.now(dt.timezone.utc)
    require(target in TARGETS and re.fullmatch(r"[a-f0-9]{40}", source_sha or ""), "SCOPE_REJECTED")
    require(clearance.get("schemaVersion") == 1 and clearance.get("project") == PROJECT
            and clearance.get("region") == REGION and clearance.get("target") == target
            and clearance.get("sourceSha") == source_sha, "CLEARANCE_SCOPE_MISMATCH")
    try:
        issued = dt.datetime.fromisoformat(clearance["issuedAt"])
        expires = dt.datetime.fromisoformat(clearance["expiresAt"])
        require(issued.tzinfo is not None and expires.tzinfo is not None, "CLEARANCE_TIME_REQUIRED")
        require(issued <= now < expires and expires - issued <= dt.timedelta(hours=2), "CLEARANCE_EXPIRED")
    except (KeyError, TypeError, ValueError):
        raise ValueError("CLEARANCE_TIME_INVALID") from None
    require(sha(clearance.get("beforeSha256")), "BEFORE_DIGEST_REQUIRED")
    evidence = clearance.get("evidence", {})
    require(all(sha(evidence.get(key)) for key in
                ("arrivalControl", "oldExecutionCompletion", "externalEffectsCompletion",
                 "retainedEventRecovery", "sourceBackup")), "REVIEWED_EVIDENCE_REQUIRED")
    require(all(clearance.get("confirmed", {}).get(key) is True for key in
                ("newArrivalsHeld", "oldExecutionsFinished", "externalEffectsSettled",
                 "retainedEventsRecoverable")), "CLEARANCE_NOT_CONFIRMED")
    require(bool(re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9-]{0,38}", clearance.get("reviewedBy", ""))),
            "REVIEWER_REQUIRED")


def stable_job(job):
    return {key: value for key, value in job.items()
            if key not in ("status", "scheduleTime", "lastAttemptTime", "userUpdateTime")}


def validate_service_revision(service, fn):
    revision = fn["serviceConfig"].get("revision", "")
    expected = service["name"] + "/revisions/" + revision
    require(bool(revision) and service.get("latestReadyRevision") == expected and
            service.get("latestCreatedRevision") == expected and not service.get("reconciling", False),
            "RUN_REVISION_MISMATCH")
    traffic = service.get("trafficStatuses", [])
    require(len(traffic) == 1 and traffic[0].get("percent") == 100
            and traffic[0].get("revision", "").split("/")[-1] == revision
            and not traffic[0].get("tag"), "RUN_TRAFFIC_MISMATCH")


def stable_service(service):
    return {key: value for key, value in service.items() if key not in
            ("etag", "updateTime", "observedGeneration", "reconciling", "terminalCondition", "conditions")}


def fixed_source(fn, target):
    source = fn.get("buildConfig", {}).get("sourceProvenance", {}).get("resolvedStorageSource", {})
    require(source.get("bucket") == SOURCE_BUCKET and source.get("object") == target + "/function-source.zip"
            and re.fullmatch(r"[1-9][0-9]*", str(source.get("generation", ""))), "SOURCE_PROVENANCE_INVALID")
    return source


def archive_manifest(data):
    require(len(data) <= MAX_ARCHIVE, "SOURCE_ARCHIVE_TOO_LARGE")
    manifest = {}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        require(len(entries) <= 20000 and sum(entry.file_size for entry in entries) <= MAX_ARCHIVE,
                "SOURCE_ARCHIVE_TOO_LARGE")
        for entry in entries:
            name = entry.orig_filename
            require(name and not name.startswith("/") and "\\" not in name and ":" not in name
                    and all(part not in (".", "..") for part in name.rstrip("/").split("/"))
                    and (entry.external_attr >> 16) & 0o170000 != 0o120000, "SOURCE_ARCHIVE_PATH_INVALID")
            require(name not in manifest, "SOURCE_ARCHIVE_DUPLICATE")
            manifest[name] = None if entry.is_dir() else hashlib.sha256(archive.read(entry)).hexdigest()
    return {name: value for name, value in manifest.items() if value is not None}


def validate_snapshot(snapshot, target):
    require(target in TARGETS, "TARGET_REJECTED")
    functions = snapshot["functions"]
    for name in TARGETS + SENTINELS:
        fn = functions[name]
        require(fn.get("name") == f"{PREFIX}/functions/{name}" and fn.get("state") == "ACTIVE"
                and fn.get("environment") == "GEN_2", "FUNCTION_NOT_READY")
        require(fn["serviceConfig"].get("service") == f"{PREFIX}/services/{name.lower()}",
                "SERVICE_IDENTITY_MISMATCH")
    fn = functions[target]
    require(fn["buildConfig"].get("runtime") == "nodejs22" and
            fn["buildConfig"].get("entryPoint") == target, "RUNTIME_MISMATCH")
    require(fn["serviceConfig"].get("environmentVariables", {}).get("APP_ENVIRONMENT") == "staging",
            "ENVIRONMENT_MISMATCH")
    for name in TARGETS:
        service = snapshot["services"][name]
        require(service.get("name") == f"{PREFIX}/services/{name.lower()}" and
                service.get("terminalCondition", {}).get("state") == "CONDITION_SUCCEEDED",
                "SERVICE_NOT_READY")
        validate_service_revision(service, functions[name])
        require(service.get("invokerIamDisabled", False) is False, "INVOKER_CHECK_REQUIRED")
        policy = snapshot["iam"][name]
        require(isinstance(policy, dict) and isinstance(policy.get("bindings", []), list),
                "IAM_UNKNOWN")
        require(not any(member in ("allUsers", "allAuthenticatedUsers")
                        for binding in policy.get("bindings", []) for member in binding.get("members", [])),
                "PUBLIC_WORKER_REJECTED")
    jobs = snapshot["jobs"]
    for name in PAUSED_JOBS:
        job_name = f"{PREFIX}/jobs/firebase-schedule-{name}-{REGION}"
        require(job_name in jobs and jobs[job_name].get("state") == "PAUSED", "SCHEDULER_NOT_PAUSED")
        require(jobs[job_name].get("httpTarget", {}).get("uri") ==
                f"https://{REGION}-{PROJECT}.cloudfunctions.net/{name}", "SCHEDULER_TARGET_CHANGED")
    require(f"{PREFIX}/jobs/firebase-schedule-dispatchDueNotifications-{REGION}" not in jobs,
            "UNEXPECTED_NOTIFICATION_SCHEDULER")
    for name in EVENT_TARGETS:
        trigger = snapshot["triggers"][name]
        expected = functions[name]["eventTrigger"]["trigger"]
        require(trigger.get("name") == expected and expected.startswith(f"{PREFIX}/triggers/")
                and trigger.get("uid"), "TRIGGER_IDENTITY_MISMATCH")
        require(trigger.get("destination", {}).get("cloudFunction") == f"{PREFIX}/functions/{name}",
                "TRIGGER_DESTINATION_MISMATCH")
        sub = snapshot["subscriptions"][name]
        require(sub.get("name") == trigger["transport"]["pubsub"]["subscription"]
                and sub.get("topic") == trigger["transport"]["pubsub"]["topic"]
                and sub["name"].startswith(f"projects/{PROJECT}/subscriptions/"), "SUBSCRIPTION_MISMATCH")
        require(sub.get("state") == "ACTIVE" and sub.get("pushConfig", {}) == {},
                "EVENT_DELIVERY_NOT_HELD")
        # 既存の24時間保持ではこの経路を開かない。延長・停止操作はここでは実施しない。
        retention = sub.get("messageRetentionDuration", "")
        require(re.fullmatch(r"[0-9]+s", retention) and int(retention[:-1]) >= 172800,
                "RETENTION_TOO_SHORT")


def patch_body(before, target, source):
    require(target in TARGETS and before.get("name") == f"{PREFIX}/functions/{target}",
            "PATCH_TARGET_REJECTED")
    require(set(source) <= {"bucket", "object", "generation"} and source.get("bucket") and source.get("object"),
            "UPLOAD_SOURCE_INVALID")
    env = dict(before["serviceConfig"].get("environmentVariables", {}))
    require(env.get("APP_ENVIRONMENT") == "staging", "PATCH_ENVIRONMENT_MISMATCH")
    env.update(PAUSED_ENV)
    return {"name": before["name"], "buildConfig": {"source": {"storageSource": source}},
            "serviceConfig": {"environmentVariables": env}}


def function_config(fn):
    result = copy.deepcopy(fn)
    for key in ("state", "stateMessages", "updateTime", "url", "satisfiesPzs", "satisfiesPzi"):
        result.pop(key, None)
    for key in ("build", "source", "sourceProvenance", "sourceToken"):
        result.get("buildConfig", {}).pop(key, None)
    result.get("buildConfig", {}).get("onDeployUpdatePolicy", {}).pop("runtimeVersion", None)
    for key in ("revision", "uri", "gcfUri"):
        result.get("serviceConfig", {}).pop(key, None)
    return result


def verify_after(before, after, target):
    validate_snapshot(after, target)
    expected = copy.deepcopy(before["functions"][target])
    expected["serviceConfig"]["environmentVariables"].update(PAUSED_ENV)
    actual = after["functions"][target]
    require(function_config(actual) == function_config(expected), "FUNCTION_CONFIG_CHANGED")
    fixed_source(actual, target)
    require(actual["serviceConfig"]["revision"] != before["functions"][target]["serviceConfig"]["revision"],
            "REVISION_NOT_CHANGED")
    for name in TARGETS + SENTINELS:
        if name != target:
            require(before["functions"][name] == after["functions"][name], "UNRELATED_FUNCTION_CHANGED")
    for key in ("jobs", "triggers", "subscriptions", "iam", "projectIam"):
        require(before[key] == after[key], "PROTECTED_RESOURCE_CHANGED")
    for name in TARGETS:
        if name != target:
            require(stable_service(before["services"][name]) == stable_service(after["services"][name]),
                    "UNRELATED_RUN_SERVICE_CHANGED")


class Api:
    def __init__(self):
        self.credential = None
        self.expires = 0

    def headers(self):
        if time.monotonic() >= self.expires:
            result = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True,
                                    text=True, timeout=35)
            require(result.returncode == 0 and result.stdout.strip(), "AUTH_FAILED")
            self.credential = result.stdout.strip()
            self.expires = time.monotonic() + 900
        return {"Authorization": "Bearer " + self.credential, "Content-Type": "application/json"}

    def json(self, method, url, body=None):
        require(url.startswith((CF + PREFIX + "/", RUN + PREFIX + "/", SCHED + PREFIX + "/",
                                EVENT + PREFIX + "/", PUBSUB + f"projects/{PROJECT}/",
                                f"https://cloudresourcemanager.googleapis.com/v1/projects/{PROJECT}:")),
                "API_SCOPE_REJECTED")
        if method != "GET":
            permitted = (method == "POST" and url == CF + PREFIX + "/functions:generateUploadUrl") or (
                method == "POST" and url == f"https://cloudresourcemanager.googleapis.com/v1/projects/{PROJECT}:getIamPolicy") or (
                method == "PATCH" and any(url == CF + f"{PREFIX}/functions/{target}?updateMask={MASK}" for target in TARGETS))
            require(permitted, "API_MUTATION_REJECTED")
        request = urllib.request.Request(url, data=None if body is None else json.dumps(body).encode(),
                                         headers=self.headers(), method=method)
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise ValueError("API_HTTP_" + str(error.code)) from None
        except (OSError, TimeoutError):
            raise ValueError("API_RESULT_UNKNOWN_READ_BEFORE_RETRY") from None

    def download_source(self, fn, target):
        source = fixed_source(fn, target)
        url = ("https://storage.googleapis.com/storage/v1/b/" + SOURCE_BUCKET + "/o/"
               + urllib.parse.quote(source["object"], safe="") + "?alt=media&generation=" + str(source["generation"]))
        request = urllib.request.Request(url, headers=self.headers(), method="GET")
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                data = response.read(MAX_ARCHIVE + 1)
                require(len(data) <= MAX_ARCHIVE, "SOURCE_ARCHIVE_TOO_LARGE")
                return data
        except urllib.error.HTTPError as error:
            raise ValueError("SOURCE_HTTP_" + str(error.code)) from None


    def upload(self, url, data):
        parsed = urllib.parse.urlparse(url)
        require(parsed.scheme == "https" and parsed.hostname == "storage.googleapis.com"
                and parsed.port is None and parsed.username is None, "UPLOAD_HOST_REJECTED")
        # 署名URLにBearerを付けない。URLそのものも出力・保存しない。
        request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/zip"}, method="PUT")
        try:
            with urllib.request.urlopen(request, timeout=35) as response:
                require(response.status in (200, 201), "UPLOAD_FAILED")
        except urllib.error.HTTPError as error:
            raise ValueError("UPLOAD_HTTP_" + str(error.code)) from None


def collect(api):
    def function(name):
        return name, api.json("GET", CF + f"{PREFIX}/functions/{name}")
    with ThreadPoolExecutor(max_workers=4) as pool:
        functions = dict(pool.map(function, TARGETS + SENTINELS))
    result = {"functions": functions, "services": {}, "iam": {}, "triggers": {}, "subscriptions": {}}
    for name in TARGETS:
        url = RUN + f"{PREFIX}/services/{name.lower()}"
        result["services"][name] = api.json("GET", url)
        result["iam"][name] = api.json("GET", url + ":getIamPolicy?options.requestedPolicyVersion=3")
    jobs = api.json("GET", SCHED + f"{PREFIX}/jobs?pageSize=500")
    require(not jobs.get("nextPageToken"), "SCHEDULER_INVENTORY_INCOMPLETE")
    result["jobs"] = {job["name"]: stable_job(job) for job in jobs.get("jobs", [])}
    for name in EVENT_TARGETS:
        trigger_name = functions[name].get("eventTrigger", {}).get("trigger", "")
        require(trigger_name.startswith(f"{PREFIX}/triggers/"), "TRIGGER_MISSING")
        trigger = api.json("GET", EVENT + trigger_name)
        sub_name = trigger["transport"]["pubsub"]["subscription"]
        require(sub_name.startswith(f"projects/{PROJECT}/subscriptions/"), "SUBSCRIPTION_OUT_OF_SCOPE")
        result["triggers"][name] = trigger
        result["subscriptions"][name] = api.json("GET", PUBSUB + sub_name)
    result["projectIam"] = api.json("POST", f"https://cloudresourcemanager.googleapis.com/v1/projects/{PROJECT}:getIamPolicy",
                                    {"options": {"requestedPolicyVersion": 3}})
    return result


def snapshot_digest(snapshot):
    # 実行統計などの出力値を除き、承認時と直前の設定・版を照合する。
    stable = copy.deepcopy(snapshot)
    stable["services"] = {name: stable_service(service) for name, service in stable["services"].items()}
    return digest(stable)


def archive_source(root):
    root = Path(root).resolve()
    files = [root / "package.json", root / "tsconfig.json"]
    for folder in ("src", "lib", "case-mail-runtime"):
        files.extend(path for path in (root / folder).rglob("*") if path.is_file())
    require((root / "lib/index.js").is_file(), "BUILT_SOURCE_REQUIRED")
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
        for file in sorted(files):
            require(not file.is_symlink() and file.resolve().is_relative_to(root), "SOURCE_SYMLINK_REJECTED")
            rel = file.relative_to(root)
            require(not any(part.startswith(".") for part in rel.parts)
                    and file.suffix not in (".key", ".pem"), "SOURCE_FILE_REJECTED")
            archive.writestr(str(rel).replace("\\", "/"), file.read_bytes())
    return buffer.getvalue()


def migrate(api, before, target, source_sha, clearance, archive, record, sleep=time.sleep):
    validate_clearance(clearance, target, source_sha)
    validate_snapshot(before, target)
    require(snapshot_digest(before) == clearance["beforeSha256"], "BEFORE_CHANGED")
    expected_manifest = archive_manifest(archive)
    record({"status": "BEFORE_VERIFIED", "target": target, "sourceSha": source_sha,
            "beforeSha256": snapshot_digest(before), "archiveSha256": hashlib.sha256(archive).hexdigest()})
    upload = api.json("POST", CF + f"{PREFIX}/functions:generateUploadUrl", {"environment": "GEN_2"})
    api.upload(upload["uploadUrl"], archive)
    # upload中の構成変更も検知し、破壊的操作の直前に再照合する。
    fresh = collect(api)
    validate_clearance(clearance, target, source_sha)
    require(snapshot_digest(fresh) == clearance["beforeSha256"], "BEFORE_CHANGED_DURING_UPLOAD")
    validate_snapshot(fresh, target)
    body = patch_body(before["functions"][target], target, upload["storageSource"])
    record({"status": "PATCH_ATTEMPTING", "target": target, "sourceSha": source_sha})
    # 失敗・通信不明でPATCHを再送しない。旧版への自動復帰もしない。
    operation = api.json("PATCH", CF + body["name"] + "?updateMask=" + MASK, body)
    op_name = operation.get("name", "")
    require(op_name.startswith(PREFIX + "/operations/"), "OPERATION_SCOPE_MISMATCH")
    record({"status": "OPERATION_PENDING", "operation": op_name, "target": target})
    deadline = time.monotonic() + 1200
    while not operation.get("done"):
        require(time.monotonic() < deadline, "OPERATION_TIMEOUT_READ_BEFORE_RETRY")
        sleep(15)
        operation = api.json("GET", CF + op_name)
    require("error" not in operation, "OPERATION_FAILED_NO_ROLLBACK")
    after = collect(api)
    verify_after(before, after, target)
    deployed_manifest = archive_manifest(api.download_source(after["functions"][target], target))
    require(deployed_manifest == expected_manifest, "DEPLOYED_SOURCE_MISMATCH")
    record({"status": "VERIFIED", "target": target, "sourceSha": source_sha,
            "revision": after["functions"][target]["serviceConfig"]["revision"],
            "sourceManifestSha256": digest(deployed_manifest),
            "protectedResourcesUnchanged": True, "businessInvocation": False})


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--inspect", action="store_true")
    parser.add_argument("--target", required=True, choices=TARGETS)
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--evidence", required=True)
    args = parser.parse_args()
    require(os.environ.get("GITHUB_ACTIONS") == "true" and os.environ.get("GITHUB_REF") == "refs/heads/main"
            and os.environ.get("GITHUB_RUN_ATTEMPT") == "1", "PROTECTED_MAIN_WORKFLOW_REQUIRED")
    require(os.environ.get("LKC_CONFIRMATION") == CONFIRMATION, "CONFIRMATION_REQUIRED")
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    require(head == args.source_sha == os.environ.get("GITHUB_SHA"), "SOURCE_IDENTITY_MISMATCH")
    remote = subprocess.check_output(["git", "ls-remote", "origin", "refs/heads/main"], text=True, timeout=35)
    require(remote.split()[0] == head, "MAIN_MOVED")
    require(not subprocess.check_output(["git", "diff", "HEAD", "--name-only"], text=True).strip(),
            "TRACKED_SOURCE_CHANGED")
    evidence = Path(args.evidence)
    require(not evidence.exists(), "EXISTING_ATTEMPT_READ_BEFORE_RETRY")
    evidence.mkdir(parents=True, mode=0o700)
    api = Api()
    api.headers()
    before = collect(api)
    # 生の構成・環境変数・IAMは公開artifactへ出さない。
    (evidence / "before-private.json").write_text(json.dumps(before), encoding="utf-8")
    if args.inspect:
        status = "CONFIGURATION_READY_NOT_AUTHORIZED"
        try:
            validate_snapshot(before, args.target)
        except ValueError as error:
            status = str(error)
        report = {"status": status, "beforeSha256": snapshot_digest(before), "target": args.target,
                  "sourceSha": head, "cloudMutation": False, "executionDrainProven": False}
        (evidence / "summary.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(report))
        return
    clearance = json.loads(os.environ.get("LKC_MIGRATION_CLEARANCE", "{}"))
    records = []
    def record(value):
        records.append(value)
        (evidence / "summary.json").write_text(json.dumps({"events": records}, indent=2) + "\n", encoding="utf-8")
    try:
        migrate(api, before, args.target, head, clearance, archive_source("functions"), record)
    except Exception:
        record({"status": "STOPPED_NO_RETRY_NO_ROLLBACK", "target": args.target})
        raise
    print("WORKER_MIGRATION=VERIFIED")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        # クラウドの応答本文・署名URL・認証値を例外経由でも表示しない。
        code = str(error) if isinstance(error, ValueError) and re.fullmatch(r"[A-Z0-9_]+", str(error)) else type(error).__name__
        print("WORKER_MIGRATION_ERROR=" + code, file=sys.stderr)
        sys.exit(1)
