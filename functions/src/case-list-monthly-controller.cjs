/* Native transaction controller. Services are injected by the GAS adapter.
 * Source is retained. A trusted new Crew assignment may project only Source C;
 * remaining mutations are new monthly rows and append-only events.
 * A lock serializes this controller. It is not a CAS against human/other-project edits.
 */
'use strict';
var LK_MONTHLY_V5 = (() => {
  const BUSINESS = ['実施日','スタッフ名','アドレス','入店時間','店舗名','スタッフ名','体温','入店時間','応募日','クライアント','店舗','メーカー','メニュー','入店時間','実施時間','備考','電話番号','資料発送日','請求単価','残業','遠方','緊急','店外','繁忙','検査','管理費','売上合計','給与','業務手当','残業','遠方','緊急','店外','繁忙','検査','基本給','交通費','立替(8%)','立替(10%)','通信費（請）','通信費（課税）','通信費（非課税）','請求不可','支給額合計','報告書チェック','原本チェック','メモ','単価','交通費','立替8％','立替10％','通信費','手当','合計金額'];
  const MANAGEMENT = ['状態','地域','当日急募','日程方式','関連日程ID','募集枠ID','元情報','管理情報','取消','募集注意事項'];
  const SOURCE = ['キャンセル',...BUSINESS,...MANAGEMENT];
  const FEE = [...Array.from({length:26},(_,i)=>i+19),...Array.from({length:7},(_,i)=>i+48)]; // monthly 1-based
  const WRITABLE = ['userEnteredValue','note','userEnteredFormat','dataValidation','textFormatRuns','chipRuns'];
  const FUNCTIONS = new Set('AND ASC COUNT COUNTIF DATE DAY IF IFERROR IFNA IFS INDEX ISNUMBER LET MATCH MOD MONTH N NOT OR REGEXEXTRACT REGEXMATCH REGEXREPLACE RIGHT ROW SEARCH SPLIT SUBSTITUTE SUM SWITCH TEXT TRIM VALUE VLOOKUP WEEKDAY XLOOKUP LEN LEFT MID FIND MIN MAX ROUND EXACT TO_TEXT ISFORMULA CHAR TRUE FALSE'.split(' '));
  const EXTERNALS = new Set(['スタッフマスタ','各社見積書','イオンデモ遠方リスト','ケイ_応募日補助']);
  const SOURCE_INDEX_COLUMNS=[1,2,10,60,63];
  const COMPACT_COVERAGE='LK_MONTHLY_COMPACT_COVERAGE_V1',STRUCTURAL_LAYOUT='LK_MONTHLY_STRUCTURAL_LAYOUT_V1',LEGACY_LAYOUT='LK_MONTHLY_FULL_WRITABLE_LEGACY_ISOLATED_V1';
  const copy=x=>JSON.parse(JSON.stringify(x));
  const text=c=>typeof c?.userEnteredValue?.stringValue==='string'?c.userEnteredValue.stringValue:(typeof c?.effectiveValue?.stringValue==='string'?c.effectiveValue.stringValue:'');
  function possibleStaff(c){const entered=c?.userEnteredValue||{},effective=c?.effectiveValue||{};if([entered,effective].some(value=>Object.hasOwn(value,'numberValue')||Object.hasOwn(value,'boolValue')||value.errorValue))return true;if([entered,effective].some(value=>typeof value.stringValue==='string'&&value.stringValue.trim()!==''))return true;return typeof entered.formulaValue==='string'&&typeof effective.stringValue!=='string';}
  const num=c=>c?.effectiveValue?.numberValue??c?.userEnteredValue?.numberValue;
  function fail(code,detail){const e=new Error(code);e.code=code;e.detail=detail||{};throw e;}
  function need(ok,code,detail){if(!ok)fail(code,detail);}
  function canonical(x){if(x===null||['string','boolean'].includes(typeof x))return JSON.stringify(x);if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';fail('UNSERIALIZABLE');}
  function knownCell(c){return !!c&&typeof c==='object'&&!Array.isArray(c)&&c.$unknown!==true;}
  function writable(c){need(knownCell(c),'UNKNOWN_CELL_NOT_WRITABLE');return Object.fromEntries(WRITABLE.filter(k=>Object.hasOwn(c,k)).map(k=>[k,copy(c[k])]))}
  function normalizedEffective(c){const v=c?.effectiveValue;if(!v||!Object.keys(v).length||v.stringValue==='')return null;return copy(v)}
  function serialDate(n){need(Number.isInteger(n)&&n>0&&n<2958466,'INVALID_DATE');return new Date(Date.UTC(1899,11,30)+n*86400000).toISOString().slice(0,10)}
  function column(n){let s='';for(;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;}
  function columnNumber(s){return [...s].reduce((n,c)=>n*26+c.charCodeAt(0)-64,0)}
  function time(s){const m=/^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(s).normalize('NFKC'));return m?Number(m[1])*60+Number(m[2]):null;}
  function cancellation(s){return /取消|キャンセル|中止|\bcancel(?:led|ed)?\b/i.test(String(s).normalize('NFKC').replace(/\s/g,''));}
  function sha(services,x){return services.sha256(typeof x==='string'?x:canonical(x));}
  function contentHash(services,cells){need(Array.isArray(cells)&&Array.from(cells).every(knownCell),'FULL_WRITABLE_CELLS_REQUIRED');return sha(services,cells.map(writable));}
  function monthIndexColumns(width){return [0,1,9,10,11,12,13,14,width-1];}
  function exactColumns(actual,expected){return Array.isArray(actual)&&actual.length===expected.length&&new Set(actual).size===actual.length&&actual.every(Number.isInteger)&&[...actual].sort((a,b)=>a-b).every((n,i)=>n===[...expected].sort((a,b)=>a-b)[i]);}
  function rowKnows(row,columns){return Array.isArray(row.knownColumns)&&columns.every(c=>row.knownColumns.includes(c)&&knownCell(row.cells?.[c]));}
  function fullRow(row,width,flag){return row.cells?.length===width&&row[flag]===true&&exactColumns(row.knownColumns,Array.from({length:width},(_,i)=>i))&&Array.from(row.cells).every(knownCell);}
  function indexId(row,column,key){const id=text(row.cells[column]);need(typeof row[key]==='string'&&row[key]===id,'INDEX_ID_ATTRIBUTE_MISMATCH');if(id)need(row.cells[column].userEnteredValue?.stringValue===id,'INDEX_ID_NOT_PERSISTED');return id;}
  function completeRows(table,first,code){need(Number.isInteger(table.rowCount)&&table.rowCount>=first-1&&Array.isArray(table.rows)&&table.rows.length===table.rowCount-first+1,code);need(table.rows.every((r,i)=>r.row===i+first),code);}
  function assertSnapshotCoverage(snapshot,caseId,services){
    const coverage=snapshot.coverage;
    if(!coverage){need(snapshot.isolated===true,'SNAPSHOT_COVERAGE_REQUIRED');return LEGACY_LAYOUT;}
    need(coverage.schema===COMPACT_COVERAGE,'SNAPSHOT_COVERAGE_SCHEMA');
    const source=snapshot.source,sc=coverage.source;
    need(sc&&sc.sheetId===source.sheetId&&sc.rowCount===source.rowCount&&sc.headersComplete===true&&sc.indexReadComplete===true&&sc.selectedCaseId===caseId&&exactColumns(sc.structuralColumns,SOURCE_INDEX_COLUMNS),'SOURCE_INDEX_COVERAGE_UNVERIFIED');
    completeRows(source,2,'SOURCE_INDEX_ROWS_INCOMPLETE');
    for(const row of source.rows){need(row.cells?.length===65&&rowKnows(row,SOURCE_INDEX_COLUMNS),'SOURCE_KNOWN_COLUMNS_INCOMPLETE');const id=indexId(row,60,'caseId');need(id||(!possibleStaff(row.cells[2])&&!serialSafe(row.cells[1])&&!text(row.cells[10])),'SOURCE_ASSIGNMENT_ID_UNVERIFIED');}
    const sourceSelected=source.rows.filter(r=>r.caseId===caseId);need(sourceSelected.length===1&&fullRow(sourceSelected[0],65,'fullWritable'),'SELECTED_SOURCE_FULL_WRITABLE_REQUIRED');
    const own=sourceSelected[0];
    if(typeof own.cells[1].userEnteredValue?.numberValue==='number')need(own.cells[1].effectiveValue?.numberValue===own.cells[1].userEnteredValue.numberValue,'SOURCE_DATE_EFFECTIVE_READ_MISSING');
    if(typeof own.cells[2].userEnteredValue?.stringValue==='string'&&own.cells[2].userEnteredValue.stringValue)need(own.cells[2].effectiveValue?.stringValue===own.cells[2].userEnteredValue.stringValue,'SOURCE_NAME_EFFECTIVE_READ_MISSING');
    for(const column of FEE){const cell=own.cells[column];if(typeof cell.userEnteredValue?.numberValue==='number')need(cell.effectiveValue?.numberValue===cell.userEnteredValue.numberValue,'SOURCE_MANUAL_FEE_EFFECTIVE_READ_MISSING');}
    need(Array.isArray(coverage.months)&&coverage.months.length===snapshot.months.length,'MONTH_INDEX_COVERAGE_UNVERIFIED');
    const allMonthIds=[];
    for(const month of snapshot.months){const width=month.headers.length,columns=monthIndexColumns(width),mc=coverage.months.filter(c=>c.sheetId===month.sheetId&&c.title===month.title);need(mc.length===1&&mc[0].rowCount===month.rowCount&&mc[0].headersComplete===true&&mc[0].indexReadComplete===true&&exactColumns(mc[0].structuralColumns,columns),'MONTH_INDEX_COVERAGE_UNVERIFIED');completeRows(month,2,'MONTH_INDEX_ROWS_INCOMPLETE');for(const row of month.rows){need(row.cells?.length===width&&rowKnows(row,columns),'MONTH_KNOWN_COLUMNS_INCOMPLETE');const id=indexId(row,width-1,'fixedId');if(id)allMonthIds.push(id.toLowerCase());need(!text(row.cells[9])||!serialSafe(row.cells[0])||id,'MONTHLY_ASSIGNMENT_ID_UNVERIFIED');if(id.toLowerCase()===caseId.toLowerCase())need(fullRow(row,width,'fullWritable'),'SELECTED_DESTINATION_FULL_WRITABLE_REQUIRED');}}
    need(new Set(allMonthIds).size===allMonthIds.length,'CROSS_MONTH_CANONICAL_DUPLICATE_ID');
    const ledger=snapshot.ledger,lc=coverage.ledger;
    need(ledger&&lc&&ledger.headerRow===3&&lc.headerRow===3&&lc.sheetId===ledger.sheetId&&lc.rowCount===ledger.rowCount&&lc.headersComplete===true&&lc.indexReadComplete===true&&lc.selectedCaseId===caseId&&exactColumns(lc.structuralColumns,[0])&&ledger.headers?.length===25,'LEDGER_INDEX_COVERAGE_UNVERIFIED');completeRows(ledger,4,'LEDGER_INDEX_ROWS_INCOMPLETE');
    const ledgerIds=[];for(const row of ledger.rows){need(row.cells?.length===25&&rowKnows(row,[0]),'LEDGER_KNOWN_COLUMNS_INCOMPLETE');const id=indexId(row,0,'caseId');if(id)ledgerIds.push(id.toLowerCase());}
    need(new Set(ledgerIds).size===ledgerIds.length,'LEDGER_CANONICAL_DUPLICATE_ID');
    const record=ledger.rows.filter(r=>r.caseId.toLowerCase()===caseId.toLowerCase());need(record.length<=1,'LEDGER_SELECTED_ID_AMBIGUOUS');
    if(record.length)need(lc.selectedRecordPresent===true&&lc.selectedRow===record[0].row&&lc.selectedRowReadComplete===true&&lc.absenceProven===false&&fullRow(record[0],25,'fullValues'),'SELECTED_LEDGER_FULL_VALUES_REQUIRED');
    else need(lc.selectedRecordPresent===false&&lc.selectedRow===null&&lc.selectedRowReadComplete===false&&lc.absenceProven===true,'SELECTED_LEDGER_ABSENCE_UNPROVEN');
    if(services){const value=record.length?record[0].cells.map(c=>({userEnteredValue:c.userEnteredValue??{},effectiveValue:c.effectiveValue??{}})):null;need(snapshot.catalog?.ledgerRevision===sha(services,value),'LEDGER_AUTHORITY_REVISION_CHANGED');}
    return STRUCTURAL_LAYOUT;
  }
  function monthLayoutHash(services,month,profile){
    if(profile===LEGACY_LAYOUT)return sha(services,month.rows.map(r=>({row:r.row,cells:r.cells.map(writable)})));
    need(profile===STRUCTURAL_LAYOUT,'MONTH_LAYOUT_PROFILE_UNSUPPORTED');const columns=monthIndexColumns(month.headers.length);
    const rows=month.rows.map(row=>{need(rowKnows(row,columns),'MONTH_KNOWN_COLUMNS_INCOMPLETE');return {row:row.row,cells:columns.map(column=>({column,userEnteredValue:row.cells[column].userEnteredValue??{},effectiveValue:row.cells[column].effectiveValue??{}}))};});
    return sha(services,{schema:STRUCTURAL_LAYOUT,sheetId:month.sheetId,title:month.title,rowCount:month.rowCount,headers:month.headers,columns,rows});
  }
  function assertSourceAssignmentPreflight(snapshot,intent,services){
    assertSnapshotCoverage(snapshot,intent.caseId,services);const row=sourceRow(snapshot,intent.caseId),a=intent.assignment;
    need(contentHash(services,row.cells)===intent.preMonthlyContentHash&&sameCatalog(snapshot.catalog,intent.preCatalog)&&snapshot.dependencyHash===intent.dependencyHash,'SOURCE_PREIMAGE_CHANGED');
    need(a?.authority==='CREW_QUEUE'&&sha(services,a)===intent.assignmentHash,'ASSIGNMENT_CHANGED');
    need(!row.cells[2].userEnteredValue||!Object.keys(row.cells[2].userEnteredValue).length||row.cells[2].userEnteredValue.stringValue==='','SOURCE_STAFF_ALREADY_FILLED');
    const prospective={...row,cells:copy(row.cells)};prospective.cells[2]={...prospective.cells[2],userEnteredValue:{stringValue:a.staffName},effectiveValue:{stringValue:a.staffName}};
    const valid=validate(snapshot,prospective,a,services);
    need(!snapshot.months.some(m=>m.rows.some(r=>r.fixedId&&r.fixedId.toLowerCase()===row.caseId.toLowerCase())),'EXISTING_DESTINATION_WITHOUT_RECEIPT');
    choosePosition(valid.month,valid.date,prospective,intent.layoutMode);mapSource(prospective.cells,'PROSPECTIVE_ONLY',valid.schema.width);
  }
  function assertMonthlyWritePreflight(snapshot,intent,services){
    assertSnapshotCoverage(snapshot,intent.caseId,services);const row=sourceRow(snapshot,intent.caseId);
    assertOwnerTransfer(snapshot,row,intent.assignment,intent.ownerTransfer,services,intent.operationId);
    need(contentHash(services,row.cells)===intent.sourceContentHash&&snapshot.dependencyHash===intent.dependencyHash,'MONTHLY_PREIMAGE_CHANGED');
    need(sha(services,intent.assignment)===intent.assignmentHash,'ASSIGNMENT_CHANGED');checkPromisedPay(row,intent.assignment);
    const valid=validate(snapshot,row,intent.assignment,services);choosePosition(valid.month,valid.date,row,intent.position.kind==='ISOLATED_TAIL'?'ISOLATED_TAIL':undefined);
  }
  function unique(rows,key,code){const out=new Map();for(const r of rows){need(typeof r[key]==='string'&&r[key]&&!out.has(r[key]),code);out.set(r[key],r);}return out;}
  function sourceSchema(headers){need(headers.length===65&&headers.every((h,i)=>h===SOURCE[i]||(i===0&&h==='月別転記')),'SOURCE_SCHEMA_CHANGED');}
  function monthSchema(m){need(/^20\d\d\.(?:[1-9]|1[012])$/.test(m.title),'MONTH_TITLE');const expected=m.headers.length;need([55,56].includes(expected)&&BUSINESS.every((h,i)=>h===m.headers[i]),'MONTH_SCHEMA_CHANGED');need(m.headers[expected-1]==='連絡_固定案件ID'&&(expected===55||m.headers[54]===''),'MONTH_ID_COLUMN_CHANGED');return {width:expected,idColumn:expected};}
  // The accepted grammar has row-independent INDEX($X:$X,ROW()) local references.
  // External quoted ranges and string literals are left byte-exact. Anything else
  // that looks like a local A1/column reference is rejected, not guessed.
  function translateFormula(formula){
    need(typeof formula==='string'&&formula[0]==='='&&!/[\u0000-\u001f\u007f]/.test(formula),'FORMULA_INVALID');
    const literals=[];
    let rest=formula.replace(/"(?:[^"]|"")*"/g,s=>{literals.push(s);return '\u0001'+(literals.length-1)+'\u0001';});
    need(!rest.includes('"'),'FORMULA_STRING_UNCLOSED');
    const external=[];
    rest=rest.replace(/'((?:[^']|'')+)'!\$?[A-Z]+(?:\$?\d+)?(?::\$?[A-Z]+(?:\$?\d+)?)?/g,(s,name)=>{need(EXTERNALS.has(name.replace(/''/g,"'")),'FORMULA_EXTERNAL_SHEET_UNAPPROVED');external.push(s);return '\u0002'+(external.length-1)+'\u0002';});
    need(!/[!'\[\]]/.test(rest),'FORMULA_EXTERNAL_REFERENCE_UNSUPPORTED');
    const locals=[];
    rest=rest.replace(/INDEX\(\$([A-Z]+):\$([A-Z]+),ROW\(\)\)/g,(s,a,b)=>{need(a===b&&columnNumber(a)>1&&columnNumber(a)<=55,'FORMULA_LOCAL_RANGE_UNSUPPORTED');const c=column(columnNumber(a)-1);locals.push('INDEX($'+c+':$'+c+',ROW())');return '\u0003'+(locals.length-1)+'\u0003';});
    need(!/\$|\b[A-Za-z]{1,3}\d+\b|\b[A-Za-z]{1,3}\s*:\s*[A-Za-z]{1,3}\b/.test(rest),'FORMULA_LOCAL_A1_UNSUPPORTED');
    const calls=[...rest.matchAll(/\b([A-Za-z_][A-Za-z0-9_.]*)\s*\(/g)].map(m=>m[1]);
    need(calls.every(f=>FUNCTIONS.has(f)),'FORMULA_FUNCTION_UNSUPPORTED');
    need(!/\b(?:INDIRECT|OFFSET|IMPORTRANGE|IMPORTXML|IMPORTDATA|HYPERLINK|IMAGE|GOOGLEFINANCE|QUERY|ARRAYFORMULA)\b/i.test(rest),'FORMULA_DYNAMIC_REFERENCE_UNSUPPORTED');
    function validateExpression(expression,env){
      // A local parser, with each function's arguments parsed in its own string.
      // LET names become visible only after their initializer has been checked.
      function split(open){let depth=1,start=open+1,args=[];for(let j=open+1;j<expression.length;j++){if(expression[j]==='(')depth++;else if(expression[j]===')'){depth--;if(depth===0){args.push(expression.slice(start,j));return {args,end:j};}}else if(expression[j]===','&&depth===1){args.push(expression.slice(start,j));start=j+1;}}fail('FORMULA_PARENTHESES');}
      for(let i=0;i<expression.length;i++){
        if(expression[i]===')')fail('FORMULA_PARENTHESES');
        if(expression[i]==='('){const group=split(i);need(group.args.length===1,'FORMULA_GROUP_ARGUMENTS');validateExpression(group.args[0],env);i=group.end;continue;}
        if(!/[A-Za-z_]/.test(expression[i]))continue;
        const token=/^[A-Za-z_][A-Za-z0-9_.]*/.exec(expression.slice(i))[0],after=i+token.length,white=/^\s*/.exec(expression.slice(after))[0].length,open=after+white;
        if(expression[open]==='('){
          need(FUNCTIONS.has(token),'FORMULA_FUNCTION_UNSUPPORTED');const functionArgs=split(open);
          if(token==='LET'){
            need(functionArgs.args.length>=3&&functionArgs.args.length%2===1,'FORMULA_LET_ARGUMENTS');const local=new Set(env);
            for(let a=0;a<functionArgs.args.length-1;a+=2){const name=functionArgs.args[a].trim();need(/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name),'FORMULA_LET_NAME_UNSUPPORTED');validateExpression(functionArgs.args[a+1],local);local.add(name.toLowerCase());}
            validateExpression(functionArgs.args[functionArgs.args.length-1],local);
          }else for(const argument of functionArgs.args)validateExpression(argument,env);
          i=functionArgs.end;
        }else{need(['TRUE','FALSE'].includes(token)||env.has(token.toLowerCase()),'FORMULA_NAMED_REFERENCE_UNSUPPORTED');i=after-1;}
      }
    }
    validateExpression(rest,new Set());
    return rest.replace(/\u0003(\d+)\u0003/g,(_,n)=>locals[Number(n)]).replace(/\u0002(\d+)\u0002/g,(_,n)=>external[Number(n)]).replace(/\u0001(\d+)\u0001/g,(_,n)=>literals[Number(n)]);
  }
  function mapSource(cells,fixedId,width){
    need(cells.length===65&&[55,56].includes(width),'CELL_WIDTH');
    const mapped=cells.slice(1,55).map(c=>{need(!c.effectiveValue?.errorValue,'SOURCE_FORMULA_ERROR');const out=writable(c);if(out.userEnteredValue?.formulaValue)out.userEnteredValue={formulaValue:translateFormula(out.userEnteredValue.formulaValue)};return out;});
    // New operational checkboxes begin unchecked; source evidence remains intact.
    for(const i of [44,45]){mapped[i].userEnteredValue={boolValue:false};mapped[i].dataValidation={condition:{type:'BOOLEAN'},strict:true};}
    return {business:mapped,idColumn:width,idCell:{userEnteredValue:{stringValue:fixedId}},untouchedExtraColumns:width===56?[55]:[]};
  }
  function sourceRow(snapshot,id){const rows=snapshot.source.rows.filter(r=>r.caseId);unique(rows,'caseId','DUPLICATE_SOURCE_ID');need(new Set(rows.map(r=>r.caseId.toLowerCase())).size===rows.length,'CANONICAL_SOURCE_ID_COLLISION');const r=rows.find(r=>r.caseId===id);need(r,'SOURCE_NOT_FOUND');need(r.cells.length===65&&text(r.cells[60])===id,'SOURCE_ID_MISMATCH');need(/^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)||snapshot.isolated===true&&/^LK_SYNTHETIC_[A-Za-z0-9_]+$/.test(id),'SOURCE_CASE_ID_INVALID');return r;}
  async function approvedAssignment(services,request,snapshot,row){
    const a=await services.resolveAssignment(request,snapshot,row); // native/trusted server adapter, not request booleans
    need(a&&['OWNER_SELECTED','CREW_QUEUE'].includes(a.authority),'ASSIGNMENT_AUTHORITY_MISSING');
    need(a.caseId===row.caseId&&typeof a.staffId==='string'&&a.staffId&&typeof a.staffName==='string'&&a.staffName,'ASSIGNMENT_INVALID');
    need(a.dateKey===serialDate(num(row.cells[1])),'ASSIGNMENT_DATE_MISMATCH');
    if(a.authority==='CREW_QUEUE'){
      need(a.schema==='LK_CASE_LIST_ASSIGN_V1'&&a.operationId===request.operationId&&a.queueId&&a.companyId&&a.jobId&&Number.isInteger(a.assignedJobRevision)&&a.assignedJobRevision>0,'CREW_QUEUE_BINDING_INVALID');
      need(a.preCatalog&&['rowRevision','ledgerRevision','sourceRevision'].every(k=>typeof a.preCatalog[k]==='string'&&/^[a-f0-9]{64}$/.test(a.preCatalog[k]))&&/^[a-f0-9]{64}$/.test(a.preMonthlyContentHash||''),'CREW_PREIMAGE_HASHES_MISSING');
      need(a.publicPayOffer&&Number.isSafeInteger(a.publicPayOffer.dailyWageJPY)&&a.publicPayOffer.dailyWageJPY>0&&a.publicPayOffer.dailyWageJPY<=1000000&&a.publicPayOffer.travelExpenses==='全額支給'&&a.publicPayOffer.communicationExpenses==='全額支給','TRUSTED_PUBLIC_PAY_OFFER_REQUIRED');
    }
    return copy(a);
  }
  function validate(snapshot,row,assignment,services){
    sourceSchema(snapshot.source.headers);
    need(typeof row.cells[0].userEnteredValue?.boolValue==='boolean','TRANSFER_CONTROL_INVALID');
    if(snapshot.source.headers[0]==='キャンセル')need(row.cells[0].userEnteredValue.boolValue===false,'SOURCE_CANCELLED_OR_INVALID');
    else if(assignment.authority==='OWNER_SELECTED')need(row.cells[0].userEnteredValue.boolValue===true,'TRANSFER_SELECTION_REQUIRED');
    need(row.cells[2]?.userEnteredValue?.stringValue===assignment.staffName,'SOURCE_STAFF_NOT_PROJECTED');
    need(row.cells[63].userEnteredValue?.boolValue===false&&!cancellation(text(row.cells[10])),'SOURCE_CANCELLED_OR_INVALID');
    if(assignment.authority==='OWNER_SELECTED')need(['ASSIGNED','担当確定・転記待ち'].includes(text(row.cells[55])),'SOURCE_ASSIGNMENT_NOT_READY');
    need(['単日','SINGLE'].includes(text(row.cells[58]))&&!text(row.cells[59]),'GROUP_REQUIRES_SEPARATE_POLICY');
    const date=serialDate(num(row.cells[1]));need(date>='2026-11-01','OCTOBER_OR_PAST_SCOPE');
    need([10,11,12,13].every(i=>text(row.cells[i]).trim()),'BUSINESS_FIELDS_MISSING');
    const arrival=time(text(row.cells[14])),execution=/^([0-2]?\d:[0-5]\d)\s*[~〜～\-–—]\s*([0-2]?\d:[0-5]\d)$/.exec(text(row.cells[15]).normalize('NFKC'));
    need(arrival!==null&&execution&&time(execution[1])!==null&&time(execution[2])!==null&&arrival<=time(execution[1])&&time(execution[1])<time(execution[2]),'WORK_TIME_INVALID');
    need(!/研修|OJT|ラウンダー|出口調査|グレイス|グレース/i.test([text(row.cells[10]),text(row.cells[13]),text(row.cells[16])].join(' ')),'UNACCEPTED_FINANCIAL_SPECIAL_CASE');
    const monthName=date.slice(0,4)+'.'+Number(date.slice(5,7)),month=snapshot.months.find(m=>m.title===monthName);need(month,'MONTH_MISSING');const schema=monthSchema(month);
    for(const m of snapshot.months){monthSchema(m);const nonempty=m.rows.filter(r=>r.fixedId);unique(nonempty,'fixedId','DUPLICATE_MONTHLY_ID');for(const r of m.rows)if(text(r.cells[9]))need(serialSafe(r.cells[0]),'MONTHLY_ASSIGNMENT_DATE_UNVERIFIED');}
    const allIds=snapshot.months.flatMap(m=>m.rows.filter(r=>r.fixedId).map(r=>r.fixedId.toLowerCase()));need(allIds.length===new Set(allIds).size,'CROSS_MONTH_CANONICAL_DUPLICATE_ID');
    for(const m of snapshot.months)for(const r of m.rows)if(serialSafe(r.cells[0])===date&&text(r.cells[9])){
      need(r.staffIdentityVerified===true&&typeof r.staffId==='string'&&r.staffId,'MONTHLY_STAFF_IDENTITY_UNVERIFIED',{month:m.title,row:r.row});
      if(r.staffId===assignment.staffId)fail('STAFF_ALREADY_ASSIGNED_SAME_DAY',{month:m.title,row:r.row});
    }
    for(const other of snapshot.source.rows)if(other.caseId&&other.caseId!==row.caseId&&possibleStaff(other.cells[2])&&other.cells[63]?.userEnteredValue?.boolValue!==true&&!cancellation(text(other.cells[10]))){
      need(serialSafe(other.cells[1]),'SOURCE_ASSIGNMENT_DATE_UNVERIFIED');if(serialSafe(other.cells[1])!==date)continue;
      need(other.staffIdentityVerified===true&&typeof other.staffId==='string'&&other.staffId,'SOURCE_STAFF_IDENTITY_UNVERIFIED');
      if(other.staffId===assignment.staffId)fail('SOURCE_SAME_DAY_ASSIGNMENT');
    }
    return {date,month,schema};
  }
  function serialSafe(c){const n=num(c);return Number.isInteger(n)&&n>0&&n<2958466?serialDate(n):null;}
  function choosePosition(month,date,row,mode){
    if(mode==='ISOLATED_TAIL'){need(month.isolated===true,'ISOLATED_TAIL_FORBIDDEN');return {row:month.rowCount+1,append:true,totalRow:null,kind:'ISOLATED_TAIL'};}
    const dated=month.rows.filter(r=>serialSafe(r.cells[0]));
    need(dated.length>0,'MONTH_LAYOUT_EMPTY');
    let previous='';for(const r of dated){const d=serialSafe(r.cells[0]);need(d>=previous,'MONTH_DATE_ORDER_CHANGED');previous=d;}
    const day=dated.filter(r=>serialSafe(r.cells[0])===date);
    need(day.length>0,'NEW_DAY_BLOCK_REQUIRES_TEMPLATE_ACCEPTANCE');
    const totals=day.filter(r=>!text(r.cells[9])&&/^[（(]\d+人[）)]$/.test(text(r.cells[1]).normalize('NFKC')));
    need(totals.length===1&&day[day.length-1].row===totals[0].row,'DAILY_TOTAL_BOUNDARY_UNVERIFIED');
    const total=totals[0],formula=total.cells[1]?.userEnteredValue?.formulaValue;
    // Preserve the owner's existing formula. No rewrite or assumption that all
    // operational rows are counted. Historic ranges differ; their intent has
    // not been verified, so incomplete day coverage is held below.
    need(typeof formula==='string'&&/^="（"&\(COUNTIF\(\$A\$\d+:\$A\$\d+,\s*A\d+\)-1\)&"人）"$/.test(formula),'DAILY_TOTAL_FORMULA_UNSUPPORTED');
    const first=/COUNTIF\(\$A\$(\d+):\$A\$(\d+),\s*A(\d+)\)/.exec(formula);need(Number(first[1])<=day[0].row&&Number(first[2])>=total.row,'DAILY_TOTAL_RANGE_UNVERIFIED');need(Number(first[3])===total.row,'DAILY_TOTAL_CRITERION_UNVERIFIED');
    const placement=position=>{need(position.row>Number(first[1]),'DAILY_TOTAL_INSERTION_BOUNDARY_REQUIRES_REVIEW');return position;};
    const work=day.filter(r=>text(r.cells[9]));need(work.length===day.length-1,'DAY_NONBUSINESS_ROW_UNVERIFIED');
    const client=text(row.cells[10]),arrival=time(text(row.cells[14]));
    const matching=work.filter(r=>text(r.cells[9])===client);
    if(!matching.length)return placement({row:total.row,append:false,totalRow:total.row,kind:'EXISTING_DAY_NEW_CLIENT_APPEND'});
    need(matching.every((r,i)=>i===0||r.row===matching[i-1].row+1),'CLIENT_BLOCK_NOT_CONTIGUOUS');
    const timed=matching.map(r=>({r,t:time(text(r.cells[13]))}));need(timed.every(x=>x.t!==null),'CLIENT_ARRIVAL_TIME_UNSUPPORTED');
    need(timed.every((x,i)=>i===0||x.t>=timed[i-1].t),'CLIENT_TIME_ORDER_CHANGED');
    const later=timed.find(x=>x.t>arrival);return placement({row:later?later.r.row:matching[matching.length-1].row+1,append:false,totalRow:total.row,kind:'EXISTING_DAY_CLIENT_TIME_INSERT'});
  }
  function verifyPostPlacement(intent,month,row){
    need(month.title===intent.month.title&&month.sheetId===intent.month.sheetId&&row.fixedId===intent.fixedId,'POST_PLACEMENT_SCOPE_MISMATCH');
    if(intent.position.kind==='ISOLATED_TAIL'){need(month.isolated===true,'POST_PLACEMENT_ISOLATED_SCOPE_REQUIRED');return {verified:true,scope:'ISOLATED_TAIL_ONLY',chronologicalPlacementAccepted:false};}
    need(intent.position.append===false,'NORMAL_INSERT_EXPECTED');
    const own=month.rows.filter(r=>r.fixedId===intent.fixedId);need(own.length===1&&own[0].row===row.row,'POST_PLACEMENT_ID_NOT_UNIQUE');
    const day=month.rows.filter(r=>serialSafe(r.cells[0])===intent.assignment.dateKey),work=day.filter(r=>text(r.cells[9]));
    const totals=day.filter(r=>!text(r.cells[9])&&/^\(\d+人\)$/.test(text(r.cells[1]).normalize('NFKC')));
    need(totals.length===1&&day[day.length-1].row===totals[0].row,'POST_DAILY_TOTAL_BOUNDARY_CHANGED');
    const total=totals[0],count=/^="（"&\(COUNTIF\(\$A\$(\d+):\$A\$(\d+),\s*A(\d+)\)-1\)&"人）"$/.exec(total.cells[1]?.userEnteredValue?.formulaValue||'');
    need(count&&Number(count[3])===total.row,'POST_DAILY_TOTAL_CRITERION_CHANGED');need(Number(count[1])<=day[0].row&&Number(count[2])>=total.row,'POST_DAILY_TOTAL_RANGE_UNVERIFIED');
    need(Number(/^\((\d+)人\)$/.exec(text(totals[0].cells[1]).normalize('NFKC'))[1])===work.length,'POST_DAILY_TOTAL_VALUE_UNVERIFIED');
    const compressed=n=>n>row.row?n-1:n;
    const remaining={...month,rowCount:month.rowCount-1,rows:month.rows.filter(r=>r.row!==row.row).map(r=>{
      const virtual={...r,row:compressed(r.row)};
      if(r.row===total.row){virtual.cells=r.cells.slice();virtual.cells[1]={...r.cells[1],userEnteredValue:{formulaValue:'="（"&(COUNTIF($A$'+compressed(Number(count[1]))+':$A$'+compressed(Number(count[2]))+', A'+compressed(total.row)+')-1)&"人）"'}};}
      return virtual;
    })};
    const expected=choosePosition(remaining,intent.assignment.dateKey,{cells:intent.sourceSnapshot});need(expected.row===row.row,'POST_PLACEMENT_CHANGED');
    return {verified:true,scope:'NORMAL_EXISTING_DAY_CLIENT_TIME_AND_DAILY_COUNT',chronologicalPlacementAccepted:true};
  }
  function sameCatalog(a,b){return a&&b&&['rowRevision','ledgerRevision','sourceRevision'].every(k=>a[k]===b[k]);}
  function checkPromisedPay(row,assignment){if(assignment.authority==='CREW_QUEUE')need(typeof row.cells[36]?.effectiveValue?.numberValue==='number'&&row.cells[36].effectiveValue.numberValue===assignment.publicPayOffer.dailyWageJPY,'PUBLIC_PAY_OFFER_SOURCE_BASIC_MISMATCH');}
  function assertOwnerTransfer(snapshot,row,assignment,selection,services,operationId){
    need(typeof row.cells[0]?.userEnteredValue?.boolValue==='boolean','TRANSFER_CONTROL_INVALID');
    if(snapshot.source.headers[0]==='キャンセル')need(row.cells[0].userEnteredValue.boolValue===false,'SOURCE_CANCELLED_OR_INVALID');
    need(selection?.schema==='LK_OWNER_MONTHLY_TRANSFER_V1'&&selection.selected===true&&selection.clientNameUpConfirmed===true&&
      selection.sourceControlHeader===snapshot.source.headers[0]&&selection.operationId===operationId&&selection.caseId===row.caseId&&selection.assignmentHash===sha(services,assignment)&&
      selection.sourceContentHash===contentHash(services,row.cells)&&selection.sourceRevision===(snapshot.catalog?.sourceRevision||null)&&
      typeof selection.selectedBy==='string'&&selection.selectedBy.trim()&&Number.isFinite(selection.selectedAt)&&selection.selectedAt>0,
      'OWNER_TRANSFER_SELECTION_REQUIRED');
  }
  function transferCapability(snapshot,row,options={}){
    try{
      assertSnapshotCoverage(snapshot,row?.caseId,null);
      sourceSchema(snapshot.source.headers);need(row?.cells?.length===65&&row.caseId,'CAPABILITY_SOURCE_ROW_REQUIRED');
      need(row.cells[63].userEnteredValue?.boolValue===false&&!cancellation(text(row.cells[10])),'SOURCE_CANCELLED_OR_INVALID');
      need(['単日','SINGLE'].includes(text(row.cells[58]))&&!text(row.cells[59]),'GROUP_REQUIRES_SEPARATE_POLICY');
      const date=serialDate(num(row.cells[1]));need(date>='2026-11-01','OCTOBER_OR_PAST_SCOPE');
      need([10,11,12,13].every(i=>text(row.cells[i]).trim()),'BUSINESS_FIELDS_MISSING');
      const arrival=time(text(row.cells[14])),execution=/^([0-2]?\d:[0-5]\d)\s*[~〜～\-–—]\s*([0-2]?\d:[0-5]\d)$/.exec(text(row.cells[15]).normalize('NFKC'));
      need(arrival!==null&&execution&&time(execution[1])!==null&&time(execution[2])!==null&&arrival<=time(execution[1])&&time(execution[1])<time(execution[2]),'WORK_TIME_INVALID');
      need(!/研修|OJT|ラウンダー|出口調査|グレイス|グレース/i.test([text(row.cells[10]),text(row.cells[13]),text(row.cells[16])].join(' ')),'UNACCEPTED_FINANCIAL_SPECIAL_CASE');
      const title=date.slice(0,4)+'.'+Number(date.slice(5,7)),month=snapshot.months.find(m=>m.title===title);need(month,'MONTH_MISSING');const schema=monthSchema(month);
      const position=choosePosition(month,date,row,options.layoutMode);mapSource(row.cells,row.caseId,schema.width);
      need(!snapshot.months.some(m=>m.rows.some(r=>r.fixedId&&r.fixedId.toLowerCase()===row.caseId.toLowerCase())),'EXISTING_DESTINATION_WITHOUT_RECEIPT');
      return {supported:true,month:title,sheetId:month.sheetId,columnCount:schema.width,positionKind:position.kind,financialPolicy:'EXACT_MAPPING_ONLY_POST_ASSIGNMENT_NATIVE_FEE_READBACK_REQUIRED'};
    }catch(e){return {supported:false,reason:e.code||e.message};}
  }
  function create(services){
    need(typeof services.spreadsheetId==='string'&&services.spreadsheetId,'BOUND_SPREADSHEET_REQUIRED');
    for(const k of ['sha256','withLock','authorize','readSnapshot','resolveAssignment','readEvents','appendEvent','applySourceAssignment','applyMonthly','now'])need(typeof services[k]==='function','MISSING_SERVICE_'+k);
    const wrap=fn=>Promise.resolve().then(fn).catch(e=>({status:'HELD',reason:e.code||e.message,detail:e.detail||{},automaticRetry:false,sourceWritesMayHaveOccurred:true,consultDurableJournal:true,mailWrites:0}));
    const locked=fn=>wrap(()=>services.withLock(fn));
    async function context(request){
      need(request&&/^[A-Za-z0-9_.:-]{1,160}$/.test(request.operationId||'')&&request.caseId,'REQUEST_INVALID');
      await services.authorize(request);
      const snapshot=await services.readSnapshot(request);
      need(snapshot.spreadsheetId===services.spreadsheetId,'SNAPSHOT_SPREADSHEET_MISMATCH');
      assertSnapshotCoverage(snapshot,request.caseId,services);const row=sourceRow(snapshot,request.caseId);
      sourceSchema(snapshot.source.headers);
      const assignment=await approvedAssignment(services,request,snapshot,row),events=await services.readEvents(request.operationId);
      need(events.every(e=>e.caseId===row.caseId&&e.spreadsheetId===services.spreadsheetId),'OPERATION_ID_REUSED');
      return {snapshot,row,assignment,events};
    }
    async function monthlyContext(request,c){
      c=c||await context(request);
      need(typeof services.authorizeMonthlyTransfer==='function','OWNER_TRANSFER_SELECTION_REQUIRED');
      c.ownerTransfer=await services.authorizeMonthlyTransfer(request,c.snapshot,c.row,c.assignment);
      assertOwnerTransfer(c.snapshot,c.row,c.assignment,c.ownerTransfer,services,request.operationId);
      return c;
    }
    async function save(event){
      event={...event,spreadsheetId:services.spreadsheetId};
      await services.appendEvent(event);
      const found=(await services.readEvents(event.operationId)).filter(e=>e.stage===event.stage);
      need(found.length===1&&sha(services,found[0])===sha(services,event),'DURABLE_EVENT_SAVE_UNVERIFIED');
      return event;
    }
    function one(events,stage){const found=events.filter(e=>e.stage===stage);need(found.length<=1,'DUPLICATE_JOURNAL_STAGE');return found[0];}
    function sourceIntent(c,request){
      const {row,assignment:a,snapshot}=c;
      need(a.authority==='CREW_QUEUE','SOURCE_PROJECTION_REQUIRES_TRUSTED_QUEUE');
      need(sameCatalog(snapshot.catalog,a.preCatalog)&&contentHash(services,row.cells)===a.preMonthlyContentHash,'PUBLISHED_SOURCE_PREIMAGE_CHANGED');
      need(!row.cells[2].userEnteredValue||Object.keys(row.cells[2].userEnteredValue).length===0||row.cells[2].userEnteredValue.stringValue==='','SOURCE_STAFF_ALREADY_FILLED');
      const expected=row.cells.map(writable);expected[2]={...expected[2],userEnteredValue:{stringValue:a.staffName}};
      const prospective={...row,cells:copy(row.cells)};prospective.cells[2]={...prospective.cells[2],userEnteredValue:{stringValue:a.staffName},effectiveValue:{stringValue:a.staffName}};
      const validation=validate(snapshot,prospective,a,services);
      need(!snapshot.months.some(m=>m.rows.some(r=>r.fixedId&&r.fixedId.toLowerCase()===row.caseId.toLowerCase())),'EXISTING_DESTINATION_WITHOUT_RECEIPT');
      choosePosition(validation.month,validation.date,prospective,request.layoutMode);
      mapSource(prospective.cells,'PROSPECTIVE_ONLY',validation.schema.width);
      const intent={schema:'LK_SOURCE_ASSIGNMENT_INTENT_V1',stage:'SOURCE_INTENT',spreadsheetId:services.spreadsheetId,operationId:request.operationId,caseId:row.caseId,assignment:a,assignmentHash:sha(services,a),preCatalog:copy(snapshot.catalog),preMonthlyContentHash:contentHash(services,row.cells),sourceBefore:row.cells.map(writable),expectedSourceAfter:expected,expectedPostMonthlyContentHash:sha(services,expected),dependencyHash:snapshot.dependencyHash,layoutMode:request.layoutMode||null,createdAt:services.now()};
      intent.intentHash=sha(services,{...intent,createdAt:0});return intent;
    }
    async function prepareSourceInside(request){
      const c=await context(request),prior=one(c.events,'SOURCE_INTENT');
      if(prior){need(prior.assignmentHash===sha(services,c.assignment),'ASSIGNMENT_CHANGED');return {status:'SOURCE_INTENT_EXISTS',intent:prior};}
      const intent=sourceIntent(c,request);await save(intent);return {status:'SOURCE_INTENT_PREPARED',intent};
    }
    async function applySourceInside(request){
      const c=await context(request),intent=one(c.events,'SOURCE_INTENT');need(intent,'SOURCE_INTENT_REQUIRED');
      need(intent.assignmentHash===sha(services,c.assignment),'ASSIGNMENT_CHANGED');
      if(one(c.events,'SOURCE_PROJECTED'))return reconcileSourceInside(request);
      if(one(c.events,'SOURCE_WRITE_STARTED')||one(c.events,'SOURCE_DISPATCHED')||one(c.events,'SOURCE_UNKNOWN')||one(c.events,'SOURCE_DEFERRED'))return {status:'SOURCE_RECONCILIATION_REQUIRED',automaticRetry:false};
      // An observed expected after-image can mean an ACK was lost before the
      // dispatch event. Reconcile it; never write it a second time.
      if(contentHash(services,c.row.cells)===intent.expectedPostMonthlyContentHash)return {status:'SOURCE_RECONCILIATION_REQUIRED',automaticRetry:false};
      need(contentHash(services,c.row.cells)===intent.preMonthlyContentHash&&sameCatalog(c.snapshot.catalog,intent.preCatalog)&&c.snapshot.dependencyHash===intent.dependencyHash,'SOURCE_PREIMAGE_CHANGED');
      assertSourceAssignmentPreflight(c.snapshot,intent,services);
      // Persist before the API call. A hard crash or expired worker lease while
      // the old request is still in flight must never dispatch it a second time.
      await save({stage:'SOURCE_WRITE_STARTED',operationId:request.operationId,caseId:intent.caseId,intentHash:intent.intentHash,at:services.now()});
      c.snapshot=null; // The mutation adapter performs its own fresh read.
      try{const dispatch=await services.applySourceAssignment(intent);if(dispatch?.status==='NATIVE_BATCH_READY'){need(typeof dispatch.nativeBatchId==='string'&&dispatch.nativeBatchId,'NATIVE_BATCH_ID_REQUIRED');await save({stage:'SOURCE_DEFERRED',operationId:request.operationId,caseId:intent.caseId,intentHash:intent.intentHash,nativeBatchId:dispatch.nativeBatchId,at:services.now()});return {status:'SOURCE_NATIVE_BATCH_READY',nativeBatchId:dispatch.nativeBatchId,automaticRetry:false,actualWriteAcknowledged:false};}}catch(e){await save({stage:'SOURCE_UNKNOWN',operationId:request.operationId,caseId:intent.caseId,intentHash:intent.intentHash,at:services.now()});return {status:'SOURCE_WRITE_UNKNOWN',automaticRetry:false};}
      await save({stage:'SOURCE_DISPATCHED',operationId:request.operationId,caseId:intent.caseId,intentHash:intent.intentHash,at:services.now()});
      return {status:'SOURCE_WRITE_DISPATCHED',sourceCellWrites:1,monthlyWrites:0,mailWrites:0};
    }
    async function reconcileSourceInside(request){
      const c=await context(request),intent=one(c.events,'SOURCE_INTENT');need(intent,'SOURCE_INTENT_REQUIRED');
      need(intent.assignmentHash===sha(services,c.assignment),'ASSIGNMENT_CHANGED');
      need(contentHash(services,c.row.cells)===intent.expectedPostMonthlyContentHash,'SOURCE_AFTERIMAGE_NOT_VERIFIED');
      need(c.snapshot.dependencyHash===intent.dependencyHash,'DEPENDENCIES_CHANGED_AFTER_ASSIGNMENT');
      need(text(c.row.cells[2])===c.assignment.staffName&&!c.row.cells.some(cell=>cell.effectiveValue?.errorValue),'PROJECTED_SOURCE_FORMULA_ERROR');
      checkPromisedPay(c.row,c.assignment);
      need(c.snapshot.catalog&&c.snapshot.catalog.ledgerRevision===intent.preCatalog.ledgerRevision,'SOURCE_LEDGER_CHANGED');
      const prior=one(c.events,'SOURCE_PROJECTED');if(prior){need(prior.postMonthlyContentHash===contentHash(services,c.row.cells)&&sameCatalog(prior.postCatalog,c.snapshot.catalog),'PROJECTED_SOURCE_CHANGED');return {status:'SOURCE_ALREADY_PROJECTED',event:prior};}
      const event={schema:'LK_SOURCE_ASSIGNMENT_PROJECTED_V1',stage:'SOURCE_PROJECTED',operationId:request.operationId,caseId:intent.caseId,intentHash:intent.intentHash,assignmentHash:intent.assignmentHash,preCatalog:intent.preCatalog,postCatalog:copy(c.snapshot.catalog),preMonthlyContentHash:intent.preMonthlyContentHash,postMonthlyContentHash:contentHash(services,c.row.cells),at:services.now()};
      await save(event);return {status:'SOURCE_ASSIGNMENT_PROJECTED',event,finalApplicationConfirmed:false};
    }
    function checkPostAuthority(c){
      if(c.assignment.authority==='CREW_QUEUE'){
        const projected=one(c.events,'SOURCE_PROJECTED');need(projected,'SOURCE_PROJECTION_RECEIPT_REQUIRED');
        need(projected.assignmentHash===sha(services,c.assignment)&&sameCatalog(projected.postCatalog,c.snapshot.catalog)&&projected.postMonthlyContentHash===contentHash(services,c.row.cells),'POST_ASSIGNMENT_SOURCE_CHANGED');
      }
    }
    function monthlyPlan(c,request){
      checkPostAuthority(c);
      checkPromisedPay(c.row,c.assignment);
      const {snapshot,row,assignment}=c,{date,month,schema}=validate(snapshot,row,assignment,services);
      const fixedId=row.caseId; // New monthly rows retain the existing canonical Source case ID.
      need(!snapshot.months.some(m=>m.rows.some(r=>r.fixedId&&r.fixedId.toLowerCase()===fixedId.toLowerCase())),'EXISTING_DESTINATION_WITHOUT_RECEIPT');
      const position=choosePosition(month,date,row,request.layoutMode),mapped=mapSource(row.cells,fixedId,schema.width);
      const fees=FEE.map(column=>({column,value:normalizedEffective(row.cells[column])}));
      const projected=one(c.events,'SOURCE_PROJECTED');
      const snapshotProfile=snapshot.coverage?.schema===COMPACT_COVERAGE?STRUCTURAL_LAYOUT:LEGACY_LAYOUT;
      const intent={schema:'LK_MONTHLY_INTENT_V5',stage:'INTENT',spreadsheetId:services.spreadsheetId,operationId:request.operationId,caseId:row.caseId,fixedId,sourceContentHash:contentHash(services,row.cells),sourceSnapshot:row.cells.map(writable),sourceEffectiveFees:fees,assignment,assignmentHash:sha(services,assignment),ownerTransfer:copy(c.ownerTransfer),preCatalog:projected?.preCatalog||snapshot.catalog||null,postCatalog:snapshot.catalog||null,preMonthlyContentHash:projected?.preMonthlyContentHash||contentHash(services,row.cells),postMonthlyContentHash:contentHash(services,row.cells),month:{title:month.title,sheetId:month.sheetId,width:schema.width,rowCount:month.rowCount,snapshotProfile,contentHash:monthLayoutHash(services,month,snapshotProfile)},position,mapped,dependencyHash:snapshot.dependencyHash,createdAt:services.now(),retention:'AT_LEAST_THROUGH_'+(Number(date.slice(0,4))+(Number(date.slice(5,7))>=10?1:0))+'-09-30',concurrencyGuarantee:'TRUSTED_QUEUE_LEASE_AND_SAME_PROJECT_CONTROLLER_LOCK_ONLY'};
      intent.planHash=sha(services,{...intent,createdAt:0});return intent;
    }
    async function previewInside(request){
      const c=await context(request);if(one(c.events,'ACCEPTED'))return reconcileInside(request);
      const pending=one(c.events,'INTENT');if(pending)return {status:'MONTHLY_INTENT_EXISTS',intent:pending};
      if(c.assignment.authority==='CREW_QUEUE'&&!one(c.events,'SOURCE_PROJECTED')){
        const si=one(c.events,'SOURCE_INTENT')||sourceIntent(c,request);return {status:'SOURCE_ASSIGNMENT_PREVIEW_READY',reviewToken:si.intentHash,assignment:c.assignment,sourceWritesPlanned:1,monthlyWrites:0};
      }
      await monthlyContext(request,c);const intent=monthlyPlan(c,request);return {status:'MONTHLY_PREVIEW_READY',reviewToken:intent.planHash,intent,sourceWritesPlanned:0};
    }
    async function prepareMonthlyInside(request){
      const c=await monthlyContext(request),prior=one(c.events,'INTENT');if(prior){need(prior.assignmentHash===sha(services,c.assignment),'ASSIGNMENT_CHANGED');return {status:'MONTHLY_INTENT_EXISTS',intent:prior};}
      need(!one(c.events,'ACCEPTED'),'ALREADY_ACCEPTED');const intent=monthlyPlan(c,request);await save(intent);return {status:'MONTHLY_INTENT_PREPARED',intent};
    }
    async function applyMonthlyInside(request){
      const c=await monthlyContext(request),intent=one(c.events,'INTENT');need(intent,'MONTHLY_INTENT_REQUIRED');checkPostAuthority(c);
      checkPromisedPay(c.row,c.assignment);
      need(contentHash(services,c.row.cells)===intent.sourceContentHash&&sha(services,c.assignment)===intent.assignmentHash&&c.snapshot.dependencyHash===intent.dependencyHash,'MONTHLY_PREIMAGE_CHANGED');
      if(one(c.events,'ACCEPTED'))return reconcileInside(request);
      if(one(c.events,'MONTHLY_WRITE_STARTED')||one(c.events,'MONTHLY_DISPATCHED')||one(c.events,'UNKNOWN')||one(c.events,'DEFERRED')||c.snapshot.months.some(m=>m.rows.some(r=>r.fixedId===intent.fixedId)))return {status:'MONTHLY_RECONCILIATION_REQUIRED',automaticRetry:false};
      const fresh=monthlyPlan(c,request);need(fresh.planHash===intent.planHash,'MONTH_LAYOUT_OR_SOURCE_CHANGED');
      await save({stage:'MONTHLY_WRITE_STARTED',operationId:request.operationId,caseId:intent.caseId,planHash:intent.planHash,at:services.now()});
      c.snapshot=null;
      try{const dispatch=await services.applyMonthly(intent);if(dispatch?.status==='NATIVE_BATCH_READY'){need(typeof dispatch.nativeBatchId==='string'&&dispatch.nativeBatchId,'NATIVE_BATCH_ID_REQUIRED');await save({stage:'DEFERRED',operationId:request.operationId,caseId:intent.caseId,planHash:intent.planHash,nativeBatchId:dispatch.nativeBatchId,at:services.now()});return {status:'MONTHLY_NATIVE_BATCH_READY',nativeBatchId:dispatch.nativeBatchId,automaticRetry:false,actualWriteAcknowledged:false};}}catch(e){await save({stage:'UNKNOWN',operationId:request.operationId,caseId:intent.caseId,planHash:intent.planHash,at:services.now()});return {status:'MONTHLY_WRITE_UNKNOWN',automaticRetry:false};}
      await save({stage:'MONTHLY_DISPATCHED',operationId:request.operationId,caseId:intent.caseId,planHash:intent.planHash,at:services.now()});return {status:'MONTHLY_WRITE_DISPATCHED',monthlyBatches:1,sourceWrites:0,mailWrites:0};
    }
    async function reconcileInside(request){
      const c=await monthlyContext(request),intent=one(c.events,'INTENT');need(intent,'MONTHLY_INTENT_REQUIRED');checkPostAuthority(c);
      checkPromisedPay(c.row,c.assignment);
      need(contentHash(services,c.row.cells)===intent.sourceContentHash&&sha(services,c.assignment)===intent.assignmentHash,'SOURCE_OR_ASSIGNMENT_CHANGED_AFTER_INTENT');need(c.snapshot.dependencyHash===intent.dependencyHash,'DEPENDENCIES_CHANGED_AFTER_INTENT');
      const matches=c.snapshot.months.flatMap(m=>m.rows.filter(r=>r.fixedId===intent.fixedId).map(r=>({m,r})));need(matches.length===1,'UNKNOWN_DESTINATION_NOT_UNIQUE');
      const {m,r}=matches[0];need(m.title===intent.month.title&&m.sheetId===intent.month.sheetId&&r.cells.length===intent.month.width,'DESTINATION_ID_SCOPE_CHANGED');
      for(let i=0;i<54;i++)need(canonical(writable(r.cells[i]))===canonical(intent.mapped.business[i]),'DESTINATION_CONTENT_CHANGED',{column:i+1});
      need(canonical(writable(r.cells[intent.month.width-1]))===canonical(intent.mapped.idCell),'DESTINATION_ID_CHANGED');
      const actualFees=FEE.map(column=>({column,value:normalizedEffective(r.cells[column-1])}));need(canonical(actualFees)===canonical(intent.sourceEffectiveFees),'FINANCIAL_READBACK_MISMATCH');need(!r.cells.some(cell=>cell.effectiveValue?.errorValue),'DESTINATION_FORMULA_ERROR');
      const placementVerification=verifyPostPlacement(intent,m,r);
      const prior=one(c.events,'ACCEPTED');if(prior){need(prior.destinationContentHash===contentHash(services,r.cells),'DESTINATION_MANUAL_EDIT_CONFLICT');return {status:'NO_OP_ALREADY_ACCEPTED',ack:prior.ack,monthlyWrites:0,sourceWrites:0,mailWrites:0};}
      const a=intent.assignment,ack={schema:'LK_CASE_LIST_MONTHLY_ACK_V1',status:'MONTHLY_READBACK_VERIFIED',spreadsheetId:services.spreadsheetId,operationId:intent.operationId,queueId:a.queueId||null,companyId:a.companyId||null,jobId:a.jobId||null,sourceCaseId:intent.caseId,preCatalog:intent.preCatalog,postCatalog:intent.postCatalog,preMonthlyContentHash:intent.preMonthlyContentHash,postMonthlyContentHash:intent.postMonthlyContentHash,assignedJobRevision:a.assignedJobRevision||null,staffId:a.staffId,staffName:a.staffName,dateKey:a.dateKey,target:{sheetId:m.sheetId,title:m.title,fixedId:intent.fixedId,rowHint:r.row,readbackHash:contentHash(services,r.cells)},financialReadbackHash:sha(services,actualFees),placementVerification,preserveSource:true};
      await save({stage:'ACCEPTED',operationId:intent.operationId,caseId:intent.caseId,planHash:intent.planHash,sourceContentHash:intent.sourceContentHash,assignmentHash:intent.assignmentHash,destinationContentHash:contentHash(services,r.cells),ack,at:services.now()});return {status:'MONTHLY_READBACK_VERIFIED',ack,sourceWrites:0,mailWrites:0};
    }
    // Caller may use one bounded stage per invocation. execute is convenient for
    // the existing trusted worker; all mutations still have separate readbacks.
    async function executeInside(request){
      let c=await context(request);const accepted=!!one(c.events,'ACCEPTED'),projectSource=c.assignment.authority==='CREW_QUEUE'&&!one(c.events,'SOURCE_PROJECTED');c=null;
      if(accepted)return reconcileInside(request);
      if(projectSource){
        await prepareSourceInside(request);const dispatch=await applySourceInside(request);if(['SOURCE_WRITE_UNKNOWN','SOURCE_NATIVE_BATCH_READY'].includes(dispatch.status))return dispatch;
        const projected=await reconcileSourceInside(request);if(!['SOURCE_ASSIGNMENT_PROJECTED','SOURCE_ALREADY_PROJECTED'].includes(projected.status))return projected;
      }
      await prepareMonthlyInside(request);const dispatch=await applyMonthlyInside(request);if(['MONTHLY_WRITE_UNKNOWN','MONTHLY_NATIVE_BATCH_READY'].includes(dispatch.status))return dispatch;return reconcileInside(request);
    }
    return {preview:request=>locked(()=>previewInside(request)),prepareSource:request=>locked(()=>prepareSourceInside(request)),applySource:request=>locked(()=>applySourceInside(request)),reconcileSource:request=>locked(()=>reconcileSourceInside(request)),prepareMonthly:request=>locked(()=>prepareMonthlyInside(request)),applyMonthly:request=>locked(()=>applyMonthlyInside(request)),reconcile:request=>locked(()=>reconcileInside(request)),execute:request=>locked(()=>executeInside(request))};
  }
  return {create,canonical,contentHash,translateFormula,mapSource,choosePosition,verifyPostPlacement,transferCapability,assertSnapshotCoverage,assertSourceAssignmentPreflight,assertMonthlyWritePreflight,monthLayoutHash,SOURCE_INDEX_COLUMNS,monthIndexColumns,COMPACT_COVERAGE,STRUCTURAL_LAYOUT,LEGACY_LAYOUT,SOURCE_HEADERS:SOURCE,BUSINESS_HEADERS:BUSINESS,FINANCIAL_COLUMNS:FEE};
})();
if(typeof module!=='undefined')module.exports=LK_MONTHLY_V5;
