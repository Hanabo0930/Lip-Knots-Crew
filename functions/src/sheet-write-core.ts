export type ExpectedValue = { mode:"any"|"blank"|"exact"; value?:unknown };
export type OperationConfig = { values:string[]; styles?:string[] };
export type MappingConfig = { columns:Record<string,string>; operations:Record<string,OperationConfig> };
export function validateMutation(mapping:MappingConfig,operation:string,updates:Record<string,unknown>,styles:Record<string,unknown>={}):string[]{
  const errors:string[]=[]; const op=mapping.operations[operation]; if(!op)return [`未許可の操作です: ${operation}`];
  for(const key of Object.keys(updates)){if(!op.values.includes(key))errors.push(`${operation}では${key}を更新できません`);if(!mapping.columns[key])errors.push(`${key}の列マッピングがありません`);}
  for(const key of Object.keys(styles)){if(!(op.styles??[]).includes(key))errors.push(`${operation}では${key}の書式を変更できません`);if(!mapping.columns[key])errors.push(`${key}の列マッピングがありません`);}
  return errors;
}
export function normalizeComparable(value:unknown):string{return String(value??"").normalize("NFKC").replace(/[\s　]+/g,"").trim();}
export function expectedMatches(current:unknown,expected?:ExpectedValue):boolean{if(!expected||expected.mode==="any")return true;if(expected.mode==="blank")return normalizeComparable(current)==="";return normalizeComparable(current)===normalizeComparable(expected.value);}
export function valuesEquivalent(a:unknown,b:unknown):boolean{return normalizeComparable(a)===normalizeComparable(b);}
export function columnToNumber(column:string):number{let n=0;for(const c of column.toUpperCase()){if(c<"A"||c>"Z")throw new Error(`不正な列: ${column}`);n=n*26+c.charCodeAt(0)-64;}return n;}
