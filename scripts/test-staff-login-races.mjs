import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(path.join(process.env.LKC_TEST_DEPENDENCY_ROOT||process.cwd(),'package.json'));const ts=require('typescript');
const source=fs.readFileSync('apps/staff/src/App.tsx','utf8');const start=source.indexOf('  async function requestLogin()'),end=source.indexOf('  async function registerCurrentDevice(',start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject};}
function setup(loginCode="123456",storageFails=false,overrides={}){const state={messages:[],signIns:0,codes:[],calls:0,clears:0},api=deferred(),persistence=deferred(),signIn=deferred();const deps={loginEmailRef:{current:null},authLoadVersionRef:{current:1},email:' Synthetic@Example.test ',loginCode,isLoginActionPending:()=>false,setMessage:m=>{if(m)state.messages.push(m);else state.clears++;},setEmail:()=>{},setLoginCode:v=>state.codes.push(v),localStorage:{setItem:()=>{if(storageFails)throw Error("storage denied");}},firebaseConfigured:true,functions:{},auth:{},window:{location:{origin:'https://example.test'}},httpsCallable:()=>async input=>{state.input=input;state.calls++;return api.promise;},isSignInWithEmailLink:()=>{state.validated=true;return true;},authPersistenceReady:persistence.promise,signInWithEmailLink:async()=>{state.signIns++;return signIn.promise;},run:async(_key,fn,options)=>{try{await fn()}catch(error){options.setMessage(error.message);throw error;}}};Object.assign(deps,overrides);const handlers=Function(...Object.keys(deps),code+';return {requestLogin,verifyLoginCode};')(...Object.values(deps));return {state,deps,handlers,api,persistence,signIn};}
const flush=async()=>{for(let tick=0;tick<20;tick++)await Promise.resolve();};
const response={data:{accepted:true,message:'sent',emailActionLink:'https://example.test/synthetic'}};
for(const name of ['requestLogin','verifyLoginCode'])for(const reject of [false,true]){const test=setup();const pending=test.handlers[name]();if(name==='verifyLoginCode'){test.persistence.resolve();await flush();assert.equal(test.state.calls,1);}test.deps.authLoadVersionRef.current++;reject?test.api.reject(Error('old error')):test.api.resolve(response);await pending;assert.equal(test.state.signIns,0);assert.deepEqual(test.state.messages,[]);}
{const test=setup();const pending=test.handlers.verifyLoginCode();assert.equal(test.state.calls,0);test.deps.authLoadVersionRef.current++;test.persistence.resolve();await pending;assert.equal(test.state.calls,0);assert.equal(test.state.signIns,0);assert.deepEqual(test.state.messages,[]);}
for(const staleAfterSignIn of [false,true]){const test=setup();const pending=test.handlers.verifyLoginCode();test.api.resolve(response);test.persistence.resolve();await flush();assert.equal(test.state.signIns,1);if(staleAfterSignIn)test.deps.authLoadVersionRef.current++;test.signIn.resolve();await pending;assert.equal(test.state.signIns,1);assert.deepEqual(test.state.messages,staleAfterSignIn?[]:['ログインしました。']);assert.deepEqual(test.state.codes,staleAfterSignIn?[]:['']);}
{const test=setup();const pending=test.handlers.requestLogin();test.api.resolve(response);await pending;assert.deepEqual(test.state.messages,['ログインメールの送信依頼は受付済みです。メールが届いたら確認コードを入力してください。']);}
{const test=setup();const pending=test.handlers.verifyLoginCode();test.persistence.resolve();await flush();test.api.reject(Error('current error'));await pending;assert.deepEqual(test.state.messages,['current error']);}
console.log('Staff login races: 9 cases passed; stale API/persistence/sign-in results discarded, current results preserved; no real email or authentication.');

{
 const start=source.indexOf('  async function logoutCurrentUser()'),end=source.indexOf('  function watchDeviceSession(',start);const code=ts.transpileModule(source.slice(start,end),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const fail of [false,true]){let calls=0,pending=false;const messages=[];const deps={authLoadVersionRef:{current:1},user:null,auth:{},confirm:()=>true,isPending:()=>pending,setMessage:m=>messages.push(m),signOut:async()=>{calls++;if(fail&&calls===1)throw Error('logout failed')},run:async(_key,fn,options)=>{pending=true;try{await fn()}catch(error){options.setMessage(error.message);throw error}finally{pending=false}}};const handler=Function(...Object.keys(deps),code+';return requestLogout;')(...Object.values(deps));await assert.doesNotReject(handler());assert.equal(pending,false);if(fail){assert.match(messages.at(-1),/ログアウトできませんでした/);assert.match(messages.at(-1),/もう一度「ログアウト」/);await assert.doesNotReject(handler());assert.equal(calls,2);}else assert.equal(calls,1);}
}
console.log('Login and logout consume displayed action errors; logout pending state clears and retry succeeds.');

for(const code of ['１２３４５６','１２３ ４５６','123456']){const test=setup(code);const pending=test.handlers.verifyLoginCode();test.api.resolve(response);test.persistence.resolve();test.signIn.resolve();await pending;assert.equal(test.state.calls,1);assert.equal(test.state.input.code,'123456');assert.equal(test.state.signIns,1);}
for(const code of ['１２３４５','１２３４５６７','abc']){const test=setup(code);await test.handlers.verifyLoginCode();assert.equal(test.state.calls,0);assert.match(test.state.messages.at(-1),/6桁/);}
const inputHandler=source.match(/onChange=\{e=>setLoginCode\((.*?)\)\} placeholder="6桁の確認コード"/);assert.ok(inputHandler);for(const [input,expected] of [['１２３４５６','123456'],['１２３ ４５６','123456'],['１２３４５６７','123456'],['abc','']])assert.equal(Function('e','return '+inputHandler[1])({target:{value:input}}),expected);
console.log('Confirmation code normalization: full-width/pasted digits, six-digit validation and actual input handler passed.');

for(const action of ['requestLogin','verifyLoginCode']){const test=setup('123456',true);const pending=test.handlers[action]();test.api.resolve(response);test.persistence.resolve();test.signIn.resolve();await pending;assert.equal(test.state.calls,1);assert.equal(test.state.signIns,action==='verifyLoginCode'?1:0);assert.ok(test.state.messages.length>0);}
const savedEmailCode=source.slice(source.indexOf('function readSavedEmail()'),source.indexOf('function getOrCreateDeviceId()'));
for(const denied of [false,true]){const read=Function('localStorage',savedEmailCode+';return readSavedEmail;')({getItem:()=>{if(denied)throw Error('denied');return 'synthetic@example.test';}});assert.equal(read(),denied?'':'synthetic@example.test');}
console.log('Email storage is optional: denied reads return empty and denied saves do not prevent synthetic login requests.');

{const test=setup();const pending=test.handlers.verifyLoginCode();assert.equal(test.state.calls,0);test.persistence.reject(Error('persistence unavailable'));await pending;assert.equal(test.state.calls,0);assert.equal(test.state.signIns,0);assert.deepEqual(test.state.messages,['persistence unavailable']);assert.equal(test.state.codes.length,0);}
console.log('Persistence failure never redeems a login code or signs in; entered code is retained.');


{
 const {execFileSync}=await import('node:child_process');const firebase=fs.readFileSync('apps/staff/src/firebase.ts','utf8');const from=firebase.indexOf('export const authPersistenceReady'),to=firebase.indexOf('if (app && useFirebaseEmulators)',from);assert.ok(from>=0&&to>from);
 const initial=ts.transpileModule(firebase.slice(from,to).replace('export const','const'),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 const check='const auth={},browserLocalPersistence={};const setPersistence=()=>Promise.reject(Error("denied"));'+initial+';setImmediate(async()=>{try{await authPersistenceReady;process.exitCode=1;}catch(error){if(!error.message.includes("保存準備"))process.exitCode=1;}});';
 execFileSync(process.execPath,['--unhandled-rejections=strict','-e',check],{stdio:'pipe'});
}
console.log('Persistence startup rejects safely before a delayed consumer; its later await still receives the recovery error.');

for(const result of ["success","failure","stale"]){const test=setup();const pending=test.handlers.requestLogin();assert.deepEqual(test.state.codes,[],"Keep code while pending");if(result==="stale")test.deps.authLoadVersionRef.current++;if(result==="failure")test.api.reject(Error("再送に失敗しました。"));else test.api.resolve(response);await pending;assert.deepEqual(test.state.codes,result==="success"?[""]:[]);}
console.log("Resend retains code during pending/failure/stale results; current success clears it.");

for(const data of [null,[],{},'bad',{accepted:false,message:'sent'},{accepted:true,message:{}},{accepted:true,message:' '}]){const test=setup();const pending=test.handlers.requestLogin();test.api.resolve({data});await pending;assert.deepEqual(test.state.codes,[]);assert.match(test.state.messages.at(-1),/受付結果を確認できません/);assert.equal(test.state.clears,1);}
for(const data of [null,{}, {emailActionLink:42},{emailActionLink:{}},{emailActionLink:' '}]){const test=setup();const pending=test.handlers.verifyLoginCode();test.persistence.resolve();test.api.resolve({data});await pending;assert.equal(test.state.signIns,0);assert.equal(test.state.validated,undefined);assert.deepEqual(test.state.codes,[]);assert.match(test.state.messages.at(-1),/ログイン情報を確認できません/);assert.equal(test.state.clears,1);}
console.log('Malformed login replies: seven resend and five code payloads rejected without clearing input or calling the sign-in SDK; old message cleared on start.');

for(const [action,overrides] of [['requestLogin',{functions:null}],['verifyLoginCode',{functions:null}],['verifyLoginCode',{auth:null}]]){const test=setup('123456',false,overrides);await test.handlers[action]();assert.equal(test.state.calls,0);assert.equal(test.state.signIns,0);assert.deepEqual(test.state.codes,[]);assert.match(test.state.messages.at(-1),/接続準備を確認できません/);assert.match(test.state.messages.at(-1),/再読み込み/);assert.equal(test.state.clears,1);}
for(const action of ['requestLogin','verifyLoginCode']){const test=setup('123456',false,{firebaseConfigured:false,functions:null,auth:null});await test.handlers[action]();assert.equal(test.state.calls,0);assert.equal(test.state.signIns,0);assert.match(test.state.messages.at(-1),/^デモ：/);}
console.log('Missing login services: three connection failures preserve code and explain recovery; two explicit demo actions remain available without network.');

for(const busy of [false,true]){let validations=0;const test=setup('123456',false,{loginEmailRef:{current:{reportValidity:()=>{validations++;return false;}}},isLoginActionPending:()=>busy});await test.handlers.verifyLoginCode();assert.equal(validations,busy?0:1);assert.equal(test.state.calls,0);assert.equal(test.state.clears,0);assert.deepEqual(test.state.codes,[]);}
console.log('Code login validates the email field before work; invalid email preserves input and pending actions skip revalidation.');

{const server=fs.readFileSync('functions/src/login-links.ts','utf8');const message=server.match(/message:\s*"([^"\n]+)"/)[1];const test=setup();const pending=test.handlers.requestLogin();test.api.resolve({data:{accepted:true,message}});await pending;assert.match(test.state.messages.at(-1),/送信依頼は受付済み/);assert.doesNotMatch(test.state.messages.at(-1),/送信しました/);}
console.log('Actual server acceptance wording does not become a delivery claim in the client.');

{
 const from=source.indexOf('  useEffect(()=>{\n    if(!auth)return;\n    const loginUrl=');const to=source.indexOf('\n  },[]);',from)+10;assert.ok(from>=0&&to>from);
 const effect=ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const failure of [Error('expired'),null,'offline'])for(const disposed of [false,true]){
  const pending=deferred(),messages=[],busy=[];let cleanup;const calls=[];
  Function('useEffect','auth','window','isSignInWithEmailLink','readSavedEmail','setMessage','setEmailLinkPending','completeEmailLinkSignIn','document',effect)(fn=>{cleanup=fn();},{},{location:{href:'https://example.test/?synthetic-link'},history:{replaceState:()=>assert.fail('Failed link must not consume URL')}},()=>true,()=> 'synthetic@example.test',m=>messages.push(m),v=>busy.push(v),(...args)=>{calls.push(args);return pending.promise;},{});
  assert.equal(calls.length,1);if(disposed)cleanup();pending.reject(failure);await flush();
  assert.equal(messages.length,disposed?1:2);if(!disposed){assert.match(messages.at(-1),/ログインできませんでした/);assert.match(messages.at(-1),/確認コード/);assert.match(messages.at(-1),/ログインメールを送る/);assert.deepEqual(busy,[true,false]);}else assert.deepEqual(busy,[true]);
 }
 console.log('Email-link failure: Error/null/string rejection explains code or resend recovery, releases waiting, and ignores disposed effects; no real authentication.');
}

{
 const from=source.indexOf('  async function requestLogout()'),to=source.indexOf('  function watchDeviceSession(',from);const code=ts.transpileModule(source.slice(from,to),{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
 for(const mode of ['busy','cancel','current-error','stale-error']){
  const gate=deferred(),messages=[],version={current:1};let calls=0,confirmations=0;
  const request=Function('isPending','confirm','setMessage','authLoadVersionRef','logoutCurrentUser','run',code+';return requestLogout;')(()=>mode==='busy',()=>{confirmations++;return mode!=='cancel';},m=>messages.push(m),version,()=>{calls++;return gate.promise;},async(_key,fn,options)=>{try{await fn();}catch(error){options.setMessage(String(error));throw error;}});
  const pending=request();if(mode==='stale-error')version.current++;if(mode.endsWith('error'))gate.reject(null);await pending;
  assert.equal(calls,mode.endsWith('error')?1:0);assert.equal(confirmations,mode==='busy'?0:1);assert.equal(messages.length,mode==='current-error'?2:mode==='stale-error'?1:0);if(mode==='current-error')assert.match(messages.at(-1),/もう一度「ログアウト」/);
 }
 console.log('Logout recovery: busy/cancel never sign out, current null rejection shows retry guidance, stale authentication failure stays quiet.');
}
