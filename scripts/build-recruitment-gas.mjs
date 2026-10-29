import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const canonical = new URL("../functions/src/recruitment-mail-core.cjs", import.meta.url);
const marker = "\n/* Fast read-only adapter.";

/** Prepare local source only. The approved adapter tail is retained verbatim. */
export function bundleRecruitmentGas(adapterSource) {
  if (typeof adapterSource !== "string" || !adapterSource.startsWith("/* Public recruitment text only.") ||
      adapterSource.split(marker).length !== 2 || !adapterSource.includes("var LK_RM_ADAPTER_V1 =")) throw Error("RECRUITMENT_GAS_ADAPTER_BOUNDARY_REQUIRED");
  const publicCore = fs.readFileSync(canonical, "utf8");
  const adapterTail = adapterSource.slice(adapterSource.indexOf(marker));
  return publicCore.trimEnd() + "\n" + adapterTail;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== "--adapter" || args[2] !== "--output") throw Error("Usage: node scripts/build-recruitment-gas.mjs --adapter reviewed.gs --output candidate.gs");
  const adapter = path.resolve(args[1]), output = path.resolve(args[3]);
  if (adapter === output) throw Error("RECRUITMENT_GAS_DISTINCT_OUTPUT_REQUIRED");
  const bundled = bundleRecruitmentGas(fs.readFileSync(adapter, "utf8"));
  fs.writeFileSync(output, bundled, { flag: "wx" });
  console.log(JSON.stringify({ status: "PREPARED_SOURCE_ONLY", formatterSHA256: createHash("sha256").update(fs.readFileSync(canonical)).digest("hex"), bytes: Buffer.byteLength(bundled), deployed: false, nativeRequests: 0 }));
}
