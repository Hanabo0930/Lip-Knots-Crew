import fs from 'node:fs';
import path from 'node:path';
import { createSubmissionAcceptanceKit } from './submission-acceptance-kit.mjs';
const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--output') throw new Error('Usage: node scripts/prepare-submission-acceptance-kit.mjs --output <new-local-directory>');
const output = path.resolve(args[1]);
// 既存ディレクトリへの上書きを許さない。クラウドSDKやネットワークを使用しない。
fs.mkdirSync(output, { recursive: false });
const kit = createSubmissionAcceptanceKit();
fs.writeFileSync(path.join(output, 'kit.json'), JSON.stringify(kit, null, 2) + '\n', { flag: 'wx' });
for (const file of kit.files) fs.writeFileSync(path.join(output, file.originalName), file.content, { flag: 'wx' });
console.log(JSON.stringify({ output, seedDocuments: kit.seedDocuments.length, fixtures: kit.files.length, mode: kit.mode, cloudExecutionAuthorized: false }));
