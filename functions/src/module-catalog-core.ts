export type ModuleDef={code:string;name:string;setupDays:number;setupFeeYen:number;monthlyFeeYen:number;dependencies:string[]};
export const MODULES:ModuleDef[]=[
{code:"staff",name:"スタッフ管理",setupDays:0,setupFeeYen:0,monthlyFeeYen:0,dependencies:[]},
{code:"jobs",name:"案件管理",setupDays:0,setupFeeYen:0,monthlyFeeYen:0,dependencies:["staff"]},
{code:"contracts",name:"契約書管理",setupDays:2,setupFeeYen:120000,monthlyFeeYen:12000,dependencies:["staff"]},
{code:"inventory",name:"資材・在庫管理",setupDays:2,setupFeeYen:150000,monthlyFeeYen:15000,dependencies:["jobs"]},
{code:"shipping",name:"発送管理",setupDays:2,setupFeeYen:120000,monthlyFeeYen:12000,dependencies:["inventory","jobs"]},
{code:"billing",name:"請求管理",setupDays:2,setupFeeYen:120000,monthlyFeeYen:15000,dependencies:["jobs"]},
{code:"payroll",name:"給与・支払管理",setupDays:3,setupFeeYen:180000,monthlyFeeYen:18000,dependencies:["staff","jobs"]},
{code:"training",name:"研修・テスト",setupDays:2,setupFeeYen:100000,monthlyFeeYen:10000,dependencies:["staff"]},
{code:"analytics",name:"分析",setupDays:2,setupFeeYen:120000,monthlyFeeYen:12000,dependencies:["jobs"]},
{code:"esign",name:"電子契約連携",setupDays:2,setupFeeYen:100000,monthlyFeeYen:8000,dependencies:["contracts"]},
{code:"line",name:"LINE連携",setupDays:2,setupFeeYen:100000,monthlyFeeYen:10000,dependencies:["staff"]},
];
export function resolveModules(codes:string[]){
 const set=new Set(codes),map=new Map(MODULES.map(m=>[m.code,m])),missing=new Set<string>();
 codes.forEach(c=>map.get(c)?.dependencies.forEach(d=>{if(!set.has(d))missing.add(d)}));
 return{modules:codes.flatMap(c=>map.get(c)?[map.get(c)!]:[]),missingDependencies:[...missing]};
}
export function moduleEstimate(codes:string[]){
 const r=resolveModules(codes),all=[...new Set([...codes,...r.missingDependencies])],mods=MODULES.filter(m=>all.includes(m.code));
 const setupDays=Math.max(1,Math.ceil(mods.reduce((s,m)=>s+m.setupDays,0)*0.65));
 return{setupDays,setupFeeYen:mods.reduce((s,m)=>s+m.setupFeeYen,0),monthlyFeeYen:mods.reduce((s,m)=>s+m.monthlyFeeYen,0),canDeliverWithinSevenDays:setupDays<=7};
}
