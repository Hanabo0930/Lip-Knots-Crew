import assert from "node:assert/strict";
import fs from "node:fs";
import {createRequire} from "node:module";
import {runInNewContext} from "node:vm";
const require=createRequire(import.meta.url), ts=require("typescript");
const {Timestamp}=require("firebase-admin/firestore");
const {HttpsError}=require("firebase-functions/v2/https");
export const companyId="synthetic-company",staffId="synthetic-staff",jobId="synthetic-job",workDate="2099-09-20";
const clone=value=>value instanceof Timestamp?value:Array.isArray(value)?value.map(clone):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).map(([k,v])=>[k,clone(v)])):value;
export function harness(){
  const records=new Map(),modules=new Map();let serial=0;
  const h={records,commits:[],attempts:0,beforeCommit:null,failCommit:false,loseResponse:false,readCounts:new Map(),failRead:null,beforeRead:null};
  const snap=ref=>{const value=clone(records.get(ref.path));return {ref,id:ref.id,exists:records.has(ref.path),data:()=>clone(value)};};
  const ref=(name,id="generated-"+(++serial))=>({id,path:name+"/"+id,get:async function(){return snap(this);}});
  const queryResult=q=>[...records].filter(([path,value])=>path.startsWith(q.name+"/")&&q.filters.every(([key,op,expected])=>{assert.equal(op,"==");return key.split(".").reduce((value,part)=>value?.[part],value)===expected;}))
    .map(([path])=>ref(q.name,path.slice(q.name.length+1))).sort((a,b)=>a.id.localeCompare(b.id))
    .filter(doc=>!q.cursor||doc.id>q.cursor).slice(0,q.count);
  const query=(name,filters=[],cursor=null,count=Infinity)=>({name,filters,cursor,count,
    doc:id=>ref(name,id),where:(...filter)=>query(name,[...filters,filter],cursor,count),
    orderBy:field=>{assert.equal(field,"__name__");return query(name,filters,cursor,count);},
    limit:n=>query(name,filters,cursor,n),startAfter:id=>query(name,filters,id,count)});
  const db={collection:name=>query(name),runTransaction:async callback=>{
    for(let attempt=0;attempt<12;attempt++){
      h.attempts++;const reads=new Map(),writes=[],queryReads=[];
      const tx={get:async ref=>{
        assert.equal(writes.length,0,"read after write");
        const key=ref.path??("query:"+ref.name);h.readCounts.set(key,(h.readCounts.get(key)??0)+1);
        if(h.failRead===key)throw Error("synthetic read failure");
        await h.beforeRead?.(key);
        if(!ref.path){const docs=queryResult(ref);queryReads.push([ref,JSON.stringify(docs.map(doc=>doc.path))]);for(const doc of docs)reads.set(doc.path,JSON.stringify(records.get(doc.path)));return {docs:docs.map(snap)};}
        reads.set(ref.path,JSON.stringify(records.get(ref.path)));return snap(ref);
      },
        set:(ref,data,options)=>writes.push({ref,data:clone(data),merge:options?.merge}),
        update:(ref,data)=>writes.push({ref,data:clone(data),merge:true,update:true})};
      const result=await callback(tx);await h.beforeCommit?.({attempt,reads,writes});
      if([...reads].some(([key,value])=>JSON.stringify(records.get(key))!==value)||queryReads.some(([q,value])=>JSON.stringify(queryResult(q).map(doc=>doc.path))!==value))continue;
      if(h.failCommit)throw Error("synthetic commit failure");
      const next=new Map(records);
      for(const write of writes){
        if(write.update)assert.ok(next.has(write.ref.path),"update missing");
        const value=write.merge?{...next.get(write.ref.path)}:{};
        for(const [k,v] of Object.entries(write.data)){assert.notEqual(v,undefined,"undefined field");if(v?.__delete)delete value[k];else value[k]=clone(v);}
        next.set(write.ref.path,value);
      }
      records.clear();for(const [key,value]of next)records.set(key,value);
      h.commits.push(writes);
      if(h.loseResponse){h.loseResponse=false;throw Error("synthetic response lost");}
      return result;
    }
    throw Error("synthetic contention exceeded");
  }};
  const boundaries={"./firebase":{db},"firebase-functions/v2/https":{HttpsError,onCall:(...args)=>args.at(-1)},
    "firebase-admin/firestore":{Timestamp,FieldPath:{documentId:()=>"__name__"},FieldValue:{delete:()=>({__delete:true}),serverTimestamp:()=>Timestamp.now()}},
    zod:require("zod"),"node:crypto":require("node:crypto")};
  function load(name){
    if(Object.hasOwn(boundaries,name))return boundaries[name];
    assert.match(name,/^\.\/[a-z0-9-]+$/,"external dependency refused");
    if(modules.has(name))return modules.get(name);
    const source=fs.readFileSync(new URL("../functions/src/"+name.slice(2)+".ts",import.meta.url),"utf8");
    const code=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
    const exports={};modules.set(name,exports);
    runInNewContext(code,{exports,require:load,process:{env:{APP_ENVIRONMENT:"development"}},Date,console},{timeout:5000});
    return exports;
  }
  const intake=load("./automation-intake"),jobs=load("./jobs"),core=load("./automation-recruitment-core");
  const key=intake.automationRecordKey,personKey="a".repeat(64);
  const admin={uid:"synthetic-producer-user",token:{companyId,role:"admin"}};
  const staff={uid:"synthetic-staff-user",token:{companyId,role:"staff",staffId}};
  const binding={version:1,companyId,jobId,appCaseId:"synthetic-case",spreadsheetId:"synthetic-book",fixedCaseId:"synthetic-fixed",workDate,revision:"binding-1",assignment:null};
  const job={companyId,caseId:binding.appCaseId,dateKey:workDate,workDate,status:"open",assignedStaffId:null,publishable:true,revision:0,
    storeName:"Synthetic Store",sheetRef:{spreadsheetId:binding.spreadsheetId,sheetId:1,sheetName:"2099.9",currentRow:2}};
  const policy={version:1,companyId,revision:"policy-1",phase:"mail_bridge",noticeOwner:"notice_control"};
  const campaign=core.prepareCaseMailCampaign({companyId,policy,sourceValidation:{ok:true,reasons:[]},
    draft:{state:"PREVIEW",operationId:"synthetic-campaign",area:"normal",cases:[{id:binding.fixedCaseId,day:workDate}]},
    records:[{binding,job:{...job,id:jobId},revision:"0"}]});
  const incoming={contractVersion:1,kind:"recruitment.application",companyId,campaignKey:campaign.operationKey,
    sourceRecordId:"synthetic-reply",fixedCaseId:binding.fixedCaseId,workDate,applicantPersonKey:personKey};
  const paths={policy:"automationRecruitmentPolicies/"+companyId,campaign:"automationCampaigns/"+campaign.operationKey,
    binding:"automationBindings/"+key(companyId,jobId),person:"automationPeople/"+key(companyId,personKey),
    sender:"automationIngestPrincipals/"+key(companyId,admin.uid),bindingOwner:"automationBindingOwners/"+key(companyId,binding.spreadsheetId,binding.fixedCaseId),personOwner:"automationPersonOwners/"+key(companyId,staffId),job:"jobs/"+jobId,staff:"staffProfiles/"+staffId,
    lock:"staffDayLocks/"+companyId+"_"+staffId+"_"+workDate};
  records.set(paths.policy,policy);
  records.set(paths.campaign,{companyId,producerId:"synthetic-producer",verification:"verified",evidenceRecordId:"synthetic-campaign-proof",campaign});
  records.set(paths.binding,binding);
  records.set(paths.bindingOwner,{companyId,jobId,spreadsheetId:binding.spreadsheetId,fixedCaseId:binding.fixedCaseId,revision:binding.revision});
  records.set(paths.personOwner,{companyId,staffId,personKey,revision:"person-1",active:true});
  records.set(paths.person,{companyId,staffId,personKey,active:true,revision:"person-1",verification:"verified",evidenceRecordId:"synthetic-person-proof"});
  records.set(paths.sender,{companyId,producerId:"synthetic-producer",uid:admin.uid,revision:"principal-1",active:true});
  records.set(paths.job,job);
  records.set(paths.staff,{companyId,displayName:"Synthetic Staff",active:true});
  return Object.assign(h,{paths,admin,staff,incoming,key,core, handoff:(data,auth=admin)=>load("./automation-notice-handoff").getAutomationNoticeHandoff({auth,data}), precontact:(data,auth=staff)=>load("./precontact").submitPreContact({auth,data}), receiveNotice:(data,auth=admin)=>load("./automation-notice-receipts").receiveAutomationNoticeReceipt({auth,data}), listNotices:(data,auth=admin)=>load("./automation-notice-receipts").listAutomationNoticeReceipts({auth,data}), cancelHeld:(data,auth=admin)=>intake.cancelHeldMailApplicationReview({auth,data}), listHeld:(data,auth=admin)=>intake.listHeldMailApplications({auth,data}), readHeld:(data,auth=admin)=>intake.getHeldMailApplication({auth,data}), recheckHeld:(data,auth=admin)=>intake.recheckHeldMailApplication({auth,data}), importSnapshot:(data,auth=admin)=>load("./automation-import-snapshot").getCaseMailImportSnapshot({auth,data}), previewCampaign:(data,auth=admin)=>load("./automation-campaigns").previewCaseMailCampaignRegistration({auth,data}), cancelCampaign:(data,auth=admin)=>load("./automation-campaigns").cancelCaseMailCampaignRegistration({auth,data}), registerCampaign:(data,auth=admin)=>load("./automation-campaigns").registerCaseMailCampaign({auth,data}), readCampaign:(data,auth=admin)=>load("./automation-campaigns").getCaseMailCampaignRegistration({auth,data}), registryCancel:(data,auth=admin)=>load("./automation-registry").cancelAutomationRegistryAttempt({auth,data}), registryRead:(data,auth=admin)=>load("./automation-registry").getAutomationRegistry({auth,data}), registry:(data,auth=admin)=>load("./automation-registry").saveAutomationRegistry({auth,data}),
    list:name=>[...records].filter(([path])=>path.startsWith(name+"/")).map(([path,data])=>({id:path.slice(name.length+1),...data})),
    listApplications:(data={},auth=staff)=>intake.listMyMailApplications({auth,data}),
    receive:(data=incoming,auth=admin)=>intake.receiveCaseMailApplication({auth,data}),
    appMode:()=>records.set(paths.policy,{...records.get(paths.policy),phase:"app",revision:"policy-2"}),
    apply:(candidate,requestId="synthetic-request-1",auth=staff,overrides={})=>jobs.applyToJob({auth,data:{jobId,requestId,...(candidate?{mailApplicationId:candidate.id,mailApplicationRevision:candidate.revision}:{}),...overrides}})});
}
