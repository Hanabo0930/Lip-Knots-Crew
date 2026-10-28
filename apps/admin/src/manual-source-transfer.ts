export type ManualSourceTransferConfirmation={confirmedFields:{arrival:true;execution:true;headcount:true;dateMode:true;payOffer:true};payOffer:{dailyWageJPY:number;travelExpenses:'全額支給';communicationExpenses:'全額支給'}};
export function validManualSourceTransferConfirmation(value:unknown):value is ManualSourceTransferConfirmation{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const data=value as Record<string,unknown>,fields=data.confirmedFields,offer=data.payOffer;
  if(Object.keys(data).sort().join(',')!=='confirmedFields,payOffer'||!fields||typeof fields!=='object'||Array.isArray(fields)||!offer||typeof offer!=='object'||Array.isArray(offer))return false;
  const confirmed=fields as Record<string,unknown>,pay=offer as Record<string,unknown>;
  return Object.keys(confirmed).sort().join(',')==='arrival,dateMode,execution,headcount,payOffer'&&Object.values(confirmed).every(value=>value===true)&&
    Object.keys(pay).sort().join(',')==='communicationExpenses,dailyWageJPY,travelExpenses'&&Number.isSafeInteger(pay.dailyWageJPY)&&Number(pay.dailyWageJPY)>=1&&Number(pay.dailyWageJPY)<=1000000&&pay.travelExpenses==='全額支給'&&pay.communicationExpenses==='全額支給';
}
export function readyManualSourceTransferIssue(issue:{operation:string;jobId:string;manualSourcePending?:boolean;manualTransferPending?:boolean;canSelectMonthlyTransfer?:boolean;manualObservationHash?:string|null;manualExpectedJobRevision?:number|null;manualExpectedSourceRevision?:string|null;job?:null|{workDate:string;clientName:string;storeName:string;assignedStaffName:string;makerName?:string;menuName?:string;entryTime?:string;workTime?:string}}):boolean{
  return Boolean(issue.job)&&[issue.job?.workDate,issue.job?.clientName,issue.job?.storeName,issue.job?.assignedStaffName,issue.job?.makerName,issue.job?.menuName,issue.job?.entryTime,issue.job?.workTime].every(value=>typeof value==='string'&&value.trim())&&issue.operation==='case_list.manual'&&issue.manualSourcePending===true&&issue.manualTransferPending===true&&issue.canSelectMonthlyTransfer===true&&
    /^[A-Za-z0-9_-]{1,200}$/.test(issue.jobId)&&/^[a-f0-9]{64}$/.test(issue.manualObservationHash??'')&&/^[a-f0-9]{64}$/.test(issue.manualExpectedSourceRevision??'')&&Number.isSafeInteger(issue.manualExpectedJobRevision)&&Number(issue.manualExpectedJobRevision)>=0;
}
