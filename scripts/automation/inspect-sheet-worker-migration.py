"""書戻しworkerの移行前メタデータ点検。配備・業務API・キュー操作は実装しない。"""
import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

PROJECT = "lip-knots-crew-staging"
REGION = "asia-northeast1"
FUNCTIONS = ("processSafeSheetWrite", "retrySafeSheetWrites")
JOB = "firebase-schedule-retrySafeSheetWrites-asia-northeast1"
PREFIX = f"projects/{PROJECT}/locations/{REGION}"
FUNCTION_FIELDS = "name,state,updateTime,serviceConfig.service,serviceConfig.revision,serviceConfig.timeoutSeconds,serviceConfig.environmentVariables.LKC_SHEET_WRITE_MODE"
SERVICE_FIELDS = "metadata.name,status.latestReadyRevisionName,status.latestCreatedRevisionName,status.traffic,status.conditions"
JOB_FIELDS = "name,state,schedule,timeZone"


def read_commands():
    """任意コマンドを受け付けず、読取対象と投影項目を固定する。"""
    commands = {}
    for name in FUNCTIONS:
        commands[f"function:{name}"] = ["functions", "describe", name, "--gen2", f"--project={PROJECT}", f"--region={REGION}", f"--format=json({FUNCTION_FIELDS})"]
        commands[f"service:{name}"] = ["run", "services", "describe", name.lower(), f"--project={PROJECT}", f"--region={REGION}", f"--format=json({SERVICE_FIELDS})"]
    commands["schedulers"] = ["scheduler", "jobs", "list", f"--project={PROJECT}", f"--location={REGION}", f"--format=json({JOB_FIELDS})"]
    return commands


def read_one(executable, args, run=subprocess.run):
    try:
        completed = run([executable, *args], stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return {"status": "error", "reason": "READ_FAILED"}
    if completed.returncode:
        # stderr本文はアカウント等を含み得るため、保存・表示しない。
        error = completed.stderr.decode("utf-8", errors="replace")
        missing_service = (args[:3] == ["run", "services", "describe"] and len(args) > 3
                           and re.fullmatch(r"ERROR: \(gcloud\.run\.services\.describe\) Cannot find service \["
                                            + re.escape(args[3]) + r"\]\.?", error.strip()))
        if (re.search(r"\bNOT_FOUND\b", error) or missing_service) and not re.search(r"PERMISSION_DENIED|UNAUTHENTICATED", error):
            return {"status": "not_found"}
        return {"status": "error", "reason": "READ_REJECTED"}
    try:
        data = json.loads(completed.stdout.decode("utf-8-sig"))
    except (ValueError, UnicodeError):
        return {"status": "error", "reason": "INVALID_JSON"}
    return {"status": "found", "data": data}


def collect(executable):
    started = datetime.now(timezone.utc).isoformat()
    resources = {key: read_one(executable, args) for key, args in read_commands().items()}
    return {"schemaVersion": 1, "project": PROJECT, "region": REGION,
            "startedAt": started, "finishedAt": datetime.now(timezone.utc).isoformat(), "resources": resources}


def assess(snapshot, policy):
    """記録の分類。成功結果を配備許可や旧実行終了の証明にはしない。"""
    if not isinstance(snapshot, dict) or snapshot.get("schemaVersion") != 1:
        raise ValueError("SNAPSHOT_SCHEMA_INVALID")
    if snapshot.get("project") != PROJECT or snapshot.get("region") != REGION:
        raise ValueError("SNAPSHOT_SCOPE_INVALID")
    if not isinstance(policy, dict) or policy.get("projectId") != PROJECT or policy.get("region") != REGION:
        raise ValueError("POLICY_SCOPE_INVALID")
    allowed = policy.get("allowedFunctions")
    if not isinstance(allowed, list) or any(not isinstance(x, str) for x in allowed):
        raise ValueError("POLICY_FUNCTIONS_INVALID")
    resources = snapshot.get("resources")
    if not isinstance(resources, dict):
        raise ValueError("RESOURCES_INVALID")
    findings = []
    def add(code, resource):
        findings.append({"code": code, "resource": resource})
    def data_for(key, expected_type=dict):
        record = resources.get(key)
        if not isinstance(record, dict):
            add("OBSERVATION_MISSING", key)
            return None
        status = record.get("status")
        if status == "not_found":
            add("RESOURCE_MISSING", key)
            return None
        if status != "found":
            add("OBSERVATION_FAILED", key)
            return None
        data = record.get("data")
        if not isinstance(data, expected_type) or (expected_type is dict and not data):
            add("OBSERVATION_INVALID", key)
            return None
        return data
    for name in FUNCTIONS:
        if name not in allowed:
            add("FUNCTION_OUTSIDE_ALLOWLIST", name)
        function = data_for(f"function:{name}")
        service = data_for(f"service:{name}")
        revision = None
        if function is not None:
            if function.get("name") != f"{PREFIX}/functions/{name}":
                add("RESOURCE_IDENTITY_MISMATCH", f"function:{name}")
            if function.get("state") != "ACTIVE":
                add("FUNCTION_NOT_ACTIVE", name)
            config = function.get("serviceConfig")
            config = config if isinstance(config, dict) else {}
            if config.get("service") != f"{PREFIX}/services/{name.lower()}":
                add("FUNCTION_SERVICE_MISMATCH", name)
            revision = config.get("revision")
            if not isinstance(revision, str) or not revision.startswith(name.lower() + "-"):
                add("FUNCTION_REVISION_MISSING", name)
                revision = None
            env = config.get("environmentVariables")
            mode = env.get("LKC_SHEET_WRITE_MODE") if isinstance(env, dict) else None
            if mode != "paused":
                add("EXPLICIT_PAUSE_NOT_OBSERVED", name)
        if service is not None:
            metadata = service.get("metadata")
            if not isinstance(metadata, dict) or metadata.get("name") != name.lower():
                add("RESOURCE_IDENTITY_MISMATCH", f"service:{name}")
            status = service.get("status")
            status = status if isinstance(status, dict) else {}
            conditions = status.get("conditions")
            ready = [x for x in conditions if isinstance(x, dict) and x.get("type") == "Ready"] if isinstance(conditions, list) else []
            if len(ready) != 1 or ready[0].get("status") != "True":
                add("SERVICE_NOT_READY", name)
            if not revision or status.get("latestReadyRevisionName") != revision or status.get("latestCreatedRevisionName") != revision:
                add("FUNCTION_SERVICE_REVISION_MISMATCH", name)
            traffic = status.get("traffic")
            # tag付き旧revisionへの到達可能性も別途残るため、混在を合格にしない。
            if not isinstance(traffic, list) or len(traffic) != 1 or not isinstance(traffic[0], dict) or not revision or traffic[0].get("revisionName") != revision or type(traffic[0].get("percent")) is not int or traffic[0]["percent"] != 100 or traffic[0].get("tag"):
                add("TRAFFIC_NOT_SINGLE_VERIFIED_REVISION", name)
    jobs = data_for("schedulers", list)
    other_jobs = []
    if jobs is not None:
        valid = all(isinstance(x, dict) and isinstance(x.get("name"), str) and x["name"].startswith(f"{PREFIX}/jobs/") for x in jobs)
        names = [x["name"] for x in jobs] if valid else []
        if not valid or len(names) != len(set(names)):
            add("SCHEDULER_INVENTORY_INVALID", "schedulers")
        else:
            expected = [x for x in jobs if x["name"] == f"{PREFIX}/jobs/{JOB}"]
            if not expected:
                add("RETRY_SCHEDULER_MISSING", JOB)
            else:
                job = expected[0]
                if job.get("state") != "PAUSED":
                    add("RETRY_SCHEDULER_NOT_PAUSED", JOB)
                if job.get("schedule") not in ("every 5 minutes", "*/5 * * * *") or job.get("timeZone") != "Asia/Tokyo":
                    add("RETRY_SCHEDULER_CONFIG_MISMATCH", JOB)
            other_jobs = [{"name": x["name"].rsplit("/", 1)[-1], "state": x.get("state", "UNKNOWN")} for x in jobs if x["name"] != f"{PREFIX}/jobs/{JOB}"]
    return {"schemaVersion": 1, "advisoryOnly": True, "deploymentAuthorized": False,
            "metadataChecksPassed": not findings, "findings": findings, "otherSchedulers": other_jobs,
            "unverified": ["CURRENT_MAIN_AND_CI", "DEPLOYED_SOURCE_IDENTITY", "SOURCE_PAUSE_GUARD", "INVOKER_AND_TRIGGER_AUTHORIZATION", "SCHEDULER_TARGET_AND_AUTH", "NEW_EVENT_DELIVERY_CONTROL", "OLD_REVISION_EXECUTION_DRAIN", "BACKUP_AND_RECOVERY", "OTHER_WRITERS_AND_LEGACY_NOTIFICATIONS"],
            "limitations": "Point-in-time metadata only; no business records read; no runtime quiescence or deployment permission is established."}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--collect", action="store_true", help="固定STAGINGのdescribe/listだけを実行")
    mode.add_argument("--snapshot", type=Path, help="保存済みmetadataをオフライン判定")
    parser.add_argument("--evidence", type=Path, required=True, help="未使用のCローカル等の証跡フォルダ")
    args = parser.parse_args(argv)
    if args.evidence.exists():
        parser.error("EVIDENCE_DIRECTORY_ALREADY_EXISTS")
    executable = shutil.which("gcloud") if args.collect else None
    if args.collect and not executable:
        parser.error("GCLOUD_NOT_FOUND")
    # cloud読取より先に保存先を確保し、既存証跡の上書きを避ける。
    args.evidence.mkdir(parents=True, exist_ok=False)
    snapshot = collect(executable) if args.collect else json.loads(args.snapshot.read_text(encoding="utf-8-sig"))
    root = Path(__file__).resolve().parents[2]
    policy = json.loads((root / "config/automation/staging-safety.json").read_text(encoding="utf-8-sig"))
    result = assess(snapshot, policy)
    for name, data in (("snapshot.json", snapshot), ("assessment.json", result)):
        (args.evidence / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"metadataChecksPassed": result["metadataChecksPassed"], "findings": result["findings"], "deploymentAuthorized": False}, ensure_ascii=False))
    return 0 if result["metadataChecksPassed"] else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (ValueError, OSError) as error:
        print("INSPECTION_FAILED:" + type(error).__name__, file=sys.stderr)
        sys.exit(1)
