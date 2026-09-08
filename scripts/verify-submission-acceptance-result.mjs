import fs from 'node:fs';
import { verifySubmissionAcceptanceResult } from './submission-acceptance-result.mjs';
const args = process.argv.slice(2);
if (args.length !== 4 || args[0] !== '--kit' || args[2] !== '--result') throw new Error('Usage: node scripts/verify-submission-acceptance-result.mjs --kit <kit.json> --result <normalized-result.json>');
const kit = JSON.parse(fs.readFileSync(args[1], 'utf8'));
const result = JSON.parse(fs.readFileSync(args[3], 'utf8'));
const report = verifySubmissionAcceptanceResult(kit, result);
console.log(JSON.stringify(report, null, 2));
if (!report.passed) process.exitCode = 1;
