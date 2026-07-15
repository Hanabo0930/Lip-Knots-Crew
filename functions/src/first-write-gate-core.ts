export type GateInput={
 targetSpreadsheetId:string;verifiedSpreadsheetId:string;productionSpreadsheetId?:string|null;
 gasAuditGrade:string;gasBlockers:number;formulaDifferenceCount:number;
 validationDifferenceCount:number;conditionalFormatDifferenceCount:number;
 protectedRangeDifferenceCount:number;billingDifferenceYen:number;
 payrollDifferenceYen:number;pdfDifferenceCount:number;mailRecipientDifferenceCount:number;
 unresolvedManualInterventions:number;writeMappingEnabled:boolean;
 rowCreationEnabled:boolean;monthCreationEnabled:boolean;explicitConfirmation:string;
};
export function evaluateFirstWriteGate(i:GateInput){
 const checks=[
  c("verified","検証コピーID一致",i.targetSpreadsheetId===i.verifiedSpreadsheetId,true),
  c("not_prod","本番スプシではない",!i.productionSpreadsheetId||i.targetSpreadsheetId!==i.productionSpreadsheetId,true),
  c("grade","GAS監査A/B",["A","B"].includes(i.gasAuditGrade),true),
  c("blockers","重大・高リスク0",i.gasBlockers===0,true),
  c("formula","数式差異0",i.formulaDifferenceCount===0,true),
  c("validation","入力規則差異0",i.validationDifferenceCount===0,true),
  c("conditional","条件付き書式差異0",i.conditionalFormatDifferenceCount===0,true),
  c("protection","保護範囲差異0",i.protectedRangeDifferenceCount===0,true),
  c("billing","請求差異0円",i.billingDifferenceYen===0,true),
  c("payroll","給与差異0円",i.payrollDifferenceYen===0,true),
  c("pdf","PDF差異0",i.pdfDifferenceCount===0,true),
  c("mail","メール対象差異0",i.mailRecipientDifferenceCount===0,true),
  c("manual","手動確認0",i.unresolvedManualInterventions===0,true),
  c("mapping","安全書込ON",i.writeMappingEnabled,true),
  c("rows","行追加ON",i.rowCreationEnabled,true),
  c("month","新月作成ON",i.monthCreationEnabled,false),
  c("confirm","確認文一致",i.explicitConfirmation==="検証コピーへ初回書込",true),
 ];
 const blockingFailures=checks.filter(x=>x.blocking&&!x.ok);
 return {allowed:blockingFailures.length===0,checks,blockingFailures};
}
function c(key:string,label:string,ok:boolean,blocking:boolean){return{key,label,ok,blocking};}
