'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
const pins={};
const expected=JSON.parse(fs.readFileSync(path.join(__dirname,'MODEL_PINS.json'),'utf8'));
function load(stem){
  const bytes=fs.readFileSync(path.join(__dirname,'models',stem+'.js'));
  pins[stem]=createHash('sha256').update(bytes).digest('hex');
  if(pins[stem]!==expected[stem])throw Error('FIXED_MODEL_PIN_CHANGED');
  const module={exports:{}};
  const req=id=>{if(id==='node:crypto')return {createHash};if(stem==='staff-identity'&&id==='./case-id')return load('case-id');throw Error('NON_PURE_MODEL_IMPORT');};
  const scope=vm.createContext({module,exports:module.exports,require:req});
  new vm.Script('(function(require,module,exports){'+bytes+'\n})').runInContext(scope)(req,module,module.exports);
  return module.exports;
}
module.exports={ng:load('staff-ng'),identity:load('staff-identity'),pins};
