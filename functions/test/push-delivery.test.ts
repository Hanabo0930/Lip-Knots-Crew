import assert from "node:assert/strict";
import {
  classifyPushFailureCodes,
  isInvalidPushTokenCode,
  normalizePushFailureReason,
} from "../src/push-delivery";

assert.equal(classifyPushFailureCodes([]), "none");
assert.equal(
  classifyPushFailureCodes(["messaging/registration-token-not-registered"]),
  "invalid_token"
);
assert.equal(
  classifyPushFailureCodes(["messaging/installation-id-not-registered"]),
  "invalid_token"
);
assert.equal(
  classifyPushFailureCodes(["messaging/mismatched-credential"]),
  "sender_mismatch"
);
assert.equal(
  classifyPushFailureCodes(["messaging/authentication-error"]),
  "service_auth"
);
assert.equal(
  classifyPushFailureCodes(["messaging/server-unavailable"]),
  "temporary"
);
assert.equal(
  classifyPushFailureCodes(["messaging/device-message-rate-exceeded"]),
  "rate_limited"
);
assert.equal(classifyPushFailureCodes(["messaging/invalid-argument"]), "unknown");
assert.equal(
  classifyPushFailureCodes([
    "messaging/registration-token-not-registered",
    "messaging/mismatched-credential",
  ]),
  "sender_mismatch"
);
assert.equal(
  isInvalidPushTokenCode("messaging/installation-id-not-registered"),
  true
);
assert.equal(normalizePushFailureReason("service_auth"), "service_auth");
assert.equal(normalizePushFailureReason("secret-internal-value"), "unknown");

console.log("push delivery tests passed");
