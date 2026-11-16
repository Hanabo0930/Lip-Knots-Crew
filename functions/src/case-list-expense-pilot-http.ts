import type { Request } from "firebase-functions/v2/https";
import type { Response } from "express";
import type { createExpensePilotGateway } from "./case-list-expense-pilot-gateway";

type Gateway = ReturnType<typeof createExpensePilotGateway>;
const MAX_BODY = 16_384;
const statusByCode = {
  unauthenticated: 401, "permission-denied": 403, "invalid-argument": 400, "not-found": 404,
  aborted: 409, "failed-precondition": 409, unavailable: 503,
} as const;

/** HTTP handler factory for the isolated pilot. It does not register a function. */
export function createExpensePilotHttpHandler(gateway: Gateway) {
  return async (req: Request, res: Response): Promise<void> => {
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    const reject = (status: number, code: string) => { res.status(status).json({ ok: false, code }); };
    if (req.method !== "POST") {
      res.set("Allow", "POST");
      return reject(405, "method-not-allowed");
    }
    const authorizations = req.rawHeaders.filter((_, index) =>
      index % 2 === 1 && req.rawHeaders[index - 1]?.toLowerCase() === "authorization");
    const authorization = req.headers.authorization;
    if (authorizations.length !== 1 || authorizations[0] !== authorization || typeof authorization !== "string" ||
        !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(authorization)) {
      return reject(401, "unauthenticated");
    }
    const contentType = req.headers["content-type"];
    if (typeof contentType !== "string" || !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(contentType)) {
      return reject(415, "unsupported-media-type");
    }
    if (!Buffer.isBuffer(req.rawBody)) return reject(400, "invalid-argument");
    if (req.rawBody.length > MAX_BODY) return reject(413, "payload-too-large");

    let data: unknown;
    try { data = JSON.parse(req.rawBody.toString("utf8")); }
    catch { return reject(400, "invalid-argument"); }
    try {
      const result = await gateway(authorization, data);
      res.status(200).json({ ok: true, result });
    } catch (error) {
      const failure = error as { code?: unknown; name?: unknown } | null;
      if (failure?.name === "ZodError") return reject(400, "invalid-argument");
      const code = failure?.code;
      if (typeof code === "string" && Object.hasOwn(statusByCode, code)) {
        return reject(statusByCode[code as keyof typeof statusByCode], code);
      }
      return reject(500, "internal");
    }
  };
}
