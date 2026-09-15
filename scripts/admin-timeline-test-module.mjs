import fs from 'node:fs';import ts from 'typescript';import {runInNewContext} from 'node:vm';
const module={exports:{}};
runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/submission-timeline.ts','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,module);
export const timelineModule=module.exports;