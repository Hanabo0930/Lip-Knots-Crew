import {onCall,HttpsError} from "firebase-functions/v2/https";
import {z} from "zod";
import {db} from "./firebase";
import {requireAdmin,companyFromClaims} from "./utils";
import {assertProductionOperational} from "./system-safety";
import {tokyoParts} from "./notification-time";
import {automationRecordKey} from "./automation-intake";
import {AutomationBindingSchema,prepareAutomationHandoff} from "./automation-bridge-core";
import {RecruitmentRoutingSchema} from "./automation-recruitment-core";
const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/);
const day=z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value=>{const date=new Date(value+"T00:00:00Z");return Number.isFinite(date.valueOf())&&date.toISOString().slice(0,10)===value;});
const TargetsSchema=z.object({version:z.literal(1),kind:z.literal("recruitment.import-targets"),companyId:id,sourceOperationId:id,
  area:z.enum(["normal","tohoku"]),cases:z.array(z.object({fixedCaseId:id,workDate:day}).strict()).min(1).max(100)}).strict()
  .refine(value=>new Set(value.cases.map(row=>row.fixedCaseId)).size===value.cases.length,"同じ固定IDが重複しています。");
const InputSchema=z.object({expectedCompanyId:id,expectedActorUid:id,targets:TargetsSchema}).strict();
const OwnerSchema=z.object({companyId:id,jobId:id,spreadsheetId:id,fixedCaseId:id,revision:id});
const JobSchema=z.object({id,companyId:id,caseId:id,dateKey:day,status:z.string(),assignedStaffId:id.nullish(),
  publishable:z.boolean().optional(),cancelled:z.boolean().optional(),recruitmentStopped:z.boolean().optional(),
  sourceMissing:z.boolean().optional(),assignmentUnresolved:z.boolean().optional(),applicationUnconfirmed:z.boolean().optional(),
  revision:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),sheetRef:z.object({spreadsheetId:id})});
const scoped=(name:string,...parts:string[])=>db.collection(name).doc(automationRecordKey(...parts));
function fail(message:string):never{throw new HttpsError("failed-precondition",message);}
function own(value:FirebaseFirestore.DocumentData|undefined,companyId:string){
  if(value&&value.companyId!==companyId)fail("別の所属の記録が含まれています。");return value;
}
/** 募集対象の読取スナップショット。登録・原本書戻し・メール送信は行わない。 */
export const getCaseMailImportSnapshot=onCall(async request=>{
  const session=requireAdmin(request),companyId=id.parse(companyFromClaims(session.token)),input=InputSchema.parse(request.data);
  if(input.expectedCompanyId!==companyId||input.expectedActorUid!==session.uid||input.targets.companyId!==companyId)
    throw new HttpsError("permission-denied","対象データとログイン中の所属・管理者が一致しません。");
  await assertProductionOperational(companyId);
  return db.runTransaction(async tx=>{
    const [senderSnap,policySnap]=await Promise.all([
      tx.get(scoped("automationIngestPrincipals",companyId,session.uid)),
      tx.get(db.collection("automationRecruitmentPolicies").doc(companyId)),
    ]);
    const sender=own(senderSnap.data(),companyId);
    if(!sender||sender.uid!==session.uid||sender.active!==true||!id.safeParse(sender.producerId).success||!id.safeParse(sender.revision).success)
      throw new HttpsError("permission-denied","現在の連携実行者を確認できません。連携台帳を確認してください。");
    const parsedPolicy=RecruitmentRoutingSchema.safeParse(own(policySnap.data(),companyId));
    if(!parsedPolicy.success||parsedPolicy.data.phase!=="mail_bridge")fail("募集の受付はアプリへ移行しているか、受付設定を確認できません。");
    const now=new Date(),today=tokyoParts(now).dateKey;
    const found=await Promise.all(input.targets.cases.map(async target=>{
      if(target.workDate<=today)fail("勤務日が当日以前の募集は取り込めません。元の募集を確認してください。");
      const owners=await tx.get(db.collection("automationBindingOwners").where("companyId","==",companyId).where("fixedCaseId","==",target.fixedCaseId).limit(2));
      if(owners.docs.length!==1)fail("固定IDの対応が未登録か、複数の元表に一致しています。連携台帳を確認してください。");
      const ownerSnap=owners.docs[0]!,parsedOwner=OwnerSchema.safeParse(own(ownerSnap.data(),companyId));
      if(!parsedOwner.success)fail("固定IDの所有記録を確認できません。");
      const owner=parsedOwner.data;
      if(owner.fixedCaseId!==target.fixedCaseId||ownerSnap.id!==automationRecordKey(companyId,owner.spreadsheetId,target.fixedCaseId))
        fail("固定IDの保存先と所有記録が一致しません。");
      const [bindingSnap,jobSnap]=await Promise.all([tx.get(scoped("automationBindings",companyId,owner.jobId)),tx.get(db.collection("jobs").doc(owner.jobId))]);
      const parsedBinding=AutomationBindingSchema.safeParse(own(bindingSnap.data(),companyId)),rawJob=own(jobSnap.data(),companyId);
      if(!parsedBinding.success||!rawJob)fail("現在の連携台帳または案件を確認できません。");
      const binding=parsedBinding.data,parsedJob=JobSchema.safeParse({...rawJob,id:owner.jobId,revision:rawJob.revision??0});
      if(!parsedJob.success)fail("現在の案件内容または確認版を読み取れません。");
      const job=parsedJob.data;
      if(binding.jobId!==owner.jobId||binding.spreadsheetId!==owner.spreadsheetId||binding.fixedCaseId!==target.fixedCaseId||
        binding.workDate!==target.workDate||binding.revision!==owner.revision)fail("固定ID・勤務日・台帳版が現在の所有記録と一致しません。");
      let eligible=false;
      try{eligible=prepareAutomationHandoff({companyId,binding,job,revision:String(job.revision)}).recruitmentEligible;}
      catch{fail("案件と連携台帳の照合が完了していません。");}
      if(!eligible)fail("現在は募集できない案件が含まれています。");
      // スタッフ、連絡先、住所、内部メモ等は読取結果へ含めない。
      return {record:{binding,job:{...job,assignedStaffId:null},owner},
        summary:{fixedCaseId:target.fixedCaseId,workDate:target.workDate,jobId:job.id,appCaseId:job.caseId,
          storeName:typeof rawJob.storeName==="string"&&rawJob.storeName.trim()?rawJob.storeName.slice(0,200):null}};
    }));
    if(new Set(found.map(row=>row.record.job.id)).size!==found.length)fail("複数の固定IDが同じ案件へ対応しています。");
    return {ok:true,snapshot:{version:1,companyId,capturedAt:now.toISOString(),policy:parsedPolicy.data,records:found.map(row=>row.record)},
      summary:found.map(row=>row.summary),dispatch:"disabled"};
  });
});
