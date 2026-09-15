import {createHash} from "node:crypto";
import {Timestamp} from "firebase-admin/firestore";
import {z} from "zod";
import {db} from "./firebase";
import {AutomationBindingSchema,prepareAutomationHandoff,type AutomationBinding} from "./automation-bridge-core";

const id=z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/),hash=z.string().regex(/^[a-f0-9]{64}$/);
const PersonSchema=z.object({companyId:id,staffId:id,personKey:hash,revision:id,active:z.literal(true),verification:z.literal("verified"),evidenceRecordId:id});
const ProofSchema=z.object({version:z.literal(1),bindingRevision:id,bindingHash:hash,personRevision:id,evidenceHash:hash,confirmedAt:z.instanceof(Timestamp)}).strict();
type Reader={get(ref:FirebaseFirestore.DocumentReference):Promise<FirebaseFirestore.DocumentSnapshot>};
export type AutomationJobContext={binding:AutomationBinding;bindingHash:string;personRevision:string|null};
export const automationProofDigest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
const scoped=(name:string,...parts:string[])=>db.collection(name).doc(automationProofDigest(parts));

/** 任意の連携台帳を現在の案件と照合する。未登録なら通常の本人入力は継続できる。 */
export async function readAutomationJobContext(tx:Reader,companyId:string,jobId:string,job:Record<string,unknown>):Promise<AutomationJobContext|null>{
 const parsed=AutomationBindingSchema.safeParse((await tx.get(scoped("automationBindings",companyId,jobId))).data());
 if(!parsed.success||parsed.data.companyId!==companyId||parsed.data.jobId!==jobId)return null;
 const binding=parsed.data;
 try{prepareAutomationHandoff({companyId,binding,job:{...job,id:jobId},revision:"proof-check"});}catch{return null;}
 const assignment=binding.assignment;
 const [ownerSnap,personSnap,personOwnerSnap,staffSnap]=await Promise.all([
  tx.get(scoped("automationBindingOwners",companyId,binding.spreadsheetId,binding.fixedCaseId)),
  assignment?tx.get(scoped("automationPeople",companyId,assignment.personKey)):Promise.resolve(null),
  assignment?tx.get(scoped("automationPersonOwners",companyId,assignment.staffId)):Promise.resolve(null),
  assignment?tx.get(db.collection("staffProfiles").doc(assignment.staffId)):Promise.resolve(null),
 ]);
 const owner=ownerSnap.data(),person=PersonSchema.safeParse(personSnap?.data()),personOwner=personOwnerSnap?.data(),staff=staffSnap?.data();
 if(!owner||owner.companyId!==companyId||owner.jobId!==jobId||owner.spreadsheetId!==binding.spreadsheetId||owner.fixedCaseId!==binding.fixedCaseId||owner.revision!==binding.revision)return null;
 if(assignment&&(!person.success||person.data.companyId!==companyId||person.data.personKey!==assignment.personKey||person.data.staffId!==assignment.staffId||
   !personOwner||personOwner.companyId!==companyId||personOwner.staffId!==assignment.staffId||personOwner.personKey!==assignment.personKey||
   personOwner.revision!==person.data.revision||personOwner.active!==true||staff?.companyId!==companyId||staff.active!==true))return null;
 return {binding,bindingHash:automationProofDigest(binding),personRevision:assignment&&person.success?person.data.revision:null};
}

/** 保存済みの本人入力だけを正規化する。シート値・文字列の体温・操作IDなしは証跡にしない。 */
export function automationPreContactEvidence(value:unknown){
 const parsed=z.object({source:z.literal("app"),staffId:id,dateKey:z.iso.date(),operationId:id,
  temperature:z.number().min(34).max(42),arrivalTime:z.string().regex(/^([01]?\d|2[0-3]):[0-5]\d$/),submittedAt:z.instanceof(Timestamp)}).safeParse(value);
 if(!parsed.success)return null;
 const row=parsed.data;
 return {source:row.source,staffId:row.staffId,dateKey:row.dateKey,operationId:row.operationId,
  temperature:row.temperature,arrivalTime:row.arrivalTime.padStart(5,"0"),submittedAt:row.submittedAt.toDate().toISOString()};
}
export function makeAutomationPreContactProof(context:AutomationJobContext|null,value:unknown,confirmedAt:Timestamp){
 const evidence=automationPreContactEvidence(value);
 if(!context?.binding.assignment||!context.personRevision||!evidence||
   evidence.staffId!==context.binding.assignment.staffId||evidence.dateKey!==context.binding.workDate)return null;
 return {version:1 as const,bindingRevision:context.binding.revision,bindingHash:context.bindingHash,personRevision:context.personRevision,
  evidenceHash:automationProofDigest(evidence),confirmedAt};
}
export function matchesAutomationPreContactProof(context:AutomationJobContext|null,value:unknown,proof:unknown){
 const parsed=ProofSchema.safeParse(proof);
 if(!parsed.success)return false;
 const expected=makeAutomationPreContactProof(context,value,parsed.data.confirmedAt),evidence=automationPreContactEvidence(value);
 return !!expected&&!!evidence&&parsed.data.confirmedAt.toDate().toISOString()>=evidence.submittedAt&&
  parsed.data.bindingRevision===expected.bindingRevision&&parsed.data.bindingHash===expected.bindingHash&&
  parsed.data.personRevision===expected.personRevision&&parsed.data.evidenceHash===expected.evidenceHash;
}
