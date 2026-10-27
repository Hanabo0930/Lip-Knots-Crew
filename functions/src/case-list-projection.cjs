'use strict';

// Pure preparation layer for the current 65-column MVP. No Apps Script,
// network, storage, publication, assignment, transfer, or deletion operation.
// Public readiness is deliberately not a live authorization primitive.
const SOURCE = Object.freeze({
  sheetId: 2026101601, title: '案件リスト', timeZone: 'Asia/Tokyo'
});
const HEADERS = Object.freeze(['キャンセル','実施日','スタッフ名','アドレス','入店時間','店舗名','スタッフ名','体温','入店時間','応募日','クライアント','店舗','メーカー','メニュー','入店時間','実施時間','備考','電話番号','資料発送日','請求単価','残業','遠方','緊急','店外','繁忙','検査','管理費','売上合計','給与','業務手当','残業','遠方','緊急','店外','繁忙','検査','基本給','交通費','立替(8%)','立替(10%)','通信費（請）','通信費（課税）','通信費（非課税）','請求不可','支給額合計','報告書チェック','原本チェック','メモ','単価','交通費','立替8％','立替10％','通信費','手当','合計金額','状態','地域','当日急募','日程方式','関連日程ID','募集枠ID','元情報','管理情報','取消','募集注意事項']);
class ProjectionError extends Error {
  constructor(code, detail) { super(code); this.name='ProjectionError'; this.code=code; this.detail=detail; }
}
const fail = (code, detail) => { throw new ProjectionError(code,detail); };
const own = (o,k) => Object.prototype.hasOwnProperty.call(o,k);
function canonical(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical(value[k])).join(',')+'}';
  fail('NON_CANONICAL_VALUE');
}
function entered(cell) { return cell?.userEnteredValue || {}; }
function scalar(v) {
  if (!v || typeof v!=='object' || Array.isArray(v)) fail('CELL_VALUE_SHAPE');
  const keys=Object.keys(v); if (!keys.length) return '';
  if (keys.length!==1) fail('CELL_VALUE_SHAPE');
  const k=keys[0],x=v[k];
  if (k==='stringValue' && typeof x==='string') return x;
  if (k==='numberValue' && typeof x==='number' && Number.isFinite(x)) return x;
  if (k==='boolValue' && typeof x==='boolean') return x;
  if (k==='formulaValue' && typeof x==='string' && x.startsWith('=')) return x;
  if (k==='errorValue') fail('CELL_ERROR');
  fail('CELL_VALUE_SHAPE');
}
function value(cell) {
  const u=entered(cell); const raw=scalar(u);
  if (own(u,'formulaValue')) return scalar(cell.effectiveValue || {});
  return raw;
}
function text(cell) { const v=value(cell);return typeof v==='string'?v.trim():''; }
function boolean(cell) {
  const v=value(cell); if (v==='') return false;
  if (typeof v!=='boolean') fail('BOOLEAN_CONTROL_INVALID'); return v;
}
function date(cell) {
  const v=value(cell);
  if (typeof v==='number' && Number.isInteger(v) && v>=0 && v<2958466)
    return new Date(Date.UTC(1899,11,30)+v*86400000).toISOString().slice(0,10);
  if (typeof v==='string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && Number.isFinite(Date.parse(v+'T00:00:00Z')) && new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v) return v;
  return '';
}
function time(v) {
  if (typeof v!=='string') return null;
  const m=/^(\d{1,2}):([0-5]\d)$/.exec(v.trim());
  return m && +m[1]<24 ? +m[1]*60 + +m[2] : null;
}
function execution(v) {
  const p=typeof v==='string'?v.split(/[～〜~]/):[];
  if (p.length!==2) return null;const a=time(p[0]),b=time(p[1]);
  return a!==null && b!==null && a<b ? [a,b] : null;
}
function metadata(cell) {
  try { const m=JSON.parse(text(cell)); return m && !Array.isArray(m) && m.schema==='LKCM1_CASE_META_V1' ? m : null; }
  catch (_) { return null; }
}
function fiscalYear(iso) { const y=+iso.slice(0,4),m=+iso.slice(5,7);return m>=10?y:y-1; }
function currentDate(now) {return new Date(now+9*3600000).toISOString().slice(0,10);}
function create({sha256,trustedSource}={}) {
  if (typeof sha256!=='function') fail('SHA256_DEPENDENCY_REQUIRED');
  if (!trustedSource || typeof trustedSource.spreadsheetId!=='string' || !/^[A-Za-z0-9_-]{10,200}$/.test(trustedSource.spreadsheetId) || canonical(trustedSource)!==canonical({...SOURCE,spreadsheetId:trustedSource.spreadsheetId})) fail('TRUSTED_SOURCE_REQUIRED');
  const hash=v=>{const h=sha256(canonical(v)); if (typeof h!=='string'||!/^[a-f0-9]{64}$/.test(h)) fail('SHA256_INVALID');return h;};
  function inspect({source,rows,nowISO,approvals=[]}={}) {
    if (canonical(source)!==canonical(trustedSource)) fail('SOURCE_BINDING_MISMATCH');
    if (!Array.isArray(rows)||!rows.length||rows.some(r=>!Array.isArray(r)||r.length!==65)) fail('CURRENT_65_COLUMN_MATRIX_REQUIRED');
    for(const r of rows) for(const c of r){if(!c||typeof c!=='object'||Array.isArray(c))fail('CELL_SHAPE');scalar(entered(c));if(c.effectiveValue)scalar(c.effectiveValue);}
    if (canonical(rows[0].map(text))!==canonical(HEADERS)) fail('CURRENT_65_COLUMN_HEADERS_REQUIRED');
    const now=Date.parse(nowISO);if(!Number.isFinite(now)||typeof nowISO!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(nowISO))fail('OBSERVATION_TIME_REQUIRED');
    if(!Array.isArray(approvals))fail('APPROVAL_LIST_INVALID');
    const approvalIndex=new Map();for(const a of approvals){if(!a||typeof a.jobId!=='string'||approvalIndex.has(a.jobId))fail('AMBIGUOUS_APPROVAL');approvalIndex.set(a.jobId,a);}
    const byId=new Map(),slots=[],today=currentDate(now);
    for(let i=1;i<rows.length;i++){
      const r=rows[i],jobId=text(r[60]);
      const business=[1,2,10,11,12,13,14,15].some(n=>{const u=entered(r[n]);return !own(u,'formulaValue') && scalar(u)!=='';});
      if(!jobId&&!business)continue;
      if(!/^LKCASE_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(jobId)) fail('CASE_ID_REQUIRED',{row:i+1});
      if(byId.has(jobId))fail('DUPLICATE_CASE_ID',{jobId,rows:[byId.get(jobId),i+1]});
      byId.set(jobId,i+1);
      // Row positions and visual formatting never determine identity or revision.
      // Include UEV and eV from all 65 cells so literal/financial edits also revoke old approvals.
      const revision=hash({schema:'LK_CASE_CONTENT_REVISION_V1',jobId,cells:r.map(c=>({userEnteredValue:entered(c),effectiveValue:c.effectiveValue||{}}))});
      const d=date(r[1]),arrival=text(r[14]),run=text(r[15]),exec=execution(run),meta=metadata(r[62]),holds=[];
      const state=text(r[55]),client=text(r[10]),store=text(r[11]),manufacturer=text(r[12]),menu=text(r[13]);
      const a=approvalIndex.get(jobId);
      const approved=!!a&&a.schema==='LK_CASE_PUBLIC_APPROVAL_V1'&&a.approved===true&&a.expectedRevision===revision&&typeof a.ownerApprovalRef==='string'&&a.ownerApprovalRef.trim()!=='';
      const review=a?.sourceReview,issues=Array.isArray(meta?.issues)&&meta.issues.every(x=>typeof x==='string')?meta.issues:[];
      const reviewed=approved&&!!meta&&review?.schema==='LK_CASE_SOURCE_REVIEW_V1'&&review.expectedRevision===revision&&review.headcountPerSlot===1&&canonical(review.reviewedIssues)===canonical(issues)&&typeof review.resolutionNote==='string'&&review.resolutionNote.trim().length>=3;
      const cancelled=boolean(r[63])||/取消|キャンセル|中止|\bcancel(?:led|ed)?\b/i.test(client.normalize('NFKC'));
      const urgent=boolean(r[57]),staffValue=value(r[2]);
      // Only a proven empty cell/result is an empty slot. Numbers, false and
      // a formula without its computed value require human reconciliation.
      const staffFormulaUnresolved=own(entered(r[2]),'formulaValue')&&!r[2].effectiveValue;
      const assigned=typeof staffValue==='string'&&staffValue.trim()!=='';
      if(staffFormulaUnresolved||typeof staffValue!=='string')holds.push('STAFF_CELL_UNCONFIRMED');
      if(!d)holds.push('DATE_UNCONFIRMED');
      if(!client||!store||!manufacturer||!menu)holds.push('BUSINESS_FIELDS_UNCONFIRMED');
      if(time(arrival)===null||!exec||exec&&time(arrival)>exec[0])holds.push('TIME_UNCONFIRMED');
      if(!['単日','候補日','全日同一','日別可'].includes(text(r[58])))holds.push('DATE_MODE_UNCONFIRMED');
      if(text(r[58])!=='単日'&&!text(r[59]))holds.push('SCHEDULE_GROUP_UNCONFIRMED');
      if(text(r[58])!=='単日')holds.push('MULTI_DATE_GROUP_REVIEW_REQUIRED');
      if(!meta)holds.push('METADATA_UNCONFIRMED');
      if(meta?.publicEligible!==true&&!reviewed)holds.push('SOURCE_NOT_PUBLIC_ELIGIBLE');
      if(meta?.headcountConfirmed!==true&&!reviewed)holds.push('HEADCOUNT_UNCONFIRMED');
      if(meta?.wordReconcile?.active===false)holds.push('SOURCE_NOT_CURRENT');
      if(state!=='募集中')holds.push('SOURCE_NOT_PUBLIC');
      if(cancelled)holds.push('CANCELLED_OR_CANCELLATION_REVIEW');
      if(assigned)holds.push('ALREADY_ASSIGNED');
      if(d && (d<today || !urgent && d===today))holds.push('RECRUITMENT_DEADLINE_PASSED');
      const startAt=d&&exec?Date.parse(d+'T'+String(Math.floor(exec[0]/60)).padStart(2,'0')+':'+String(exec[0]%60).padStart(2,'0')+':00+09:00'):null;
      if(urgent && startAt!==null && now>=startAt)holds.push('URGENT_START_PASSED');
      if(!approved)holds.push(a?'OWNER_APPROVAL_STALE_OR_INVALID':'OWNER_APPROVAL_REQUIRED');
      if(!a?.confirmedFields||['arrival','execution','headcount','dateMode','payOffer'].some(f=>a.confirmedFields[f]!==true))holds.push('OWNER_FIELD_CONFIRMATIONS_REQUIRED');
      const pay=a?.payOffer;
      const payValid=!!pay&&Number.isSafeInteger(pay.dailyWageJPY)&&pay.dailyWageJPY>0&&pay.dailyWageJPY<=1000000&&pay.travelExpenses==='全額支給'&&pay.communicationExpenses==='全額支給';
      if(!payValid)holds.push('PUBLIC_PAY_OFFER_REQUIRED');
      const deadline=d?(urgent&&startAt!==null?new Date(startAt).toISOString():new Date(d+'T00:00:00+09:00').toISOString()):null;
      // Allowlist only. Names, email, phone, source mail, manager JSON, financial cells never leave here.
      const candidate={jobId,expectedRevision:revision,date:d,client,store,manufacturer,menu,arrival,execution:run,region:text(r[56]),urgent,dateMode:text(r[58]),scheduleGroupId:text(r[59]),deadline,payOffer:payValid?{dailyWageJPY:pay.dailyWageJPY,travelExpenses:pay.travelExpenses,communicationExpenses:pay.communicationExpenses}:null};
      slots.push({jobId,sourceRow:i+1,revision,fiscalYear:d?fiscalYear(d):null,sourceState:state,holdReasons:[...new Set(holds)],publicCandidate:holds.length===0?candidate:null,retentionAction:'KEEP_SOURCE_AND_ID'});
    }
    slots.sort((a,b)=>a.jobId.localeCompare(b.jobId));
    return {schema:'LK_CASE_CATALOG_PREPARATION_V1',scope:'LOCAL_PREPARATION_ONLY',source:{...trustedSource},observedAt:nowISO,sourceDigest:hash(slots.map(s=>({jobId:s.jobId,revision:s.revision}))),slots,publicCandidates:slots.filter(s=>s.publicCandidate).map(s=>s.publicCandidate),counts:{slots:slots.length,held:slots.filter(s=>s.holdReasons.length).length,publicCandidates:slots.filter(s=>s.publicCandidate).length},operations:{sourceWrites:0,monthlyWrites:0,publications:0,assignments:0,deletions:0}};
  }
  return Object.freeze({inspect});
}
module.exports=Object.freeze({SOURCE,HEADERS,create,ProjectionError,canonical});
