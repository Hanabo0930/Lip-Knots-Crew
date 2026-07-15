export function proposalMarkdown(i:{companyName:string;contactName:string;industry:string;recommendedPlan:string;setupFeeYen:number;monthlyFeeYen:number;estimatedDays:number;annualNetBenefitYen:number}){
 const yen=(v:number)=>`${Math.round(v).toLocaleString("ja-JP")}円`;
 return[`# ${i.companyName} 御中 システム導入ご提案`,"",`ご担当者: ${i.contactName}`,`業種: ${i.industry}`,"","## 推奨プラン",`**${i.recommendedPlan}**`,"","## 概算",`- 初期費用: **${yen(i.setupFeeYen)}**`,`- 月額費用: **${yen(i.monthlyFeeYen)}**`,`- 納期目安: **${i.estimatedDays}営業日**`,`- 年間純効果見込: **${yen(i.annualNetBenefitYen)}**`,"","## 導入工程","1. 要件確認","2. テンプレート選定","3. 設定・追加開発","4. 検証","5. 納品"].join("\n");
}
