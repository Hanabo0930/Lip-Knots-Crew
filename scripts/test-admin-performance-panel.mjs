import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createRequire} from 'node:module';
import {runInNewContext} from 'node:vm';
const dependency=createRequire(import.meta.url),ts=dependency('typescript'),React=dependency('react'),{renderToStaticMarkup}=dependency('react-dom/server');
const scope={exports:{},require:dependency};runInNewContext(ts.transpileModule(fs.readFileSync('apps/admin/src/AdminStaffPerformancePanel.tsx','utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText,scope);const Panel=scope.exports.default;
const valid={profile:{id:'staff',displayName:'Synthetic',areaLabels:[],nearestStation:'',rank:'A'},performance:{totals:{assignedJobs:1,implementedJobs:1,scheduledJobs:0,cancelledJobs:0,preContactLate:0,reportLate:0},clients:[{name:'Client',count:1}],makers:[],stores:[],recentJobs:[]}};
for(const mode of ['valid','profile-name','area','totals','count','rank-name','recent']){const data=structuredClone(valid);if(mode==='profile-name')data.profile.displayName={};if(mode==='area')data.profile.areaLabels=[{}];if(mode==='totals')data.performance.totals.assignedJobs={};if(mode==='count')data.performance.clients[0].count=-1;if(mode==='rank-name')data.performance.clients[0].name={};if(mode==='recent')data.performance.recentJobs=[null];const html=renderToStaticMarkup(React.createElement(Panel,{performance:data,onClose:()=>{}}));if(mode==='valid'){assert.match(html,/Synthetic/);assert.doesNotMatch(html,/実績を表示できません/);}else assert.match(html,/実績を表示できません/);assert.match(html,/閉じる/);}
console.log('Admin performance panel: valid data and six malformed responses render safely.');
