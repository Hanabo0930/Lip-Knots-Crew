import { resolve } from "node:path";
import {
  restoreReleaseCheckpoint,
  verifyReleaseCheckpoint,
} from "./release-checkpoint-core.mjs";

const args = process.argv.slice(2);
const value = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? (args[index + 1] ?? "") : "";
};
const checkpoint = value("--checkpoint");
const destination = value("--restore-to");
const verifyOnly = args.includes("--verify-only");
if (!checkpoint) {
  console.error("--checkpointが必須です。");
  process.exit(1);
}
if (!verifyOnly && !destination) {
  console.error("--restore-toまたは--verify-onlyが必須です。");
  process.exit(1);
}
if (verifyOnly && destination) {
  console.error("--verify-onlyと--restore-toは同時に使用できません。");
  process.exit(1);
}

if (verifyOnly) {
  const verified = await verifyReleaseCheckpoint(resolve(checkpoint));
  if (verified.errors.length) {
    console.error(`ROLLBACK CHECKPOINT: FAIL (${verified.errors.length})`);
    verified.errors.forEach((error, index) => console.error(`${index + 1}. ${error}`));
    process.exit(1);
  }
  console.log(`ROLLBACK CHECKPOINT: VERIFIED ${verified.manifest.releaseId}`);
  console.log(`files=${verified.manifest.fileCount} secretFilesIncluded=false`);
  process.exit(0);
}

const manifest = await restoreReleaseCheckpoint({
  checkpointDirectory: resolve(checkpoint),
  destination: resolve(destination),
});
console.log(`ROLLBACK RESTORE: READY ${manifest.releaseId}`);
console.log(`destination=${resolve(destination)}`);
console.log("現行本体は変更していません。秘密設定追加後に再検証してください。");
