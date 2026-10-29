import { activeAssignedJobs, hasValidDateKey } from './job-list';
export type CalendarShift = {
  id:string; dateKey:string; status:string; cancelled?:boolean; applicationUnconfirmed?:boolean;
  storeName:string; makerName:string; menuName:string; workTime:string;
  entryTime?:string; storeAddress?:string; clientName?:string;
};
export function adjacentMonth(month:string,offset:number):string {
  if(!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||!Number.isInteger(offset))throw Error('表示月を確認できません。');
  const [year,value]=month.split('-').map(Number),date=new Date(0);
  date.setUTCFullYear(year,value-1+offset,1);
  const nextYear=date.getUTCFullYear();
  if(nextYear<1||nextYear>9999)throw Error('表示月の範囲を超えています。');
  return `${String(nextYear).padStart(4,'0')}-${String(date.getUTCMonth()+1).padStart(2,'0')}`;
}
export function monthCalendar<T extends CalendarShift>(jobs:T[],month:string):{days:(string|null)[];jobs:Map<string,T[]>} {
  adjacentMonth(month,0);
  const [year,value]=month.split('-').map(Number),first=new Date(0);
  first.setUTCFullYear(year,value-1,1);
  const last=new Date(first);last.setUTCMonth(value,0);
  const days:(string|null)[]=Array(first.getUTCDay()).fill(null);
  for(let day=1;day<=last.getUTCDate();day++)days.push(`${month}-${String(day).padStart(2,'0')}`);
  while(days.length%7)days.push(null);
  const result=new Map<string,T[]>(),ids=new Set<string>();
  for(const job of jobs){
    if(ids.has(job.id))throw Error('同じ案件が重複しています。「シフトを更新」で確認してください。');
    ids.add(job.id);
  }
  for(const job of activeAssignedJobs(jobs)){
    if(job.applicationUnconfirmed===true||!hasValidDateKey(job)||!job.dateKey.startsWith(month+'-'))continue;
    const day=result.get(job.dateKey)??[];day.push(job);result.set(job.dateKey,day);
  }
  return {days,jobs:result};
}
