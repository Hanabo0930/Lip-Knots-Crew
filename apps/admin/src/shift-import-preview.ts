export type ShiftPreviewRow = { caseId:string; sheetName:string; row:number; workDate:string; storeName:string; assignedStaffName:string; status:string };
export type ShiftImportPreview = { spreadsheetId:string|null; totalJobs:number; totalSheets:number; unresolvedStaff:number; samples:ShiftPreviewRow[]; warnings:string[] };
const statuses=new Set(["open","assigned","stopped","cancelled","draft"]);
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("読取結果の形式を確認できません。");return value as Record<string,unknown>;}
function count(value:unknown):number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0)throw new Error("読取結果の件数を確認できません。");return value;}
function text(value:unknown):string{if(typeof value!=="string")throw new Error("読取結果の案件情報を確認できません。");return value;}
export function parseShiftImportPreview(value:unknown):ShiftImportPreview{
  const data=record(value),totals=record(data.totals);
  if(!Array.isArray(data.samples)||data.samples.length>20||!Array.isArray(data.warnings)||data.warnings.some(v=>typeof v!=="string"))throw new Error("読取結果の一覧を確認できません。");
  const samples=data.samples.map(value=>{const row=record(value),status=text(row.status),sourceRow=count(row.row);if(!statuses.has(status)||sourceRow<1)throw new Error("読取結果の状態・参照行を確認できません。");return {caseId:text(row.caseId),sheetName:text(row.sheetName),row:sourceRow,workDate:text(row.workDate),storeName:text(row.storeName),assignedStaffName:text(row.assignedStaffName),status};});
  const totalJobs=count(totals.jobs);if(samples.length>totalJobs)throw new Error("読取結果の件数と一覧が一致しません。");
  const spreadsheetId=typeof data.spreadsheetId==="string"&&/^[A-Za-z0-9_-]{10,}$/.test(data.spreadsheetId)?data.spreadsheetId:null;
  return {spreadsheetId,totalJobs,totalSheets:count(totals.sheets),unresolvedStaff:count(totals.unresolvedStaff),samples,warnings:data.warnings.slice(0,200) as string[]};
}
export function previewSheetNames(month:string):string[]|undefined{
  if(!month)return undefined;
  const match=/^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);if(!match)throw new Error("対象月を選択してください。");
  return [match[1]+"."+Number(match[2])];
}
