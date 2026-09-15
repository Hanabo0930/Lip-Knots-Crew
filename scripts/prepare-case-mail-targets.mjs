import {CaseMailImportError} from "./case-mail-import-adapter.mjs";
import {writeCaseMailTargets,parseOptions} from "./prepare-case-mail-import.mjs";
try{
 const out=writeCaseMailTargets(parseOptions(process.argv.slice(2),true));
 console.log(JSON.stringify({ok:true,caseCount:out.caseCount,files:["targets.json","import-source.json","review.json"],recommendedImportFile:"import-source.json",appSnapshotRequired:true,registrationRequired:true,dispatch:"disabled"}));
}catch(error){
 const known=error instanceof CaseMailImportError;
 console.error(JSON.stringify({ok:false,code:known?error.code:"local_io",message:known?error.message:"ローカルの入力・変換コード・出力先を確認できません。元ファイルと読取権限を確認してください。"}));
 process.exitCode=1;
}
