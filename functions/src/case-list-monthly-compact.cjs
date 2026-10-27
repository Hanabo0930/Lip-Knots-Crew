'use strict';
// Deterministic constructor for recorded, bounded Google reads. No I/O.
// UNKNOWN is distinct from a proven empty cell; partial rows never prove fees,
// formulas, notes, formatting, validation or chips outside their read profile.
const {createHash}=require('node:crypto');
const {HEADERS}=require('./case-list-projection.cjs');
const UNKNOWN=Object.freeze({$unknown:true}), EMPTY=Object.freeze({});
const VALUE_FIELDS=['userEnteredValue','effectiveValue'];
const FULL_FIELDS=['userEnteredValue','effectiveValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'];
const SOURCE_COLUMNS=[1,2,10,60,63];
const LEDGER_HEADERS=['固定ID','実施日（保存）','会社（保存）','店舗表示（保存）','メーカー（保存）','内容（保存）','入店（保存）','実施時間（保存）','手配判定','確認済担当','募集の終了理由','確認の根拠','確認者','確認日時','募集期限日（任意）','備考','元Source状態','元取消','元Source担当','業務根拠JSON','元注意事項','内部店舗キー','保存日時','元revision','元Word現行'];
const DEPENDENCIES=['スタッフマスタ','各社見積書','イオンデモ遠方リスト','ケイ_応募日補助'];
function fail(code){const e=new Error(code);e.code=code;throw e;}
function need(ok,code){if(!ok)fail(code);}
function canonical(x){if(x===null||typeof x==='string'||typeof x==='boolean')return JSON.stringify(x);if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';fail('COMPACT_NON_CANONICAL');}
const hash=x=>createHash('sha256').update(canonical(x),'utf8').digest('hex');
const valueProjection=c=>({userEnteredValue:c.userEnteredValue||{},effectiveValue:c.effectiveValue||{}});
function scalar(c){need(c&&!c.$unknown,'COMPACT_UNKNOWN_VALUE');const u=c.userEnteredValue||{},v=Object.hasOwn(u,'formulaValue')?c.effectiveValue||{}:u;need(!v.errorValue,'COMPACT_CELL_ERROR');return Object.values(v)[0]??'';}
const text=c=>{const v=scalar(c);return typeof v==='string'?v.trim():'';};
const unwrap=x=>x?.structuredContent?.spreadsheetId?x.structuredContent:x?.data?.spreadsheetId?x.data:x;
function book(metadata){const m=unwrap(metadata);need(m&&typeof m.spreadsheetId==='string'&&/^[A-Za-z0-9_-]{10,180}$/.test(m.spreadsheetId)&&m.properties?.timeZone==='Asia/Tokyo'&&Array.isArray(m.sheets),'COMPACT_BOOK_METADATA');return m;}
function bound(metadata,title,id,width,maxRows=10000){const found=metadata.sheets.filter(s=>s.properties?.title===title);need(found.length===1,'COMPACT_SHEET_TITLE');const p=found[0].properties,g=p.gridProperties;need(Number.isInteger(p.sheetId)&&p.sheetId>=0&&(id===undefined||p.sheetId===id)&&Number.isInteger(g?.rowCount)&&g.rowCount>0&&g.rowCount<=maxRows&&Number.isInteger(g?.columnCount)&&g.columnCount>0&&g.columnCount<=100&&(width===undefined||g.columnCount===width),'COMPACT_SHEET_STRUCTURE');return {sheetId:p.sheetId,title,rowCount:g.rowCount,columnCount:g.columnCount};}
function bindings(metadata){const b={source:bound(metadata,'案件リスト',2026101601,65,5001),ledger:bound(metadata,'案件_実績台帳',2026102605,25,5005),months:[bound(metadata,'2026.11',1773116117,55),bound(metadata,'2026.12',434431224,56)]};need(b.ledger.rowCount>=3,'COMPACT_LEDGER_HEADER_BOUNDS');return b;}
function column(n){let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
function columnNumber(s){return [...s].reduce((a,c)=>a*26+c.charCodeAt(0)-64,0)-1;}
const a1=(b,r0,r1,c0,c1)=>"'"+b.title.replace(/'/g,"''")+"'!"+column(c0+1)+(r0+1)+':'+column(c1)+(r1);
function rectangle(metadata,a){const match=/^'((?:[^']|'')+)'!([A-Z]+)([1-9]\d*):([A-Z]+)([1-9]\d*)$/.exec(a);need(match,'COMPACT_A1_BOUNDS_REQUIRED');const b=bound(metadata,match[1].replace(/''/g,"'")),r0=Number(match[3])-1,r1=Number(match[5]),c0=columnNumber(match[2]),c1=columnNumber(match[4])+1;need(r0>=0&&r1>r0&&r1<=b.rowCount&&c0>=0&&c1>c0&&c1<=b.columnCount,'COMPACT_RANGE_OUTSIDE_BOUNDS');return {...b,r0,r1,c0,c1};}
function state(b){return {bound:b,rows:Array.from({length:b.rowCount},()=>Array(b.columnCount).fill(UNKNOWN)),known:Array.from({length:b.rowCount},()=>new Set()),full:new Set()};}
const sameRect=(a,b)=>a.sheetId===b.sheetId&&a.r0===b.r0&&a.r1===b.r1&&a.c0===b.c0&&a.c1===b.c1;
const inside=(a,r,c)=>r>=a.r0&&r<a.r1&&c>=a.c0&&c<a.c1;
function indexRectangles(b){const out=[];function add(s,r0,r1,c0,c1){if(r1>r0)out.push({...s,r0,r1,c0,c1});}add(b.source,0,1,0,65);add(b.source,1,b.source.rowCount,1,3);for(const c of [10,60,63])add(b.source,1,b.source.rowCount,c,c+1);add(b.ledger,2,3,0,25);add(b.ledger,3,b.ledger.rowCount,0,1);for(const m of b.months){add(m,0,1,0,m.columnCount);add(m,1,m.rowCount,0,2);add(m,1,m.rowCount,9,15);add(m,1,m.rowCount,m.columnCount-1,m.columnCount);}need(out.reduce((n,r)=>n+(r.r1-r.r0)*(r.c1-r.c0),0)<=50000,'COMPACT_INDEX_CELL_BUDGET_EXCEEDED');return out;}
function describeRead(metadata,read,allowed,full){
  const request=read?.request,response=unwrap(read?.response);need(request&&request.includeGridData===true&&Array.isArray(request.ranges)&&request.ranges.length&&response,'COMPACT_RECORDED_GRID_READ_REQUIRED');
  need((request.spreadsheetId??request.spreadsheet_id)===metadata.spreadsheetId&&response.spreadsheetId===metadata.spreadsheetId,'COMPACT_READ_BOOK_MISMATCH');
  const fields=request.cell_fields??request.cellFields??request.fields;need(typeof fields==='string'&&(full?FULL_FIELDS:VALUE_FIELDS).every(f=>new RegExp('\\b'+f+'\\b').test(fields)),'COMPACT_CELL_FIELDS_MISSING');
  if(!full)need(FULL_FIELDS.slice(2).every(f=>!new RegExp('\\b'+f+'\\b').test(fields)),'COMPACT_INDEX_FORMAT_READ_FORBIDDEN');
  const rectangles=request.ranges.map(a=>rectangle(metadata,a));
  need(rectangles.every(r=>allowed.some(a=>sameRect(r,a))),'COMPACT_READ_SCOPE_UNAPPROVED');
  const proof=book(response);need(proof.spreadsheetId===metadata.spreadsheetId,'COMPACT_RESPONSE_BOOK_CHANGED');if(read.metadataAfter){const after=book(read.metadataAfter);need(after.spreadsheetId===metadata.spreadsheetId,'COMPACT_RESPONSE_BOOK_CHANGED');for(const r of rectangles){const p=bound(after,r.title,r.sheetId,r.columnCount);need(p.rowCount===r.rowCount,'COMPACT_STRUCTURE_CHANGED');}}
  for(const r of rectangles){const p=bound(proof,r.title,r.sheetId,r.columnCount);need(p.rowCount===r.rowCount,'COMPACT_STRUCTURE_CHANGED');}
  return {request,response,rectangles};
}
function applyRead(metadata,read,allowed,states,full){
  const {response,rectangles}=describeRead(metadata,read,allowed,full);
  // Most cells are first reads. Keep only overlapping preimages, rather than
  // a second Map of every indexed/dependency cell beside the native response.
  const overlaps=new Map();
  for(const r of rectangles){const state=states.get(r.sheetId);need(state,'COMPACT_STATE_MISSING');for(let i=r.r0;i<r.r1;i++)for(let j=r.c0;j<r.c1;j++){
    const key=r.sheetId+':'+i+':'+j;if(state.known[i].has(j)){if(!overlaps.has(key))overlaps.set(key,{before:state.rows[i][j],after:EMPTY});}else{state.rows[i][j]=EMPTY;state.known[i].add(j);}
  }}
  for(const sheet of response.sheets||[])for(const grid of sheet.data||[]){const row0=grid.startRow??0,col0=grid.startColumn??0;need(Number.isInteger(row0)&&row0>=0&&Number.isInteger(col0)&&col0>=0,'COMPACT_GRID_OFFSET');for(const [ri,row]of(grid.rowData||[]).entries())for(const [ci,cell]of(row.values||[]).entries()){
    const r=row0+ri,c=col0+ci;need(rectangles.some(a=>a.sheetId===sheet.properties?.sheetId&&inside(a,r,c)),'COMPACT_RETURNED_CELL_OUTSIDE_REQUEST');need(cell&&typeof cell==='object'&&!Array.isArray(cell),'COMPACT_CELL_SHAPE');const overlap=overlaps.get(sheet.properties.sheetId+':'+r+':'+c);if(overlap)overlap.after=cell;states.get(sheet.properties.sheetId).rows[r][c]=cell;
  }}
  for(const overlap of overlaps.values())need(canonical(valueProjection(overlap.before))===canonical(valueProjection(overlap.after)),'COMPACT_INDEX_FULL_VALUE_CHANGED');
  if(full)for(const r of rectangles){need(r.r1===r.r0+1&&r.c0===0&&r.c1===r.columnCount,'COMPACT_FULL_ROW_REQUIRED');states.get(r.sheetId).full.add(r.r0);}
}
function requireColumns(s,row,columns){need(columns.every(c=>s.known[row]?.has(c)),'COMPACT_COVERAGE_INCOMPLETE');}
function uniqueIds(s,column,start,code){const map=new Map();for(let r=start;r<s.bound.rowCount;r++){requireColumns(s,r,[column]);const id=text(s.rows[r][column]);if(!id)continue;need(!map.has(id.toLowerCase()),code);map.set(id.toLowerCase(),{id,row:r});}return map;}
function prepare(metadataInput,indexReads,caseId){const metadata=book(metadataInput),b=bindings(metadata);need(/^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(caseId),'COMPACT_CASE_ID_REQUIRED');const states=new Map([b.source,b.ledger,...b.months].map(x=>[x.sheetId,state(x)])),allowed=indexRectangles(b);need(Array.isArray(indexReads)&&indexReads.length,'COMPACT_INDEX_READ_REQUIRED');for(const read of indexReads)applyRead(metadata,read,allowed,states,false);
  const source=states.get(b.source.sheetId),ledger=states.get(b.ledger.sheetId);requireColumns(source,0,[...Array(65).keys()]);requireColumns(ledger,2,[...Array(25).keys()]);const header=source.rows[0].map(text);need(header.every((h,i)=>h===HEADERS[i]||(i===0&&['キャンセル','月別転記'].includes(h))),'COMPACT_SOURCE_HEADERS');need(canonical(ledger.rows[2].map(text))===canonical(LEDGER_HEADERS),'COMPACT_LEDGER_HEADERS');
  for(let r=1;r<b.source.rowCount;r++){requireColumns(source,r,SOURCE_COLUMNS);if(!text(source.rows[r][60]))need(![1,2,10].some(c=>{const u=source.rows[r][c].userEnteredValue||{};return !Object.hasOwn(u,'formulaValue')&&(Object.values(u)[0]??'')!=='';}),'COMPACT_SOURCE_ID_MISSING');}
  const sourceIds=uniqueIds(source,60,1,'COMPACT_SOURCE_ID_DUPLICATE'),ledgerIds=uniqueIds(ledger,0,3,'COMPACT_LEDGER_ID_DUPLICATE');for(const entry of sourceIds.values())need(/^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.id),'COMPACT_SOURCE_ID_INVALID');
  const selected=sourceIds.get(caseId.toLowerCase());need(selected&&selected.id===caseId,'COMPACT_SELECTED_SOURCE_NOT_FOUND');const selectedLedger=ledgerIds.get(caseId.toLowerCase());need(!selectedLedger||selectedLedger.id===caseId,'COMPACT_SELECTED_LEDGER_CASE_SPELLING');
  const destinations=[],globalIds=new Set();for(const m of b.months){const s=states.get(m.sheetId),columns=[0,1,9,10,11,12,13,14,m.columnCount-1];requireColumns(s,0,[...Array(m.columnCount).keys()]);const h=s.rows[0].map(text);need(HEADERS.slice(1,55).every((v,i)=>h[i]===v)&&h[m.columnCount-1]==='連絡_固定案件ID'&&(m.columnCount!==56||h[54]===''),'COMPACT_MONTH_HEADERS');for(let r=1;r<m.rowCount;r++){requireColumns(s,r,columns);const id=text(s.rows[r][m.columnCount-1]);if(text(s.rows[r][9]))need(id,'COMPACT_MONTH_BUSINESS_ID_MISSING');if(!id)continue;need(!globalIds.has(id.toLowerCase()),'COMPACT_MONTH_ID_DUPLICATE');globalIds.add(id.toLowerCase());if(id.toLowerCase()===caseId.toLowerCase()){need(id===caseId,'COMPACT_DESTINATION_CASE_SPELLING');destinations.push({...m,row:r});}}}
  return {metadata,b,states,caseId,sourceRow:selected.row,ledgerRow:selectedLedger?.row??null,destinations};
}
function inspectCompactIndex(input){const p=prepare(input.metadata,input.indexReads,input.caseId);return {schema:'LK_MONTHLY_COMPACT_INDEX_V1',sourceRow:p.sourceRow+1,ledgerRow:p.ledgerRow===null?null:p.ledgerRow+1,destinations:p.destinations.map(d=>({sheetId:d.sheetId,title:d.title,row:d.row+1,columnCount:d.columnCount})),fullRanges:[a1(p.b.source,p.sourceRow,p.sourceRow+1,0,65),...p.destinations.map(d=>a1(d,d.row,d.row+1,0,d.columnCount))],ledgerRange:p.ledgerRow===null?null:a1(p.b.ledger,p.ledgerRow,p.ledgerRow+1,0,25)};}
function identity(name,resolveStaff){if(!name||/^[（(][0-9０-９]+人[）)]$/.test(name.normalize('NFKC')))return {};const p=resolveStaff(name);return p&&typeof p.staffId==='string'&&p.staffId&&p.identityVerified===true?{staffId:p.staffId,staffIdentityVerified:true}:{staffIdentityVerified:false};}
function dependencyBindings(metadata){const ds=DEPENDENCIES.map(title=>bound(metadata,title));need(ds.every(d=>d.rowCount*d.columnCount<=40000)&&ds.reduce((n,d)=>n+d.rowCount*d.columnCount,0)<=100000,'COMPACT_DEPENDENCY_CELL_BUDGET_EXCEEDED');return ds;}
function createDependencyEvidence(input){
  const metadata=book(input.metadata);need(DEPENDENCIES.includes(input.title),'COMPACT_DEPENDENCY_TITLE');const d=bound(metadata,input.title);need(d.rowCount*d.columnCount<=40000,'COMPACT_DEPENDENCY_CELL_BUDGET_EXCEEDED');const allowed=[{...d,r0:0,r1:d.rowCount,c0:0,c1:d.columnCount}];need(Array.isArray(input.reads)&&input.reads.length,'COMPACT_DEPENDENCY_READ_REQUIRED');let rowHashes=null;
  for(const read of input.reads){const {response}=describeRead(metadata,read,allowed,false),segments=Array.from({length:d.rowCount},()=>[]);
    // Keep references to native rows, then hash one row at a time. Do not make
    // a second full dependency matrix or per-cell coverage Set beside JSON.
    for(const sheet of response.sheets||[])for(const grid of sheet.data||[]){const r0=grid.startRow??0,c0=grid.startColumn??0;need(sheet.properties?.sheetId===d.sheetId&&Number.isInteger(r0)&&r0>=0&&Number.isInteger(c0)&&c0>=0,'COMPACT_DEPENDENCY_GRID_SCOPE');for(const [ri,row]of(grid.rowData||[]).entries()){need(r0+ri<d.rowCount,'COMPACT_DEPENDENCY_GRID_SCOPE');const values=row.values||[];need(c0+values.length<=d.columnCount,'COMPACT_DEPENDENCY_GRID_SCOPE');segments[r0+ri].push({column:c0,values});}}
    const current=segments.map(parts=>{const cells=Array(d.columnCount).fill(EMPTY),seen=new Set();for(const part of parts)for(const [c,cell]of part.values.entries()){need(cell&&typeof cell==='object'&&!Array.isArray(cell),'COMPACT_CELL_SHAPE');const column=part.column+c;if(seen.has(column))need(canonical(valueProjection(cells[column]))===canonical(valueProjection(cell)),'COMPACT_DEPENDENCY_OVERLAP_CHANGED');cells[column]=cell;seen.add(column);}return hash(cells.map(valueProjection));});
    if(rowHashes)need(canonical(rowHashes)===canonical(current),'COMPACT_DEPENDENCY_READ_CHANGED');else rowHashes=current;
  }
  return {schema:'LK_MONTHLY_DEPENDENCY_EVIDENCE_V1',spreadsheetId:metadata.spreadsheetId,...d,fields:VALUE_FIELDS,rowHashes,requestHash:hash(input.reads.map(read=>read.request))};
}
function createCompactSnapshot(input){const p=prepare(input.metadata,input.indexReads,input.caseId),{metadata,b,states}=p;const fullAllowed=[{...b.source,r0:p.sourceRow,r1:p.sourceRow+1,c0:0,c1:65},...p.destinations.map(d=>({...d,r0:d.row,r1:d.row+1,c0:0,c1:d.columnCount}))];need(Array.isArray(input.fullReads)&&input.fullReads.length,'COMPACT_FULL_READ_REQUIRED');for(const read of input.fullReads)applyRead(metadata,read,fullAllowed,states,true);
  const dependencyBounds=input.includeDependencies===true?dependencyBindings(metadata):[];
  const valueAllowed=[...(p.ledgerRow===null?[]:[{...b.ledger,r0:p.ledgerRow,r1:p.ledgerRow+1,c0:0,c1:25}])];need(Array.isArray(input.valueReads),'COMPACT_SELECTED_LEDGER_READ_REQUIRED');for(const read of input.valueReads)applyRead(metadata,read,valueAllowed,states,false);
  const selectedSource=states.get(b.source.sheetId);need(selectedSource.full.has(p.sourceRow),'COMPACT_SELECTED_SOURCE_FULL_REQUIRED');const selectedLedger=states.get(b.ledger.sheetId);if(p.ledgerRow!==null)requireColumns(selectedLedger,p.ledgerRow,[...Array(25).keys()]);for(const d of p.destinations)need(states.get(d.sheetId).full.has(d.row),'COMPACT_SELECTED_DESTINATION_FULL_REQUIRED');
  const sourceCells=selectedSource.rows[p.sourceRow],ledgerCells=p.ledgerRow===null?null:selectedLedger.rows[p.ledgerRow];const rowRevision=hash({schema:'LK_CASE_CONTENT_REVISION_V1',jobId:p.caseId,cells:sourceCells.map(valueProjection)}),ledgerRevision=hash(ledgerCells?ledgerCells.map(valueProjection):null),sourceRevision=hash({schema:'LK_CASE_LIST_AUTHORITY_REVISION_V1',caseId:p.caseId,rowRevision,ledgerRevision});const catalog={version:1,spreadsheetId:metadata.spreadsheetId,sheetId:b.source.sheetId,caseId:p.caseId,sourceRevision,rowRevision,ledgerRevision};
  const resolveStaff=typeof input.resolveStaff==='function'?input.resolveStaff:()=>null;
  function rows(s,idColumn,nameColumn){return s.rows.slice(1).map((cells,i)=>({row:i+2,cells,knownColumns:[...s.known[i+1]].sort((a,b)=>a-b),fullWritable:s.full.has(i+1),...(idColumn===60?{caseId:text(cells[idColumn])}:{fixedId:text(cells[idColumn])}),...identity(text(cells[nameColumn]),resolveStaff)}));}
  const months=b.months.map(m=>{const s=states.get(m.sheetId);return {...m,headers:s.rows[0].map(text),rows:rows(s,m.columnCount-1,1),isolated:false};});
  const evidence=input.dependencyEvidence||[];need(dependencyBounds.length===evidence.length,'COMPACT_DEPENDENCY_EVIDENCE_INCOMPLETE');
  const dependencyHash=dependencyBounds.length?hash({schema:'LK_MONTHLY_DEPENDENCY_VALUES_V1',sheets:dependencyBounds.map(d=>{const found=evidence.filter(e=>e.title===d.title);need(found.length===1,'COMPACT_DEPENDENCY_EVIDENCE_DUPLICATE');const e=found[0];need(e.schema==='LK_MONTHLY_DEPENDENCY_EVIDENCE_V1'&&e.spreadsheetId===metadata.spreadsheetId&&e.sheetId===d.sheetId&&e.rowCount===d.rowCount&&e.columnCount===d.columnCount&&canonical(e.fields)===canonical(VALUE_FIELDS)&&Array.isArray(e.rowHashes)&&e.rowHashes.length===d.rowCount&&e.rowHashes.every(h=>/^[a-f0-9]{64}$/.test(h))&&/^[a-f0-9]{64}$/.test(e.requestHash),'COMPACT_DEPENDENCY_EVIDENCE_INVALID');return {...d,rowHashes:e.rowHashes};})}):hash(null);
  return {spreadsheetId:metadata.spreadsheetId,isolated:false,source:{...b.source,headers:selectedSource.rows[0].map(text),rows:rows(selectedSource,60,2)},months,dependencyHash,catalog,
    coverage:{schema:'LK_MONTHLY_COMPACT_COVERAGE_V1',unknownCell:'$unknown:true',source:{...b.source,headersComplete:true,indexReadComplete:true,structuralColumns:SOURCE_COLUMNS,selectedCaseId:p.caseId},ledger:{...b.ledger,headerRow:3,headersComplete:true,indexReadComplete:true,structuralColumns:[0],selectedCaseId:p.caseId,selectedRow:p.ledgerRow===null?null:p.ledgerRow+1,selectedRecordPresent:p.ledgerRow!==null,selectedRowReadComplete:p.ledgerRow!==null,absenceProven:p.ledgerRow===null},months:b.months.map(m=>({...m,headersComplete:true,indexReadComplete:true,structuralColumns:[0,1,9,10,11,12,13,14,m.columnCount-1]}))},
    ledger:{...b.ledger,headerRow:3,headers:selectedLedger.rows[2].map(text),rows:selectedLedger.rows.slice(3).map((cells,i)=>({row:i+4,caseId:text(cells[0]),cells,knownColumns:[...selectedLedger.known[i+3]].sort((a,b)=>a-b),fullValues:i+3===p.ledgerRow}))},rawRows:[selectedSource.rows[0],sourceCells],rawLedgerRows:[[],[],selectedLedger.rows[2],...(ledgerCells?[ledgerCells]:[])],selectedRows:{source:p.sourceRow+1,ledger:p.ledgerRow===null?null:p.ledgerRow+1,destinations:p.destinations.map(d=>({sheetId:d.sheetId,row:d.row+1}))}};
}
function createIndexRanges(metadataInput){const metadata=book(metadataInput),b=bindings(metadata);return indexRectangles(b).map(r=>a1(r,r.r0,r.r1,r.c0,r.c1));}
function createDependencyRanges(metadataInput){const metadata=book(metadataInput);return dependencyBindings(metadata).map(d=>a1(d,0,d.rowCount,0,d.columnCount));}
function createDependencyPlans(metadataInput){const metadata=book(metadataInput);return dependencyBindings(metadata).map(d=>({title:d.title,range:a1(d,0,d.rowCount,0,d.columnCount)}));}
module.exports={createDependencyPlans,createDependencyEvidence,UNKNOWN,VALUE_FIELDS,FULL_FIELDS,SOURCE_COLUMNS,LEDGER_HEADERS,DEPENDENCIES,canonical,createIndexRanges,createDependencyRanges,inspectCompactIndex,createCompactSnapshot};
