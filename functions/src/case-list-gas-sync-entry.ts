import { onRequest } from "firebase-functions/v2/https";
import type { RuntimePolicy } from "./case-list-gas-sync-runtime";

type Data = Record<string, any>;
type Handler = (request: Data, response: Data) => Promise<any>;
type Factory = (policy: RuntimePolicy, env: NodeJS.ProcessEnv) => Handler;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const CASE_ID = /^LKCASE_[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/;
const MAILBOX = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const hold = (response: Data, status: number, code: string) => {
  response.set("Cache-Control", "no-store");
  return response.status(status).json({ status: "HOLD", code, businessEnabled: false });
};
// Lazy imports keep an OFF request from initializing identity/resource clients.
const runtime: Factory = (policy, env) => {
  const { createSyncRuntimeHandler } = require("./case-list-gas-sync-runtime") as typeof import("./case-list-gas-sync-runtime");
  const { gasHandoffSettings } = require("./case-list-gas-handoff") as typeof import("./case-list-gas-handoff");
  return createSyncRuntimeHandler(policy, { config: gasHandoffSettings(env) });
};

/** Connects deployment settings to the existing protocol; it grants no identity.
 * Storage still uses the exact proposed namespaces and contracts in the runtime.
 * No settings, credentials, IAM bindings or cloud resources are created here.
 */
export function createConfiguredCaseListGasSync(env: NodeJS.ProcessEnv = process.env, factory: Factory = runtime): Handler {
  return async (request, response) => {
    const mode = env.LKC_GAS_SYNC_MODE ?? "off";
    if (mode === "off") return hold(response, 503, "SYNC_ENTRY_DISABLED");
    if (mode !== "read-only" && mode !== "business") return hold(response, 503, "SYNC_ENTRY_MODE_INVALID");
    if (mode === "read-only" && !["READINESS_ONLY", "OBSERVE"].includes(request.body?.action)) {
      return hold(response, 403, "SYNC_ENTRY_READ_ONLY");
    }
    const policy: RuntimePolicy = { enabled: true };
    const pilotCaseId = env.LKC_GAS_SYNC_PILOT_CASE_ID;
    if (pilotCaseId !== undefined) {
      if (!CASE_ID.test(pilotCaseId)) return hold(response, 503, "SYNC_ENTRY_PILOT_CASE_INVALID");
      policy.pilotCaseId = pilotCaseId;
    }
    if (mode === "business") {
      const companyId = env.DEFAULT_COMPANY_ID ?? "", ownerUid = env.LKC_GAS_SYNC_OWNER_UID ?? "";
      const mailbox = (env.LKC_GAS_SYNC_MAILBOX ?? "").trim().toLowerCase();
      const principalRevision = env.LKC_GAS_SYNC_PRINCIPAL_REVISION ?? "";
      if (!ID.test(companyId) || !ID.test(ownerUid) || !MAILBOX.test(mailbox) || !REVISION.test(principalRevision)) {
        return hold(response, 503, "SYNC_ENTRY_POLICY_REQUIRED");
      }
      policy.sentReadPolicy = { enabled: true, companyId, ownerUid, mailbox, principalRevision };
    }
    // The existing handler independently verifies fixed project/audience,
    // Google identity, current Firebase/company/owner authority and read policy.
    try { return await factory(policy, env)(request, response); }
    catch { return hold(response, 503, "SYNC_ENTRY_UNAVAILABLE"); }
  };
}

// Exporting locally does not deploy this service. Public invocation is an
// explicit deployment/IAM decision, separate from internal business authority.
export const caseListGasSync = onRequest({
  region: "asia-northeast1", memory: "256MiB", maxInstances: 1,
  invoker: process.env.LKC_GAS_SYNC_PUBLIC_INVOKER === "true" ? "public" : "private",
}, createConfiguredCaseListGasSync());
