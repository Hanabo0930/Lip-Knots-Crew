import fs from 'node:fs';
import path from 'node:path';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

// Load real store modules into a single synthetic browser boundary. No network or disk writes.
export function staffStoreLoader(globals = {}, overrides = {}) {
  const cache = new Map();
  const load = name => {
    name = name.replace(/^\.\//, '').replace(/\.ts$/, '');
    if (Object.hasOwn(overrides, name)) return overrides[name];
    if (cache.has(name)) return cache.get(name);
    if (!/^[a-z-]+$/.test(name)) throw new Error('Unexpected fixture import: ' + name);
    const scope = {exports: {}, ...globals, require: load};
    cache.set(name, scope.exports);
    const source = fs.readFileSync(path.join('apps/staff/src', name + '.ts'), 'utf8');
    const code = ts.transpileModule(source, {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText;
    runInNewContext(code, scope, {filename: name + '.ts'});
    return scope.exports;
  };
  return load;
}
