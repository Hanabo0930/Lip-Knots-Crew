'use strict';
// Read-only calculation excerpts from the verified V17/bound GAS HEAD source.
// SHA256 of LK_CaseTransfer.gs: 3a5c927afa6f9ee51704c1226668c4f9fac679a5a431718a6e514a3658665887.
// This oracle reconstructs GAS inputs directly from synthetic Sheet responses,
// independently of the production proof assembler and its stored expected hash.
const crypto=require('node:crypto');
const LK_TRANSFER_PLAN=require('../../functions/src/case-list-gas-planner.cjs');
const LK_TRANSFER_MAP={canonical};
function canonical(x){if(x===null||['string','boolean'].includes(typeof x))return JSON.stringify(x);if(typeof x==='number'&&Number.isFinite(x))return JSON.stringify(x);if(Array.isArray(x))return '['+x.map(canonical).join(',')+']';if(x&&typeof x==='object')return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';throw Error('UNSERIALIZABLE');}
function lkCaseMvpSha_(x){return crypto.createHash('sha256').update(typeof x==='string'?x:JSON.stringify(x),'utf8').digest('hex');}
function digest(v){return lkCaseMvpSha_(LK_TRANSFER_MAP.canonical(v));}
function value(c){const v=c?.effectiveValue??c?.userEnteredValue??{};return v.numberValue??v.stringValue??v.boolValue??'';}
function entered(c){return c?.userEnteredValue??{};}
function text(v){return String(v??'').trim();}
function caseHash(cells){return digest(cells.map(c=>[entered(c),c.effectiveValue??{},c.userEnteredFormat??{},c.note??'',c.dataValidation??{},c.textFormatRuns??[],c.chipRuns??[]]));}
function recordHash(cells){return digest(cells.map(c=>[entered(c),c.effectiveValue??{}]));}
function proof(p){return digest([p.book,p.id,p.date,p.source.sheetId,p.sourceRow,p.sourceHash,p.monthSheet.sheetId,p.monthHash,p.ledgerRow,p.ledgerHash,p.position,p.existing,...(p.group?[p.group.hash]:[])]);}
function batchFingerprint(p){return digest([p.id,p.date,p.monthSheet.sheetId,p.sourceHash,p.ledgerValues[0]?p.ledgerRow:null,p.ledgerHash,p.group?[p.group.id,p.group.peers.map(peer=>[peer.id,peer.sourceHash,peer.ledgerHash])]:null]);}
function inspect(input){
  function grid(book,sheet,range,fields){
    if(book!==input.book||sheet!==input.monthSheet||range!=='A2:O'+sheet.gridProperties.rowCount||fields!=='effectiveValue,userEnteredValue')throw Error('ORACLE_READ_PROFILE');
    return input.rowData;
  }
  function monthRows(book, sheet, ids) {
    const end=sheet.gridProperties.rowCount;
    const data=grid(book,sheet,'A2:O'+end,'effectiveValue,userEnteredValue');
    const rows=data.map((line,i)=>{
      const cells=line.values??[],r=cells.map(value);
      return {row:i+2,date:r[0]??'',staff:r[1]??'',client:r[9]??'',store:r[10]??'',maker:r[11]??'',product:r[12]??'',arrival:r[13]??'',execution:r[14]??'',totalFormula:entered(cells[1]).formulaValue??'',id:ids[i+1]?.[0]??''};
    });
    const [year,month]=sheet.title.split('.');
    const dashboard=rows.filter(r=>text(r.date).startsWith(year+'年'+Number(month)+'月の数字'));
    const boundaryRow=dashboard.length===1?dashboard[0].row:null;
    const emptyTemplateRow=boundaryRow===5&&rows.slice(0,3).every(r=>!r.date&&!r.staff&&!r.client)&&rows[1]?.totalFormula.includes('COUNTIF($A:$A,INDEX($A:$A,ROW()))')?2:null;
    return {title:sheet.title,rows,boundaryRow,emptyTemplateRow,allowTotalRepair:true};
  }
  const month=monthRows(input.book,input.monthSheet,input.ids);month.allowTotalRepair=false;
  const p={...input,month,sourceHash:caseHash(input.sourceCells),ledgerHash:recordHash(input.ledgerCells),ledgerValues:input.ledgerCells.map(value),existing:null};
  p.monthHash=digest([month.rows,month.boundaryRow,false,input.width]);
  p.position=LK_TRANSFER_PLAN.choosePosition(month,p.date,{client:text(value(input.sourceCells[10])),arrival:value(input.sourceCells[14])});
  return {proof:proof(p),batchFingerprint:batchFingerprint(p),monthHash:p.monthHash,position:p.position,p};
}

// Exact LK_RowGuard_v1.gs source, LK_SD 2.0.1, current HEAD read 2026-11-07.
const LK_SD=Object.freeze({VERSION:'2.0.1',MARK:'LK_STAFF_DATE_V2',CLOCK:'ケイ_応募日補助',DIMS:'LK_STAFF_DATE_DIMS_V2'});
function lkStaffDateLiteral_(value){
  if(value instanceof Date)return String(value.getTime()/86400000+25569+9/24);
  if(typeof value==='number'&&isFinite(value))return String(value);
  if(typeof value==='boolean')return value?'TRUE':'FALSE';
  return '"'+String(value==null?'':value).replace(/"/g,'""')+'"';
}
function lkStaffDateFormula_(row,name,value){
  const b='$B'+row,n=lkStaffDateLiteral_(String(name==null?'':name));
  return '=IF(N("'+LK_SD.MARK+'"),"",IF(EXACT(TO_TEXT('+b+'),'+n+'),'+lkStaffDateLiteral_(value)+',IF(OR(ISFORMULA('+b+'),LEN(TRIM(SUBSTITUTE(TO_TEXT('+b+'),"　"," ")))=0,REGEXMATCH(TRIM(TO_TEXT('+b+')),"^(スタッフ名|合計|小計|総計|人数)$|^[（(]?[ 　]*[0-9０-９]+人[ 　]*[）)]?[ 　]*$")),"",\''+LK_SD.CLOCK+'\'!$A$1)))';
}
module.exports={inspect,digest,proof,batchFingerprint,lkStaffDateLiteral_,lkStaffDateFormula_};
