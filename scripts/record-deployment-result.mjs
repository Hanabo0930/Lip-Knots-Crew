import { resolve } from "node:path";
import { recordDeploymentResult } from "./release-checkpoint-core.mjs";

const args = process.argv.slice(2);
const values = (name) => {
  const result = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) result.push(args[index + 1]);
  }
  return result;
};
const value = (name, fallback = "") => values(name)[0] ?? fallback;
const checkpoint = value("--checkpoint");
const status = value("--status");
const operator = value("--operator");
const notes = value("--notes", "recorded");
const releaseRefs = values("--release-ref");
if (!checkpoint) {
  console.error("--checkpointが必須です。");
  process.exit(1);
}

const result = await recordDeploymentResult({
  checkpointDirectory: resolve(checkpoint),
  input: {
    status,
    operator,
    notes,
    releaseRefs,
    recordedAt: new Date().toISOString(),
  },
  replace: args.includes("--replace"),
});
console.log(`DEPLOYMENT RESULT: RECORDED ${result.releaseId} status=${result.status}`);
console.log("Project ID・operator・notes・release refsは表示していません。");
