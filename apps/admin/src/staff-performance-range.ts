export type StaffPerformanceRange={from:string;through:string};
export function currentStaffPerformanceYearRange(now=new Date()):StaffPerformanceRange{
  const year=new Date(now.getTime()+9*60*60*1000).getUTCFullYear();
  if(!Number.isInteger(year)||year<1||year>9999)throw Error('集計年を確認できません。');
  const prefix=String(year).padStart(4,'0');
  return {from:`${prefix}-01-01`,through:`${prefix}-12-31`};
}
export function validStaffPerformanceRange(value:StaffPerformanceRange):boolean{
  const date=(input:unknown)=>{
    if(typeof input!=='string'||!/^\d{4}-(0[1-9]|1[0-2])-\d{2}$/.test(input)||input.startsWith('0000-'))return false;
    const parsed=new Date(input+'T00:00:00.000Z');
    return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===input;
  };
  return Boolean(value)&&date(value.from)&&date(value.through)&&value.from<=value.through;
}
