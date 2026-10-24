import assert from "node:assert/strict";
import {after, before, test} from "node:test";
import {diagnoseStaffAccount} from "./hosting-staff-account-diagnostic.mjs";
import {validateLimitedPilotPreflight} from "./hosting-limited-pilot.mjs";

let savedFetch;
before(() => {
  savedFetch = globalThis.fetch;
  globalThis.fetch = () => {throw new Error("OFFLINE_FIXTURE_NETWORK_FORBIDDEN");};
});
after(() => {globalThis.fetch = savedFetch;});

// Synthetic judgments only; never operational account records.
const missingBinding = () => ({
  authUser: "FOUND", emailIndex: "NOT_FOUND", authIdentity: "NOT_FOUND",
  staffProfile: "UNKNOWN", staffClaims: "UNKNOWN", deployedAdminMembership: "UNKNOWN",
});
const observed = () => ({
  authUser: "FOUND", emailIndex: "FOUND", authIdentity: "FOUND",
  staffProfile: "MATCHED_ACTIVE", staffClaims: "EXACT_STAFF_MATCH", deployedAdminMembership: "EXCLUDED",
});
const invariant = result => {
  assert.equal(result.diagnosticOnly, true);
  assert.equal(result.authenticatedAcceptance, "UNVERIFIED");
  assert.deepEqual(Object.keys(result).sort(),
    ["authenticatedAcceptance", "diagnosticOnly", "information", "observations", "reasons", "states"]);
  assert.equal(Object.values(result).filter(value => value === true).length, 1);
  assert.doesNotMatch(JSON.stringify(result), /STAFF_READY|PERMISSION_DENIED|INVALID_USER|GRANTED/);
};
const invalid = value => assert.throws(() => diagnoseStaffAccount(value), error => {
  assert.equal(error.message, "STAFF_ACCOUNT_DIAGNOSTIC_INPUT_INVALID");
  assert.equal(error.cause, undefined);
  assert.deepEqual(Object.keys(error), []);
  const exposed = String(error) + "\n" + error.stack + "\n" + JSON.stringify(error);
  for (const canary of ["synthetic-person@example.invalid", "synthetic-sensitive-uid",
    "synthetic-role", "synthetic-staff", "synthetic-company", "synthetic-value"]) {
    assert.equal(exposed.includes(canary), false);
  }
  return true;
});

test("found Auth, absent Staff index and unknown profile/role remain separate from login history", () => {
  const result = diagnoseStaffAccount(missingBinding());
  assert.deepEqual(result.states, ["AUTH_FOUND", "STAFF_BINDING_MISSING", "PROFILE_UNVERIFIED", "ROLE_UNVERIFIED"]);
  assert.deepEqual(result.reasons, ["EMAIL_INDEX_NOT_FOUND",
    "PROFILE_REFERENCE_UNRESOLVED", "PROFILE_UNVERIFIED", "STAFF_CLAIMS_UNVERIFIED", "DEPLOYED_ADMIN_MEMBERSHIP_UNVERIFIED"]);
  assert.deepEqual(result.information, ["LOGIN_HISTORY_ABSENT"]);
  invariant(result);
});

test("omitted observations stay unknown, with no assertion of absence or access denial", () => {
  const result = diagnoseStaffAccount();
  assert.deepEqual(result.states, ["AUTH_UNVERIFIED", "STAFF_BINDING_UNVERIFIED", "PROFILE_UNVERIFIED", "ROLE_UNVERIFIED"]);
  assert.ok(Object.values(result.observations).every(value => value === "UNKNOWN"));
  assert.deepEqual(result.information, ["LOGIN_HISTORY_UNVERIFIED"]);
  assert.doesNotMatch(JSON.stringify(result), /NOT_FOUND|MISSING|DENIED/);
  invariant(result);
});

test("27 Auth/index/history combinations keep Staff binding independent of login history", () => {
  for (const authUser of ["FOUND", "NOT_FOUND", "UNKNOWN"])
    for (const emailIndex of ["FOUND", "NOT_FOUND", "UNKNOWN"])
      for (const authIdentity of ["FOUND", "NOT_FOUND", "UNKNOWN"]) {
        const result = diagnoseStaffAccount({authUser, emailIndex, authIdentity});
        assert.equal(result.states[0], authUser === "FOUND" ? "AUTH_FOUND"
          : authUser === "NOT_FOUND" ? "AUTH_NOT_FOUND" : "AUTH_UNVERIFIED");
        assert.equal(result.states[1], emailIndex === "NOT_FOUND" ? "STAFF_BINDING_MISSING"
          : emailIndex === "FOUND" ? "STAFF_BINDING_OBSERVED" : "STAFF_BINDING_UNVERIFIED");
        assert.equal(result.reasons.includes("EMAIL_INDEX_NOT_FOUND"), emailIndex === "NOT_FOUND");
        assert.deepEqual(result.information, [authIdentity === "FOUND" ? "LOGIN_HISTORY_OBSERVED"
          : authIdentity === "NOT_FOUND" ? "LOGIN_HISTORY_ABSENT" : "LOGIN_HISTORY_UNVERIFIED"]);
        const reference = diagnoseStaffAccount({authUser, emailIndex, authIdentity: "FOUND"});
        assert.deepEqual(result.states, reference.states);
        assert.deepEqual(result.reasons, reference.reasons);
        invariant(result);
      }
});

test("first Staff login needs no authIdentity when index/profile/claims/Admin exclusion are observed", () => {
  const result = diagnoseStaffAccount({...observed(), authIdentity: "NOT_FOUND"});
  assert.deepEqual(result.states, ["AUTH_FOUND", "STAFF_BINDING_OBSERVED", "PROFILE_OBSERVED", "ROLE_OBSERVED"]);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.information, ["LOGIN_HISTORY_ABSENT"]);
  invariant(result);
});

test("profile target must resolve through a found emailIndex before a profile judgment", () => {
  for (const emailIndex of ["NOT_FOUND", "UNKNOWN"])
    for (const staffProfile of ["NOT_FOUND", "MATCHED_ACTIVE", "INACTIVE_OR_MISMATCH"])
      invalid({...missingBinding(), emailIndex, staffProfile});
});

test("resolved profile absence, mismatch and unknown are separate reasons", () => {
  for (const [staffProfile, reason] of [["NOT_FOUND", "PROFILE_NOT_FOUND"],
    ["INACTIVE_OR_MISMATCH", "PROFILE_INACTIVE_OR_MISMATCH"], ["UNKNOWN", "PROFILE_UNVERIFIED"]]) {
    const result = diagnoseStaffAccount({...observed(), staffProfile});
    assert.equal(result.states[2], "PROFILE_UNVERIFIED");
    assert.deepEqual(result.reasons, [reason]);
    invariant(result);
  }
});

test("nine role combinations require both exact Staff claims and observed deployed Admin exclusion", () => {
  for (const staffClaims of ["EXACT_STAFF_MATCH", "MISMATCH", "UNKNOWN"])
    for (const deployedAdminMembership of ["EXCLUDED", "INCLUDED", "UNKNOWN"]) {
      const result = diagnoseStaffAccount({...observed(), staffClaims, deployedAdminMembership});
      assert.equal(result.states[3], staffClaims === "EXACT_STAFF_MATCH" && deployedAdminMembership === "EXCLUDED"
        ? "ROLE_OBSERVED" : "ROLE_UNVERIFIED");
      assert.equal(result.reasons.includes("STAFF_CLAIMS_MISMATCH"), staffClaims === "MISMATCH");
      assert.equal(result.reasons.includes("DEPLOYED_ADMIN_INCLUDED"), deployedAdminMembership === "INCLUDED");
      invariant(result);
    }
});

test("all supplied observations still do not prove authenticated acceptance or generate validator booleans", () => {
  const result = diagnoseStaffAccount(observed());
  assert.deepEqual(result.states, ["AUTH_FOUND", "STAFF_BINDING_OBSERVED", "PROFILE_OBSERVED", "ROLE_OBSERVED"]);
  assert.deepEqual(result.reasons, []);
  assert.deepEqual(result.information, ["LOGIN_HISTORY_OBSERVED"]);
  for (const field of ["existingDedicatedStaff", "emailVerified", "activeProfileAndEmailIndex",
    "exactExistingStaffClaims", "excludedFromAdminEmails", "gatewayNonproduction", "account"]) {
    assert.equal(Object.hasOwn(result, field), false);
    assert.equal(Object.hasOwn(result.observations, field), false);
  }
  invariant(result);
});

test("input is unchanged, output does not alias it, and repeated calls are deterministic", () => {
  const input = Object.freeze(missingBinding()), before = JSON.stringify(input);
  const first = diagnoseStaffAccount(input), second = diagnoseStaffAccount(input);
  assert.deepEqual(first, second);
  first.states.push("SYNTHETIC_MUTATION"); first.observations.authUser = "NOT_FOUND";
  assert.equal(JSON.stringify(input), before);
  assert.deepEqual(diagnoseStaffAccount(input), second);
  assert.deepEqual(diagnoseStaffAccount(Object.assign(Object.create(null), input)), second);
});

test("unexpected personal fields are rejected without echoing their keys or values", () => {
  for (const extra of [
    {email: "synthetic-person@example.invalid"}, {uid: "synthetic-sensitive-uid"},
    {customClaims: {role: "synthetic-role", staffId: "synthetic-staff", companyId: "synthetic-company"}},
    {"synthetic-person@example.invalid": "synthetic-value"},
  ]) invalid({...observed(), ...extra});
});

test("raw bodies and unknown values in allowed fields never get serialized into errors", () => {
  for (const field of Object.keys(observed())) {
    for (const value of ["synthetic-person@example.invalid", {uid: "synthetic-sensitive-uid"}, true, false, null, 1, []]) {
      invalid({...observed(), [field]: value});
    }
  }
  for (const input of [null, [], "synthetic-sensitive-uid", 1, true, new Date(0)]) invalid(input);
});

test("accessors, conversion hooks and thrown object traps cannot expose input", () => {
  let calls = 0;
  invalid(Object.defineProperty({}, "authUser", {get() {calls++; throw new Error("synthetic-sensitive-uid");}}));
  invalid({authUser: {toString() {calls++; throw new Error("synthetic-person@example.invalid");}}});
  assert.equal(calls, 0);
  invalid(new Proxy({}, {getPrototypeOf() {throw new Error("synthetic-person@example.invalid");}}));
  const {proxy, revoke} = Proxy.revocable({}, {}); revoke(); invalid(proxy);
  invalid({[Symbol("synthetic-sensitive-uid")]: "FOUND"});
});

// Minimal synthetic envelope that reaches the unchanged account gate.
// Deliberately incomplete after that gate: this is not usable release evidence.
function rejectedAccountEnvelope() {
  const digest = "sha256:" + "b".repeat(64), sha = "a".repeat(40);
  return {schemaVersion: 1, policy: "limited-staff-pilot", projectId: "lip-knots-crew-staging",
    region: "asia-northeast1", sourceSha: sha, pilotId: "1".repeat(32),
    createdAt: "2026-10-24T00:00:00.000Z", expiresAt: "2026-10-24T02:00:00.000Z",
    sourceAuthenticity: "UNVERIFIED", submissionAcceptance: "UNVERIFIED",
    review: {recordDigest: digest,
      cost: {actions: "NO_ADDITIONAL_COST", hosting: "NO_ADDITIONAL_COST", apiAndFirestore: "NO_ADDITIONAL_COST", evidenceDigest: digest},
      account: {identityDigest: digest, existingDedicatedStaff: true, emailVerified: true,
        activeProfileAndEmailIndex: false, exactExistingStaffClaims: false,
        excludedFromAdminEmails: false, gatewayNonproduction: true, evidenceDigest: digest},
      scope: {}, mail: {}, previewAuth: {}, recovery: {}},
    hosting: {previewRunId: "123", previewRunAttempt: 1,
      previewVersions: {staff: "1".repeat(16), admin: "2".repeat(16)},
      previousVersions: {staff: "3".repeat(16), admin: "4".repeat(16)}},
    functions: {}};
}
const preflight = evidence => validateLimitedPilotPreflight(evidence,
  {sourceSha: "a".repeat(40), now: "2026-10-24T01:00:00.000Z"});

test("diagnosis leaves the original PILOT_EXISTING_STAFF_ACCOUNT_REQUIRED stop intact", () => {
  const evidence = rejectedAccountEnvelope(), before = JSON.stringify(evidence);
  assert.throws(() => preflight(evidence), {message: "PILOT_EXISTING_STAFF_ACCOUNT_REQUIRED"});
  diagnoseStaffAccount(missingBinding());
  diagnoseStaffAccount(observed());
  assert.equal(JSON.stringify(evidence), before);
  assert.throws(() => preflight(evidence), {message: "PILOT_EXISTING_STAFF_ACCOUNT_REQUIRED"});
});

test("diagnostic output cannot replace or augment the validator account evidence", () => {
  for (const input of [missingBinding(), observed()]) {
    const evidence = rejectedAccountEnvelope();
    evidence.review.account = diagnoseStaffAccount(input);
    assert.throws(() => preflight(evidence), {message: "PILOT_FIELDS_REJECTED"});
    const augmented = rejectedAccountEnvelope();
    Object.assign(augmented.review.account, diagnoseStaffAccount(input));
    assert.throws(() => preflight(augmented), {message: "PILOT_FIELDS_REJECTED"});
  }
});
