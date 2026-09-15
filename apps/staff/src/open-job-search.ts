type SearchableJob = {dateKey?:unknown;storeName?:unknown;makerName?:unknown;menuName?:unknown;storeAddress?:unknown};
const normalize=(value:unknown)=>typeof value==='string'?value.normalize('NFKC').toLocaleLowerCase('ja-JP'):'';
const dateQuery=/^(?:(\d{4})[-/年])?(\d{1,2})[-/月](\d{1,2})日?(?:\(([日月火水木金土])(?:曜(?:日)?)?\))?$/u;
function matchesDate(key:unknown,parts:RegExpExecArray):boolean{
 if(typeof key!=='string'||!/^\d{4}-\d{2}-\d{2}$/u.test(key))return false;
 const [year,month,day]=key.split('-').map(Number);
 if(parts[1]&&Number(parts[1])!==year||Number(parts[2])!==month||Number(parts[3])!==day)return false;
 const date=new Date(key+'T00:00:00Z');
 return date.getUTCFullYear()===year&&date.getUTCMonth()+1===month&&date.getUTCDate()===day&&(!parts[4]||parts[4]==='日月火水木金土'[date.getUTCDay()]);
}
export function filterOpenJobs<T extends SearchableJob>(jobs:T[],query:string):T[]{
 const terms=normalize(query).trim().split(/\s+/u).filter(Boolean).map(value=>({value,date:dateQuery.exec(value)}));
 if(!terms.length)return jobs;
 return jobs.filter(job=>{const text=[job.dateKey,job.storeName,job.makerName,job.menuName,job.storeAddress].map(normalize).join(' ');return terms.every(term=>term.date?matchesDate(job.dateKey,term.date):text.includes(term.value));});
}