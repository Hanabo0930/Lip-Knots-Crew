#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

EXPECTED_ACCOUNT='info@lipknots.com'
EXPECTED_PROJECT='lip-knots-crew-staging'
EXPECTED_COMPANY_ID='lipknots-staging'
EXPECTED_CONFIRMATION='PROVISION_LKC_STAGING_GMAIL_SMOKE_RECIPIENT'
DELEGATED_SENDER='info@lipknots.com'
STAFF_ID='staging-gmail-smoke-recipient'

RECIPIENT_EMAIL="${LKC_GMAIL_SMOKE_RECIPIENT_EMAIL:-}"
CONFIRMATION="${LKC_CONFIRMATION:-}"
MUTATION_ATTEMPTED=false

fail() {
  printf 'ERROR=%s\n' "$1"
  if [[ "$MUTATION_ATTEMPTED" == 'true' ]]; then
    printf 'FIRESTORE_CHANGED=NOT_CONFIRMED\n'
  else
    printf 'FIRESTORE_CHANGED=false\n'
  fi
  exit 1
}

[[ "$CONFIRMATION" == "$EXPECTED_CONFIRMATION" ]] || fail 'CONFIRMATION_REQUIRED'
[[ "$RECIPIENT_EMAIL" =~ ^info\+lkc-staging-smoke([+.-][a-z0-9_-]+)?@lipknots\.com$ ]] \
  || fail 'RECIPIENT_NOT_DEDICATED_STAGING_ALIAS'
[[ "${RECIPIENT_EMAIL,,}" != "$DELEGATED_SENDER" ]] \
  || fail 'SENDER_RECIPIENT_NOT_SEPARATED'

ACTIVE_ACCOUNT="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -n 1)"
ACTIVE_PROJECT="$(gcloud config get-value project 2>/dev/null)"
[[ "$ACTIVE_ACCOUNT" == "$EXPECTED_ACCOUNT" ]] || fail 'WRONG_ACCOUNT'
[[ "$ACTIVE_PROJECT" == "$EXPECTED_PROJECT" ]] || fail 'WRONG_PROJECT'
[[ ! "$ACTIVE_PROJECT" =~ prod(uction)? ]] || fail 'PRODUCTION_PROJECT_REJECTED'

BACKUP_DIR="$HOME/lkc-change-backups/staging-gmail-smoke-recipient-$(date -u +%Y%m%dT%H%M%SZ)"
WORK_DIR="$(mktemp -d /tmp/lkc-gmail-smoke-recipient.XXXXXX)"
mkdir -p "$BACKUP_DIR"

cleanup() {
  if [[ "${WORK_DIR:-}" == /tmp/lkc-gmail-smoke-recipient.* && -d "${WORK_DIR:-}" ]]; then
    rm -rf -- "$WORK_DIR"
  fi
}
trap cleanup EXIT

ACCESS_TOKEN="$(gcloud auth print-access-token)"
[[ -n "$ACCESS_TOKEN" ]] || fail 'ACCESS_TOKEN_UNAVAILABLE'

RECIPIENT_HASH="$(
  printf '%s' "${RECIPIENT_EMAIL,,}" \
    | sha256sum \
    | awk '{print $1}'
)"
[[ "$RECIPIENT_HASH" =~ ^[0-9a-f]{64}$ ]] || fail 'RECIPIENT_HASH_INVALID'

FIRESTORE_ROOT="https://firestore.googleapis.com/v1/projects/${EXPECTED_PROJECT}/databases/(default)/documents"
PROFILE_URL="${FIRESTORE_ROOT}/staffProfiles/${STAFF_ID}"
INDEX_URL="${FIRESTORE_ROOT}/emailIndex/${RECIPIENT_HASH}"
PROFILE_BACKUP="$BACKUP_DIR/staff-profile-before.json"
INDEX_BACKUP="$BACKUP_DIR/email-index-before.json"

read_document() {
  local url="$1"
  local output="$2"
  curl \
    --silent \
    --show-error \
    --max-time 30 \
    --header "Authorization: Bearer $ACCESS_TOKEN" \
    --output "$output" \
    --write-out '%{http_code}' \
    "$url"
}

PROFILE_STATUS="$(read_document "$PROFILE_URL" "$PROFILE_BACKUP")"
INDEX_STATUS="$(read_document "$INDEX_URL" "$INDEX_BACKUP")"
[[ "$PROFILE_STATUS" == '200' || "$PROFILE_STATUS" == '404' ]] \
  || fail 'PROFILE_READ_FAILED'
[[ "$INDEX_STATUS" == '200' || "$INDEX_STATUS" == '404' ]] \
  || fail 'EMAIL_INDEX_READ_FAILED'

python3 - \
  "$PROFILE_BACKUP" \
  "$PROFILE_STATUS" \
  "$INDEX_BACKUP" \
  "$INDEX_STATUS" \
  "$EXPECTED_COMPANY_ID" \
  "$STAFF_ID" \
  "${RECIPIENT_EMAIL,,}" <<'PY_VALIDATE_EXISTING'
import json
import sys

(
    profile_path,
    profile_status,
    index_path,
    index_status,
    company_id,
    staff_id,
    recipient_email,
) = sys.argv[1:]

def fields(path):
    with open(path, encoding="utf-8") as handle:
        return (json.load(handle).get("fields", {}) or {})

def string(data, name):
    return (data.get(name, {}) or {}).get("stringValue", "")

def boolean(data, name):
    return (data.get(name, {}) or {}).get("booleanValue")

if profile_status == "200":
    profile = fields(profile_path)
    if (
        string(profile, "companyId") != company_id
        or string(profile, "primaryEmail") != recipient_email
        or boolean(profile, "active") is not True
    ):
        raise SystemExit("EXISTING_PROFILE_CONFLICT")

if index_status == "200":
    index = fields(index_path)
    if (
        string(index, "companyId") != company_id
        or string(index, "staffId") != staff_id
        or string(index, "email") != recipient_email
        or boolean(index, "active") is not True
    ):
        raise SystemExit("EXISTING_EMAIL_INDEX_CONFLICT")
PY_VALIDATE_EXISTING

if [[ "$PROFILE_STATUS" == '200' && "$INDEX_STATUS" == '200' ]]; then
  printf 'PROJECT=%s\n' "$EXPECTED_PROJECT"
  printf 'STAFF_ID=%s\n' "$STAFF_ID"
  printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
  printf 'FIRESTORE_DOCUMENTS_CHANGED=0\n'
  printf 'EMAIL_SENT=false\n'
  printf 'LKC_STAGING_GMAIL_SMOKE_RECIPIENT_ALREADY_PROVISIONED\n'
  exit 0
fi

COMMIT_BODY="$WORK_DIR/commit.json"
COMMIT_RESPONSE="$WORK_DIR/commit-response.json"
python3 - \
  "$COMMIT_BODY" \
  "$EXPECTED_PROJECT" \
  "$EXPECTED_COMPANY_ID" \
  "$STAFF_ID" \
  "${RECIPIENT_EMAIL,,}" \
  "$RECIPIENT_HASH" \
  "$PROFILE_STATUS" \
  "$INDEX_STATUS" <<'PY_COMMIT_BODY'
import json
import sys

(
    path,
    project,
    company_id,
    staff_id,
    email,
    email_hash,
    profile_status,
    index_status,
) = sys.argv[1:]

root = f"projects/{project}/databases/(default)/documents"
profile_fields = {
    "companyId": {"stringValue": company_id},
    "displayName": {"stringValue": "Staging Gmail Smoke"},
    "normalizedName": {"stringValue": "staginggmailsmoke"},
    "emails": {"arrayValue": {"values": [{"stringValue": email}]}},
    "primaryEmail": {"stringValue": email},
    "emailCount": {"integerValue": "1"},
    "active": {"booleanValue": True},
    "sourceMissing": {"booleanValue": False},
    "source": {"stringValue": "staging.gmail_smoke.bootstrap"},
    "rank": {"stringValue": "TEST"},
}
index_fields = {
    "companyId": {"stringValue": company_id},
    "staffId": {"stringValue": staff_id},
    "email": {"stringValue": email},
    "active": {"booleanValue": True},
    "source": {"stringValue": "staging.gmail_smoke.bootstrap"},
}

document = {
    "writes": [
        {
            "update": {
                "name": f"{root}/staffProfiles/{staff_id}",
                "fields": profile_fields,
            },
            "currentDocument": {"exists": profile_status == "200"},
        },
        {
            "update": {
                "name": f"{root}/emailIndex/{email_hash}",
                "fields": index_fields,
            },
            "currentDocument": {"exists": index_status == "200"},
        },
    ]
}
with open(path, "w", encoding="utf-8") as handle:
    json.dump(document, handle, ensure_ascii=False, separators=(",", ":"))
    handle.write("\n")
PY_COMMIT_BODY

MUTATION_ATTEMPTED=true
COMMIT_STATUS="$(
  curl \
    --silent \
    --show-error \
    --max-time 30 \
    --request POST \
    --header "Authorization: Bearer $ACCESS_TOKEN" \
    --header 'Content-Type: application/json' \
    --data-binary "@$COMMIT_BODY" \
    --output "$COMMIT_RESPONSE" \
    --write-out '%{http_code}' \
    "https://firestore.googleapis.com/v1/projects/${EXPECTED_PROJECT}/databases/(default)/documents:commit"
)"
[[ "$COMMIT_STATUS" == '200' ]] || fail 'ATOMIC_COMMIT_FAILED'

PROFILE_VERIFY="$WORK_DIR/staff-profile-after.json"
INDEX_VERIFY="$WORK_DIR/email-index-after.json"
[[ "$(read_document "$PROFILE_URL" "$PROFILE_VERIFY")" == '200' ]] \
  || fail 'PROFILE_VERIFY_READ_FAILED'
[[ "$(read_document "$INDEX_URL" "$INDEX_VERIFY")" == '200' ]] \
  || fail 'EMAIL_INDEX_VERIFY_READ_FAILED'

python3 - \
  "$PROFILE_VERIFY" \
  "$INDEX_VERIFY" \
  "$EXPECTED_COMPANY_ID" \
  "$STAFF_ID" \
  "${RECIPIENT_EMAIL,,}" <<'PY_VERIFY'
import json
import sys

profile_path, index_path, company_id, staff_id, email = sys.argv[1:]

def fields(path):
    with open(path, encoding="utf-8") as handle:
        return (json.load(handle).get("fields", {}) or {})

def string(data, name):
    return (data.get(name, {}) or {}).get("stringValue", "")

def boolean(data, name):
    return (data.get(name, {}) or {}).get("booleanValue")

profile = fields(profile_path)
index = fields(index_path)
if not (
    string(profile, "companyId") == company_id
    and string(profile, "primaryEmail") == email
    and boolean(profile, "active") is True
    and string(index, "companyId") == company_id
    and string(index, "staffId") == staff_id
    and string(index, "email") == email
    and boolean(index, "active") is True
):
    raise SystemExit("POST_WRITE_VERIFICATION_FAILED")
PY_VERIFY

printf 'PROJECT=%s\n' "$EXPECTED_PROJECT"
printf 'STAFF_ID=%s\n' "$STAFF_ID"
printf 'BACKUP_DIR=%s\n' "$BACKUP_DIR"
printf 'FIRESTORE_DOCUMENTS_CHANGED=2\n'
printf 'HOSTING_CHANGED=false\n'
printf 'FUNCTIONS_CHANGED=false\n'
printf 'IAM_CHANGED=false\n'
printf 'STORAGE_CHANGED=false\n'
printf 'PRODUCTION_CHANGED=false\n'
printf 'EMAIL_SENT=false\n'
printf 'LKC_STAGING_GMAIL_SMOKE_RECIPIENT_PROVISIONED\n'
