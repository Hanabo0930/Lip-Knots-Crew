import { prepareCaseMailIntakePreview } from "./case-mail-intake-preview.mjs";
import runtime from "../functions/case-mail-runtime/adapter.cjs";
export const analyzeFetchedCaseMail = runtime.createCaseMailAnalyzer(prepareCaseMailIntakePreview);
