import type { ParsedShiftJob } from "./shift-import-types";
export type ShiftPreviewListRow = { caseId:string; sheetName:string; row:number; workDate:string; storeName:string; assignedStaffName:string; status:string };
export type ShiftPreviewList = { rows:ShiftPreviewListRow[]; complete:boolean };
export const PREVIEW_ROW_LIMIT=5000;
export const PREVIEW_BYTE_LIMIT=2*1024*1024;
// 原本の読取結果だけを返す。全件取得後のページ切替では再読取も書込も行わない。
export function createShiftPreviewRows(jobs:readonly ParsedShiftJob[]):ShiftPreviewList{
  const rows:ShiftPreviewListRow[]=[];let bytes=2;
  for(const job of jobs){
    if(rows.length>=PREVIEW_ROW_LIMIT)break;
    const row={caseId:job.caseId,sheetName:job.sheetRef.sheetName,row:job.sheetRef.currentRow,workDate:job.workDate,storeName:job.storeName,assignedStaffName:job.assignedStaffName,status:job.status};
    const size=Buffer.byteLength(JSON.stringify(row),"utf8")+(rows.length?1:0);
    if(bytes+size>PREVIEW_BYTE_LIMIT)break;
    rows.push(row);bytes+=size;
  }
  return {rows,complete:rows.length===jobs.length};
}
