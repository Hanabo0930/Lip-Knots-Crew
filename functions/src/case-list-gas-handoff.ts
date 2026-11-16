import { google } from "googleapis";
import { MFA_LOOKUP_FIELDS, readFirebaseMfaState } from "./case-list-mfa-observation";
import { auth } from "./firebase";
import { getProductionOperationalState } from "./system-safety";
import { db } from "./firebase";
import { readExternalCaseListHandoffGateSnapshot } from "./case-list-external-transfer";

type Data = Record<string, any>;
type Request = { method?: string; headers: Record<string, string | string[] | undefined>; rawHeaders?: string[]; body?: unknown };
type Response = { set(field: string, value: string): unknown; status(code: number): Response; json(value: unknown): unknown };
type Ports = {
  now(): number;
  verifyGoogleIdentity(token: string, audience: string): Promise<unknown>;
  readFirebaseUserByGoogleSubject(subject: string): Promise<unknown>;
  operational(companyId: string): Promise<boolean>;
  readOriginalGateSnapshot(queueId: string, actor: Data): Promise<unknown>;
  verifySentEvidence?: (record: Data, binding: Data, actor: Data) => Promise<unknown>;
};
const core = require("../src/case-list-gas-handoff-core.cjs") as {
  createHandoff(services: Data): { handle(authorization: unknown, body: unknown): Promise<Data> };
  safeFailure(error: unknown): { status: number; body: Data };
};
export function gasHandoffSettings(env: NodeJS.ProcessEnv = process.env): Data {
  return {
    projectId: env.EXPECTED_FIREBASE_PROJECT_ID,
    actualProjectId: env.GCLOUD_PROJECT ?? env.GCP_PROJECT,
    companyId: env.DEFAULT_COMPANY_ID,
    audience: env.LKC_GAS_HANDOFF_AUDIENCE,
    executiveEmails: (env.EXECUTIVE_APPROVER_EMAILS ?? "").split(",").map(value => value.trim().toLowerCase()).filter(Boolean),
    // The future business/persistence protocol is not enabled by an environment flag.
    allowOriginalReadback: false,
  };
}
export function createGasIdentityRuntimePorts(): Ports {
  const verifier = new google.auth.OAuth2();
  const makeMfaReader = () => new google.auth.GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  let mfaReader: ReturnType<typeof makeMfaReader> | undefined;
  return {
    now: () => Date.now(),
    verifyGoogleIdentity: async (token, audience) => {
      const ticket = await verifier.verifyIdToken({ idToken: token, audience });
      return ticket.getPayload();
    },
    readFirebaseUserByGoogleSubject: async subject => {
      const observedAt = Date.now();
      const user = await auth.getUserByProviderUid("google.com", subject);
      const mfaState = await readFirebaseMfaState(user, subject, async () => {
        mfaReader ??= makeMfaReader();
        return mfaReader.request({
          url: "https://identitytoolkit.googleapis.com/v1/projects/lip-knots-crew-staging/accounts:lookup",
          method: "POST", data: { localId: [user.uid] }, params: { fields: MFA_LOOKUP_FIELDS },
          timeout: 5000, retry: false,
        });
      });
      return {
        uid: user.uid, email: user.email, emailVerified: user.emailVerified, disabled: user.disabled,
        providerData: user.providerData.map(({ providerId, uid }) => ({ providerId, uid })),
        customClaims: user.customClaims,
        tenantId: user.tenantId ?? null,
        // NONE is based on matched official MFA observation, never SDK omission alone.
        mfaState,
        validSinceMs: user.tokensValidAfterTime ? Date.parse(user.tokensValidAfterTime) : NaN,
        observedAt,
      };
    },
    operational: async companyId => (await getProductionOperationalState(companyId)).operational,
    readOriginalGateSnapshot: async (queueId, actor) =>
      readExternalCaseListHandoffGateSnapshot(db.collection("sheetSyncQueue").doc(queueId), actor.uid, actor),
    // No trusted continuation writer/SENT-reader contract has been adopted. Missing port holds.
  };
}
/** Local/unregistered handler factory. Not exported from index; no onRequest, IAM or route change. */
export function createGasHandoffHandler(config: Data = gasHandoffSettings(), ports?: Ports) {
  let api: ReturnType<typeof core.createHandoff> | undefined;
  return async (request: Request, response: Response): Promise<void> => {
    response.set("Cache-Control", "no-store");
    response.set("Pragma", "no-cache");
    response.set("X-Content-Type-Options", "nosniff");
    if (request.method !== "POST") {
      response.status(405).json({ status: "HOLD", code: "HANDOFF_POST_REQUIRED", businessEnabled: false }); return;
    }
    const type = request.headers["content-type"];
    if (typeof type !== "string" || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(type)) {
      response.status(415).json({ status: "HOLD", code: "HANDOFF_JSON_REQUIRED", businessEnabled: false }); return;
    }
    const raw = request.rawHeaders;
    if (raw && raw.filter((value, index) => index % 2 === 0 && value.toLowerCase() === "authorization").length !== 1) {
      response.status(401).json({ status: "HOLD", code: "HANDOFF_BEARER_REQUIRED", businessEnabled: false }); return;
    }
    try {
      const encoded = JSON.stringify(request.body);
      if (!encoded || Buffer.byteLength(encoded) > 8192) {
        response.status(400).json({ status: "HOLD", code: "HANDOFF_INPUT_INVALID", businessEnabled: false }); return;
      }
      api ??= core.createHandoff({ ...ports ?? createGasIdentityRuntimePorts(), config });
      const result = await api.handle(request.headers.authorization, request.body);
      response.status(200).json(result);
    } catch (error) {
      const safe = core.safeFailure(error);
      response.status(safe.status).json(safe.body);
    }
  };
}

