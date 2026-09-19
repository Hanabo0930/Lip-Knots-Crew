import { createCaseMailReceiver, CaseMailProvider } from "./case-mail-intake";
import { normalizeJobInput } from "./job-management-core";
import { hashText } from "./case-id";

const { createCaseMailPreview } = require("../case-mail-runtime/preview.cjs");
const { createCaseMailAnalyzer } = require("../case-mail-runtime/adapter.cjs");
const { createGmailCaseMailProvider, EXTRACTOR_ORIGIN } = require("../case-mail-runtime/provider.cjs");

type Config = Parameters<typeof createCaseMailReceiver>[0];
export type CaseMailCredentialContext = Readonly<Config & {
  scope: "https://www.googleapis.com/auth/gmail.readonly";
}>;
export interface CaseMailGmailDependencies {
  obtainGmailAccessToken(context: CaseMailCredentialContext): Promise<string>;
  obtainExtractorCredentials(context: Readonly<Config & { audience: string }>): Promise<{ idToken: string; secret: string }>;
  fetchImpl?: typeof fetch;
}
/** 内部ワーカーの配線。認証情報の実設定・有効化・公開入口/スケジューラーは別工程。 */
export function createGmailCaseMailReceiver(serverConfig: Config, dependencies: CaseMailGmailDependencies) {
  const config = Object.freeze({ ...serverConfig });
  const analyze = createCaseMailAnalyzer(createCaseMailPreview(normalizeJobInput, hashText(normalizeJobInput.toString(), 64)));
  const provider: CaseMailProvider = createGmailCaseMailProvider({
    mailbox: config.mailbox, startedAt: config.startedAt, analyze,
    obtainAccessToken: () => dependencies.obtainGmailAccessToken(Object.freeze({
      ...config, scope: "https://www.googleapis.com/auth/gmail.readonly" as const,
    })),
    obtainExtractionCredentials: (audience: string) => {
      if (audience !== EXTRACTOR_ORIGIN) throw new Error("添付抽出の接続先が一致しません。");
      return dependencies.obtainExtractorCredentials(Object.freeze({ ...config, audience }));
    },
    ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
  });
  return createCaseMailReceiver(config, provider);
}
