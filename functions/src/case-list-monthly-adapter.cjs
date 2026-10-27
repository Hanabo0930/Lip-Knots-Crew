'use strict';
const Core=require('./case-list-monthly-controller.cjs');
const WRITABLE=['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'];
const clone=x=>JSON.parse(JSON.stringify(x));
function need(ok,code){if(!ok){const e=new Error(code);e.code=code;throw e;}}
function string(cell){return cell?.userEnteredValue?.stringValue||cell?.effectiveValue?.stringValue||'';}
function sourceRequests(intent,snapshot){
  need(intent?.spreadsheetId&&snapshot.spreadsheetId===intent.spreadsheetId,'SOURCE_SPREADSHEET_MISMATCH');
  Core.assertSnapshotCoverage(snapshot,intent.caseId,null);
  need(intent?.stage==='SOURCE_INTENT'&&snapshot.source.sheetId===2026101601,'SOURCE_INTENT_SCOPE');
  const rows=snapshot.source.rows.filter(r=>r.caseId===intent.caseId);need(rows.length===1,'SOURCE_ID_NOT_UNIQUE');
  const row=rows[0];need(row.row>=2&&row.cells.length===65,'SOURCE_ROW_SCOPE');
  need(intent.expectedSourceAfter?.[2]?.userEnteredValue?.stringValue===intent.assignment.staffName,'SOURCE_ASSIGNMENT_PATCH_INVALID');
  need(intent.expectedSourceAfter.every((c,i)=>i===2||Core.canonical(c)===Core.canonical(intent.sourceBefore[i])),'SOURCE_PATCH_OUTSIDE_C');
  return [{updateCells:{range:{sheetId:2026101601,startRowIndex:row.row-1,endRowIndex:row.row,startColumnIndex:2,endColumnIndex:3},rows:[{values:[{userEnteredValue:{stringValue:intent.assignment.staffName}}]}],fields:'userEnteredValue'}}];
}
function monthlyRequests(intent,snapshot){
  need(intent?.spreadsheetId&&snapshot.spreadsheetId===intent.spreadsheetId,'MONTHLY_SPREADSHEET_MISMATCH');
  Core.assertSnapshotCoverage(snapshot,intent.caseId,null);
  need(intent?.stage==='INTENT'&&intent.month?.title!=='2026.10','MONTHLY_INTENT_SCOPE');
  const month=snapshot.months.find(m=>m.title===intent.month.title&&m.sheetId===intent.month.sheetId);need(month,'MONTHLY_SHEET_NOT_FOUND');
  need(Core.BUSINESS_HEADERS.every((h,i)=>month.headers[i]===h),'MONTHLY_HEADERS_CHANGED');
  const width=intent.month.width;need([55,56].includes(width)&&intent.mapped.idColumn===width,'MONTHLY_WIDTH');
  need(month.headers.length===width&&month.headers[width-1]==='連絡_固定案件ID','MONTHLY_ID_HEADER');
  need(width!==56||month.headers[54]===''&&Core.canonical(intent.mapped.untouchedExtraColumns)==='[55]','DECEMBER_EXTRA_SCOPE');
  need(intent.mapped.business.length===54&&intent.mapped.idCell.userEnteredValue.stringValue===intent.caseId&&intent.fixedId===intent.caseId,'MONTHLY_CASE_ID_PRESERVATION');
  const target=intent.position.row;need(Number.isInteger(target)&&target>=2,'MONTHLY_TARGET_ROW');
  const requests=[];
  if(intent.position.append){need(month.isolated===true&&target===month.rowCount+1,'ISOLATED_APPEND_SCOPE');requests.push({appendDimension:{sheetId:month.sheetId,dimension:'ROWS',length:1}});}
  else{need(target<=month.rowCount&&intent.position.totalRow>=target,'MONTHLY_INSERT_BOUNDARY');requests.push({insertDimension:{range:{sheetId:month.sheetId,dimension:'ROWS',startIndex:target-1,endIndex:target},inheritFromBefore:true}});}
  // Every value mutation addresses the row created by the first request in this
  // same atomic batch. A stale human row index cannot overwrite an old row.
  requests.push({updateCells:{range:{sheetId:month.sheetId,startRowIndex:target-1,endRowIndex:target,startColumnIndex:0,endColumnIndex:54},rows:[{values:clone(intent.mapped.business)}],fields:WRITABLE.join(',')}});
  requests.push({updateCells:{range:{sheetId:month.sheetId,startRowIndex:target-1,endRowIndex:target,startColumnIndex:width-1,endColumnIndex:width},rows:[{values:[clone(intent.mapped.idCell)]}],fields:WRITABLE.join(',')}});
  if(width===56)need(requests.slice(1).every(r=>r.updateCells.range.startColumnIndex!==54),'DECEMBER_BC_VALUE_WRITE_FORBIDDEN');
  return requests;
}
function snapshotFromNative({metadata,cells,dependencyHash,catalog,resolveStaff,isolated=false}){
  const bookId=metadata.spreadsheetId;need(bookId&&cells.spreadsheetId===bookId,'SNAPSHOT_BOOK_MISMATCH');
  need(typeof dependencyHash==='string'&&/^[0-9a-f]{64}$/.test(dependencyHash),'DEPENDENCY_HASH_REQUIRED');
  need(metadata.properties?.timeZone==='Asia/Tokyo','SNAPSHOT_TIMEZONE');
  const requestedFields=cells.requestedCellFields||'';
  need(['effectiveValue',...WRITABLE].every(f=>new RegExp('(?:^|[,(/])'+f+'(?:$|[,(/])').test(requestedFields)),'NATIVE_CELL_FIELDS_PROVENANCE_REQUIRED');
  function table(title,width){
    const meta=metadata.sheets.filter(s=>s.properties.title===title);need(meta.length===1,'SHEET_TITLE_NOT_UNIQUE');
    const p=meta[0].properties;need(p.gridProperties.columnCount===width,'SHEET_WIDTH_CHANGED');
    const data=cells.sheets.find(s=>s.properties.sheetId===p.sheetId);need(data,'SHEET_DATA_MISSING');
    const matrix=Array.from({length:p.gridProperties.rowCount},()=>Array.from({length:width},()=>({}))),coverage=Array.from({length:p.gridProperties.rowCount},()=>Array(width).fill(false));
    for(const block of data.data||[])for(const [ri,row]of (block.rowData||[]).entries())for(const [ci,cell]of (row.values||[]).entries()){
      const r=(block.startRow||0)+ri,c=(block.startColumn||0)+ci;need(r<matrix.length&&c<width,'GRID_DATA_OUTSIDE_BOUNDS');if(coverage[r][c])need(Core.canonical(matrix[r][c])===Core.canonical(cell),'OVERLAPPING_NATIVE_READ_CHANGED');matrix[r][c]=clone(cell);coverage[r][c]=true;
    }
    // Native omits trailing empty cells. Require the adapter's exact bounded A1
    // read contract, rather than mistaking omission for permission to read less.
    const requested=(cells.requestedRanges||[]).filter(r=>r.sheetId===p.sheetId),proven=Array.from({length:p.gridProperties.rowCount},()=>new Uint8Array(width));
    for(const range of requested){need([range.startRow,range.rowCount,range.startColumn,range.columnCount].every(Number.isInteger)&&range.startRow>=0&&range.rowCount>0&&range.startColumn>=0&&range.columnCount>0&&range.startRow+range.rowCount<=proven.length&&range.startColumn+range.columnCount<=width,'NATIVE_REQUEST_PROVENANCE_BOUNDS');for(let r=range.startRow;r<range.startRow+range.rowCount;r++)proven[r].fill(1,range.startColumn,range.startColumn+range.columnCount);}
    need(proven.every(row=>row.every(x=>x===1)),'FULL_BOUNDED_RANGE_PROVENANCE_REQUIRED');
    return {sheetId:p.sheetId,title,rowCount:p.gridProperties.rowCount,headers:matrix[0].map(string),rows:matrix.slice(1).map((row,i)=>({row:i+2,cells:row})),isolated};
  }
  const source=table('案件リスト',65);source.rows=source.rows.map(r=>({...r,caseId:string(r.cells[60]),...identity(string(r.cells[2]))}));
  for(const row of source.rows.filter(r=>r.caseId)){
    need(typeof row.cells[1].userEnteredValue?.numberValue!=='number'||row.cells[1].effectiveValue?.numberValue===row.cells[1].userEnteredValue.numberValue,'SOURCE_DATE_EFFECTIVE_READ_MISSING');
    if(typeof row.cells[2].userEnteredValue?.stringValue==='string'&&row.cells[2].userEnteredValue.stringValue)need(row.cells[2].effectiveValue?.stringValue===row.cells[2].userEnteredValue.stringValue,'SOURCE_NAME_EFFECTIVE_READ_MISSING');
    for(const targetColumn of Core.FINANCIAL_COLUMNS){const cell=row.cells[targetColumn];if(typeof cell.userEnteredValue?.numberValue==='number')need(cell.effectiveValue?.numberValue===cell.userEnteredValue.numberValue,'SOURCE_MANUAL_FEE_EFFECTIVE_READ_MISSING');}
  }
  const monthTitles=cells.requestedMonthTitles||metadata.sheets.map(s=>s.properties).filter(p=>/^20\d\d\.(?:[1-9]|1[012])$/.test(p.title)&&Number(p.title.split('.')[0])*100+Number(p.title.split('.')[1])>=202611).map(p=>p.title);
  need(monthTitles.length>0&&new Set(monthTitles).size===monthTitles.length,'MONTH_SCOPE_REQUIRED');
  const months=monthTitles.map(title=>{const meta=metadata.sheets.find(s=>s.properties.title===title);need(meta,'MONTH_METADATA_MISSING');const m=table(title,meta.properties.gridProperties.columnCount);need([55,56].includes(m.headers.length),'MONTHLY_WIDTH');m.rows=m.rows.map(r=>({...r,fixedId:string(r.cells[m.headers.length-1]),...identity(string(r.cells[1]))}));return m;});
  function identity(name){if(!name||/^[（(][0-9０-９]+人[）)]$/.test(name.normalize('NFKC')))return {};const p=resolveStaff(name);return p?.staffId&&p.identityVerified===true?{staffId:p.staffId,staffIdentityVerified:true}:{staffIdentityVerified:false};}
  return {spreadsheetId:bookId,isolated,source,months,dependencyHash,catalog:catalog?clone(catalog):null};
}
function createGoogleSheetsMutationAdapter({spreadsheetId,transport,readSnapshot,hash}){
  need(typeof spreadsheetId==='string'&&transport&&typeof transport.batchUpdate==='function'&&typeof readSnapshot==='function'&&typeof hash==='function','NATIVE_ADAPTER_ARGUMENTS');
  async function source(intent){
    let snapshot=await readSnapshot({operationId:intent.operationId,caseId:intent.caseId});
    need(snapshot.spreadsheetId===spreadsheetId&&intent.spreadsheetId===spreadsheetId,'SOURCE_BOUND_BOOK_MISMATCH');
    Core.assertSnapshotCoverage(snapshot,intent.caseId,{sha256:hash});
    Core.assertSourceAssignmentPreflight(snapshot,intent,{sha256:hash});
    const row=snapshot.source.rows.find(r=>r.caseId===intent.caseId);
    need(row&&Core.contentHash({sha256:hash},row.cells)===intent.preMonthlyContentHash,'SOURCE_NATIVE_PREIMAGE_CHANGED');
    need(snapshot.dependencyHash===intent.dependencyHash,'SOURCE_NATIVE_DEPENDENCIES_CHANGED');
    const requests=sourceRequests(intent,snapshot);snapshot=null;
    return transport.batchUpdate({spreadsheetId,requests});
  }
  async function monthly(intent){
    let snapshot=await readSnapshot({operationId:intent.operationId,caseId:intent.caseId});
    need(snapshot.spreadsheetId===spreadsheetId&&intent.spreadsheetId===spreadsheetId,'MONTHLY_BOUND_BOOK_MISMATCH');
    Core.assertSnapshotCoverage(snapshot,intent.caseId,{sha256:hash});
    Core.assertMonthlyWritePreflight(snapshot,intent,{sha256:hash});
    let row=snapshot.source.rows.find(r=>r.caseId===intent.caseId),month=snapshot.months.find(m=>m.sheetId===intent.month.sheetId);
    need(row&&Core.contentHash({sha256:hash},row.cells)===intent.sourceContentHash&&snapshot.dependencyHash===intent.dependencyHash,'MONTHLY_NATIVE_PREIMAGE_CHANGED');
    need(month&&Core.monthLayoutHash({sha256:hash},month,intent.month.snapshotProfile||Core.LEGACY_LAYOUT)===intent.month.contentHash,'MONTHLY_NATIVE_LAYOUT_CHANGED');
    const requests=monthlyRequests(intent,snapshot);snapshot=null;row=null;month=null;
    return transport.batchUpdate({spreadsheetId,requests});
  }
  return {applySourceAssignment:source,applyMonthly:monthly};
}
module.exports={sourceRequests,monthlyRequests,snapshotFromNative,createGoogleSheetsMutationAdapter};
