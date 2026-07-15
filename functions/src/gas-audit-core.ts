export type GasRiskLevel = "critical" | "high" | "medium" | "low";
export type GasFinding = {
  id:string; filename:string; line:number; category:string; risk:GasRiskLevel;
  title:string; evidence:string; recommendation:string;
  affectedColumns:string[]; affectedSheets:string[];
};
export type GasAuditReport = {
  files:number; lines:number; findings:GasFinding[]; score:number;
  grade:"A"|"B"|"C"|"D"|"E"; blockers:number;
  summary:Record<GasRiskLevel,number>;
  columnDependencies:Record<string,number>;
  operationDependencies:{billing:number;payroll:number;pdf:number;email:number;triggers:number};
};

const A1 = /(["'`])((?:'[^']+'!)?\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?)\1/g;
const NUMERIC_RANGE = /\.getRange\s*\(\s*[^,\n]+\s*,\s*(\d+)/g;
const SHEET = /getSheetByName\s*\(\s*(["'`])([^"'`]+)\1\s*\)/g;

export function auditGasSources(inputs:Array<{filename:string;source:string}>):GasAuditReport {
  const findings:GasFinding[]=[];
  let lines=0;
  for (const input of inputs) {
    const source=input.source.replace(/\r\n/g,"\n");
    const rows=source.split("\n");
    lines+=rows.length;
    const sheets=[...source.matchAll(SHEET)].map(m=>m[2]!).filter(Boolean);
    rows.forEach((line,index)=>scan(input.filename,line,index+1,sheets,findings));
    const writes=/\.(?:setValue|setValues|setFormula|setFormulas|setFormulaR1C1|setFormulasR1C1|clear|clearContent|clearFormat|insertRows?|deleteRows?|insertColumns?|deleteColumns?)\s*\(/.test(source);
    const lock=/LockService\.(?:getScriptLock|getDocumentLock|getUserLock)/.test(source);
    if(writes&&!lock) findings.push(finding(input.filename,1,"lock_missing","high",
      "書込処理に排他ロックがありません","LockServiceが未検出",
      "tryLockとfinallyでreleaseLockを実装してください。",[],sheets));
  }
  const unique=[...new Map(findings.map(f=>[f.id+"|"+f.evidence,f])).values()];
  const summary={critical:0,high:0,medium:0,low:0} as Record<GasRiskLevel,number>;
  const columns:Record<string,number>={};
  const ops={billing:0,payroll:0,pdf:0,email:0,triggers:0};
  unique.forEach(f=>{
    summary[f.risk]++;
    f.affectedColumns.forEach(c=>columns[c]=(columns[c]??0)+1);
    const t=(f.title+" "+f.evidence).toLowerCase();
    if(/請求|invoice|billing|売上/u.test(t))ops.billing++;
    if(/給与|payroll|salary|支給|明細/u.test(t))ops.payroll++;
    if(f.category==="pdf_export")ops.pdf++;
    if(f.category==="mail_send")ops.email++;
    if(f.category==="trigger")ops.triggers++;
  });
  const score=Math.max(0,100-summary.critical*18-summary.high*8-summary.medium*3-summary.low);
  const grade=score>=90?"A":score>=75?"B":score>=60?"C":score>=40?"D":"E";
  return {files:inputs.length,lines,findings:unique,score,grade,
    blockers:summary.critical+summary.high,summary,
    columnDependencies:columns,operationDependencies:ops};
}

function scan(filename:string,line:string,lineNo:number,sheets:string[],out:GasFinding[]):void {
  const trimmed=line.trim();
  if(!trimmed||trimmed.startsWith("//"))return;
  for(const m of line.matchAll(A1)){
    const cols=[...(m[2]??"").matchAll(/\$?([A-Z]{1,3})\$?\d+/g)].map(x=>x[1]!).filter(Boolean);
    out.push(finding(filename,lineNo,"hardcoded_a1",cols.some(critical)?"high":"medium",
      "A1形式の参照が固定されています",m[0],
      "ヘッダー名から列を解決するマッピングへ変更してください。",cols,sheets));
  }
  for(const m of line.matchAll(NUMERIC_RANGE)){
    const col=toColumn(Number(m[1])-1);
    out.push(finding(filename,lineNo,"numeric_column",critical(col)?"high":"medium",
      "getRangeの列番号が固定されています",m[0],
      "列番号の直書きをやめ、列マッピングを使用してください。",[col],sheets));
  }
  const rules:Array<[RegExp,string,GasRiskLevel,string,string]>=[
    [/\.(?:insertColumn|insertColumns|deleteColumn|deleteColumns)\w*\s*\(/,"column_change","critical","列の追加・削除があります","全GAS・数式・PDF・メールの列依存を更新してください。"],
    [/\.(?:insertRow|insertRows|deleteRow|deleteRows)\w*\s*\(/,"row_change","high","行の追加・削除があります","案件ID、排他制御、冪等性、ロールバックを追加してください。"],
    [/\.(?:clear|clearContent|clearFormat)\s*\(/,"clear","high","セルを消去しています","入力列だけへ限定し、数式・書式・入力規則を保護してください。"],
    [/\.(?:setFormula|setFormulas|setFormulaR1C1|setFormulasR1C1)\s*\(/,"formula_write","high","数式を書き換えています","書込後の数式検算を追加してください。"],
    [/(?:getAs\s*\(\s*["'`]application\/pdf|MimeType\.PDF|exportAsPdf)/i,"pdf_export","high","PDF出力があります","印刷範囲・ページ数・ファイル名を旧版と比較してください。"],
    [/(?:MailApp|GmailApp)\.(?:sendEmail|createDraft)/,"mail_send","high","メール送信があります","送信対象・添付・二重送信を旧版と比較してください。"],
    [/ScriptApp\.(?:newTrigger|getProjectTriggers|deleteTrigger)/,"trigger","high","トリガー操作があります","検証コピーでは本番処理を止める環境ガードを追加してください。"],
    [/UrlFetchApp\.fetch(?:All)?\s*\(/,"external_call","medium","外部API通信があります","検証環境では送信先を無効化してください。"],
    [/\beval\s*\(|new\s+Function\s*\(/,"dynamic_eval","critical","動的コード実行があります","明示的な許可操作へ置き換えてください。"],
  ];
  for(const [pattern,category,risk,title,rec] of rules){
    const m=pattern.exec(line); if(!m)continue;
    out.push(finding(filename,lineNo,category,risk,title,trimmed.slice(0,240),rec,[],sheets));
  }
}
function finding(filename:string,line:number,category:string,risk:GasRiskLevel,title:string,evidence:string,recommendation:string,cols:string[],sheets:string[]):GasFinding{
  return {id:`${filename}:${line}:${category}`,filename,line,category,risk,title,evidence,recommendation,
    affectedColumns:[...new Set(cols)],affectedSheets:[...new Set(sheets)]};
}
function critical(c:string):boolean{return ["S","T","U","V","W","X","Y","Z","AA","AB","AC","AD","AE","AF","AG","AH","AI","AJ","AK","AL","AM","AN","AO","AP","AQ","AR","AV","AW","AX","AY","AZ","BA","BB"].includes(c);}
function toColumn(index:number):string{let v=index+1,r="";while(v>0){const x=(v-1)%26;r=String.fromCharCode(65+x)+r;v=Math.floor((v-1)/26);}return r;}
