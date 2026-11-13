/**
 * Explain supplied, non-secret account observations only.
 * No reads, permissions, readiness flags, or validator input are produced.
 * Omitted observations mean UNKNOWN; NOT_FOUND requires a completed exact read.
 */
const existence = ["FOUND", "NOT_FOUND", "UNKNOWN"];
const fields = {
  authUser: existence,
  emailIndex: existence,
  authIdentity: existence,
  staffProfile: ["MATCHED_ACTIVE", "NOT_FOUND", "INACTIVE_OR_MISMATCH", "UNKNOWN"],
  staffClaims: ["EXACT_STAFF_MATCH", "MISMATCH", "UNKNOWN"],
  deployedAdminMembership: ["EXCLUDED", "INCLUDED", "UNKNOWN"],
};

function observationsOnly(input) {
  try {
    if (input === null || typeof input !== "object" || Array.isArray(input)) throw 0;
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw 0;
    const properties = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(properties).some(key => !Object.hasOwn(fields, key))) throw 0;
    const observations = {};
    for (const [key, allowed] of Object.entries(fields)) {
      const descriptor = properties[key];
      // Never invoke accessors, stringify raw values, or echo unknown keys.
      if (descriptor && !Object.hasOwn(descriptor, "value")) throw 0;
      const value = descriptor ? descriptor.value : "UNKNOWN";
      if (!allowed.includes(value)) throw 0;
      observations[key] = value;
    }
    // Staff source resolves the profile through index.staffId, not Auth UID.
    if (observations.emailIndex !== "FOUND" && observations.staffProfile !== "UNKNOWN") throw 0;
    return observations;
  } catch {
    // Raw SDK errors, claims, addresses, IDs and object traps must not escape.
    throw new Error("STAFF_ACCOUNT_DIAGNOSTIC_INPUT_INVALID");
  }
}

export function diagnoseStaffAccount(input = {}) {
  const observations = observationsOnly(input);
  const {authUser, emailIndex, authIdentity, staffProfile, staffClaims, deployedAdminMembership} = observations;
  const states = [], reasons = [];
  states.push(authUser === "FOUND" ? "AUTH_FOUND" : authUser === "NOT_FOUND" ? "AUTH_NOT_FOUND" : "AUTH_UNVERIFIED");
  if (authUser !== "FOUND") reasons.push(authUser === "NOT_FOUND" ? "AUTH_NOT_FOUND" : "AUTH_UNVERIFIED");

  if (emailIndex === "NOT_FOUND") states.push("STAFF_BINDING_MISSING");
  else if (emailIndex === "FOUND") states.push("STAFF_BINDING_OBSERVED");
  else states.push("STAFF_BINDING_UNVERIFIED");
  if (emailIndex !== "FOUND") reasons.push(emailIndex === "NOT_FOUND" ? "EMAIL_INDEX_NOT_FOUND" : "EMAIL_INDEX_UNVERIFIED");
  // authIdentities is a bootstrap login record, not a Staff binding prerequisite.
  const information = [authIdentity === "FOUND" ? "LOGIN_HISTORY_OBSERVED"
    : authIdentity === "NOT_FOUND" ? "LOGIN_HISTORY_ABSENT" : "LOGIN_HISTORY_UNVERIFIED"];

  states.push(staffProfile === "MATCHED_ACTIVE" ? "PROFILE_OBSERVED" : "PROFILE_UNVERIFIED");
  if (emailIndex !== "FOUND") reasons.push("PROFILE_REFERENCE_UNRESOLVED");
  if (staffProfile !== "MATCHED_ACTIVE") {
    reasons.push(staffProfile === "NOT_FOUND" ? "PROFILE_NOT_FOUND"
      : staffProfile === "INACTIVE_OR_MISMATCH" ? "PROFILE_INACTIVE_OR_MISMATCH" : "PROFILE_UNVERIFIED");
  }

  states.push(staffClaims === "EXACT_STAFF_MATCH" && deployedAdminMembership === "EXCLUDED"
    ? "ROLE_OBSERVED" : "ROLE_UNVERIFIED");
  if (staffClaims !== "EXACT_STAFF_MATCH") {
    reasons.push(staffClaims === "MISMATCH" ? "STAFF_CLAIMS_MISMATCH" : "STAFF_CLAIMS_UNVERIFIED");
  }
  if (deployedAdminMembership !== "EXCLUDED") {
    reasons.push(deployedAdminMembership === "INCLUDED" ? "DEPLOYED_ADMIN_INCLUDED" : "DEPLOYED_ADMIN_MEMBERSHIP_UNVERIFIED");
  }

  return {
    diagnosticOnly: true,
    authenticatedAcceptance: "UNVERIFIED",
    states,
    reasons,
    information,
    observations,
  };
}
