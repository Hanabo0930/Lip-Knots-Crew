import {
  defaultRegressionCases,
  summarizeRegression,
} from "../src/gas-regression-core";
function equal(actual: unknown, expected: unknown, message: string): void {
  if (actual !== expected) throw new Error(message);
}
const cases=defaultRegressionCases();
equal(cases.length,12,"回帰テスト数が違います。");
const results=cases.map((item)=>({
  caseId:item.id,status:"passed" as const,actual:"OK",evidence:[],note:"",
}));
equal(summarizeRegression(cases,results).ready,true,"全合格でreadyになりません。");
equal(summarizeRegression(cases,results.slice(1)).ready,false,"未実施を許可しています。");
console.log("gas regression core tests passed");
