'use strict';
// Assignment evidence only. An observed empty cell is preserved as ''; it is
// never interpreted as zero, no addition, or a settled financial amount.
const need=(ok,code)=>{if(!ok)throw Object.assign(Error(code),{code});};
const object=x=>x!==null&&typeof x==='object'&&!Array.isArray(x);
function scalar(cell){
 need(object(cell)&&!Object.hasOwn(cell,'$unknown'),'ASSIGNMENT_CELL_NOT_OBSERVED');
 for(const key of ['userEnteredValue','effectiveValue'])if(Object.hasOwn(cell,key))need(object(cell[key]),'ASSIGNMENT_CELL_VALUE_INVALID');
 const entered=cell.userEnteredValue??{},effective=cell.effectiveValue??{};
 for(const [value,isEntered]of [[entered,true],[effective,false]]){
  need(object(value),'ASSIGNMENT_CELL_VALUE_INVALID');
  const keys=Object.keys(value);need(keys.length<=1,'ASSIGNMENT_CELL_VALUE_INVALID');
  for(const key of keys){
   need(key!=='errorValue','ASSIGNMENT_FORMULA_ERROR');
   need(['stringValue','numberValue','boolValue',...(isEntered?['formulaValue']:[])].includes(key),'ASSIGNMENT_CELL_VALUE_INVALID');
   need(key==='numberValue'?typeof value[key]==='number'&&Number.isFinite(value[key]):key==='boolValue'?typeof value[key]==='boolean':typeof value[key]==='string','ASSIGNMENT_CELL_VALUE_INVALID');
  }
 }
 if(Object.hasOwn(entered,'formulaValue'))need(entered.formulaValue.startsWith('=')&&Object.keys(effective).length===1,'ASSIGNMENT_FORMULA_RESULT_NOT_OBSERVED');
 const value=Object.keys(effective).length?effective:entered;
 return value.stringValue??value.numberValue??value.boolValue??'';
}
function observeRow(row,width){
 need(row?.fullWritable===true&&Array.isArray(row.knownColumns)&&row.knownColumns.length===width&&row.knownColumns.every((column,i)=>column===i),'ASSIGNMENT_FULL_ROW_REQUIRED');
 need(Array.isArray(row.cells)&&row.cells.length===width&&Array.from({length:width},(_,i)=>Object.hasOwn(row.cells,i)).every(Boolean),'ASSIGNMENT_FULL_ROW_REQUIRED');
 return row.cells.map(scalar);
}
function sourcePay(row,dailyWage){
 const values=observeRow(row,65),salary=values[28],allowance=values[29],wage=values[36];
 need([salary,allowance].every(v=>typeof v==='number'&&Number.isFinite(v)&&v>=0)&&Number.isSafeInteger(wage)&&wage>0&&salary+allowance===wage,'ASSIGNMENT_REQUIRED_PAY_MISSING_OR_CHANGED');
 if(dailyWage!==undefined)need(wage===dailyWage,'ASSIGNMENT_PUBLIC_PAY_CHANGED');
 return values;
}
function dependency(expected,actual){
 need(typeof expected==='string'&&/^[a-f0-9]{64}$/.test(expected)&&actual===expected,'ASSIGNMENT_DEPENDENCY_CHANGED_OR_UNREAD');
}
module.exports=Object.freeze({scalar,observeRow,sourcePay,dependency});
