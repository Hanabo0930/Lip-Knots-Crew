export type ReservationJob={id?:string;companyId?:string;dateKey?:string;status:string;cancelled?:boolean;sourceMissing?:boolean;assignmentUnresolved?:boolean;mailIntakeReviewRequired?:boolean;pendingSourceWrite?:boolean;adminEditSheetWrite?:{pending?:boolean};revision?:number;assignedStaffId?:string;assignedUid?:string;applicationUnconfirmed?:boolean;staffApplicationCheck?:{hash?:string;ngRevision?:string};assignmentSheetWrite?:{queueId?:string};staffReservation?:{schema?:string;state?:string;companyId?:string;staffId?:string;uid?:string;jobId?:string;dateKey?:string;assignedRevision?:number;queueId?:string;applicationCheckHash?:string;ngRevision?:string;sourceRevision?:string;sourceProofHash?:string;confirmedAtMs?:number}};
const HEX=/^[a-f0-9]{64}$/;
export function staffReservationConfirmed(job:ReservationJob):boolean{
 const r=job.staffReservation;
 return job.status==='assigned'&&job.cancelled!==true&&job.sourceMissing!==true&&job.assignmentUnresolved!==true&&job.mailIntakeReviewRequired!==true&&job.pendingSourceWrite!==true&&job.adminEditSheetWrite?.pending!==true&&r?.schema==='LK_STAFF_RESERVATION_V1'&&r.state==='CONFIRMED'&&typeof job.id==='string'&&r.jobId===job.id&&typeof job.companyId==='string'&&r.companyId===job.companyId&&typeof job.assignedStaffId==='string'&&r.staffId===job.assignedStaffId&&typeof job.assignedUid==='string'&&r.uid===job.assignedUid&&r.dateKey===job.dateKey&&Number.isSafeInteger(job.revision)&&r.assignedRevision===job.revision&&typeof r.queueId==='string'&&r.queueId===job.assignmentSheetWrite?.queueId&&HEX.test(r.applicationCheckHash??'')&&r.applicationCheckHash===job.staffApplicationCheck?.hash&&HEX.test(r.ngRevision??'')&&r.ngRevision===job.staffApplicationCheck?.ngRevision&&HEX.test(r.sourceRevision??'')&&HEX.test(r.sourceProofHash??'')&&Number.isSafeInteger(r.confirmedAtMs)&&Number(r.confirmedAtMs)>0;
}
export function staffShiftVisible(job:ReservationJob):boolean{
 // A past confirmation is preserved in data, but unresolved source/assignment
 // evidence cannot be presented as a current confirmed calendar entry.
 if(job.sourceMissing===true||job.assignmentUnresolved===true||job.mailIntakeReviewRequired===true||job.pendingSourceWrite===true||job.adminEditSheetWrite?.pending===true)return false;
 return job.applicationUnconfirmed!==true||staffReservationConfirmed(job);
}
export function pendingAssignmentReason(job:ReservationJob&{caseListManualPending?:unknown}):string{
 if(job.sourceMissing===true)return '原本または連携の確認が必要です。状態が確認できるまで、勤務予定には表示しません。';
 if(job.assignmentUnresolved===true)return '担当者の照合を確認中です。再応募せず、状態の更新で確認してください。';
 if(job.mailIntakeReviewRequired===true||job.pendingSourceWrite===true||job.adminEditSheetWrite?.pending===true)return '手配内容または原本への反映を確認中です。';
 return job.caseListManualPending?'手入力の手配内容を確認中です。':'応募受付後、勤務枠の確認を待っています。';
}

type StaffJobListItem = ReservationJob & {
  dateKey: string;
  status: string;
  cancelled?: boolean;
  applicationUnconfirmed?: boolean;
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function localDateKey(date = new Date()): string {
  // 国内シフトの業務日は端末のタイムゾーンによらず日本時間で判定する。
  return new Date(date.getTime()+9*60*60*1000).toISOString().slice(0,10);
}

export function hasValidDateKey(job: Pick<StaffJobListItem,"dateKey">): boolean {
  if(typeof job.dateKey!=="string"||!DATE_KEY_PATTERN.test(job.dateKey))return false;
  const [year,month,day]=job.dateKey.split("-").map(Number);
  if(year<1||month<1||month>12||day<1)return false;
  const leapYear=year%4===0&&(year%100!==0||year%400===0);
  const daysInMonth=[31,leapYear?29:28,31,30,31,30,31,31,30,31,30,31];
  return day<=daysInMonth[month-1];
}

export function isUpcomingJob(job: StaffJobListItem, today = localDateKey()): boolean {
  return hasValidDateKey(job) && job.dateKey >= today;
}

export function activeAssignedJobs<T extends StaffJobListItem>(jobs: T[]): T[] {
  return jobs.filter((job) => job.status === "assigned" && job.cancelled !== true);
}

export function orderAssignedJobs<T extends StaffJobListItem>(jobs: T[], today = localDateKey()): T[] {
  return activeAssignedJobs(jobs).sort((left, right) => {
    const leftRank = isUpcomingJob(left, today) ? 0 : hasValidDateKey(left) ? 1 : 2;
    const rightRank = isUpcomingJob(right, today) ? 0 : hasValidDateKey(right) ? 1 : 2;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (leftRank === 0) return left.dateKey.localeCompare(right.dateKey);
    if (leftRank === 1) return right.dateKey.localeCompare(left.dateKey);
    return 0;
  });
}

// Keep pending records in the loaded collection so refresh/recovery can still find
// them. Only confirmed records belong in the shift list and next-shift summary.
export function pendingAssignedJobs<T extends StaffJobListItem>(jobs: T[], today = localDateKey()): T[] {
  return orderAssignedJobs(jobs, today).filter(job => !staffShiftVisible(job));
}

export function nextShiftJob<T extends StaffJobListItem>(jobs: T[], today = localDateKey()): T | null {
  return orderAssignedJobs(jobs, today).find((job) => staffShiftVisible(job) && isUpcomingJob(job, today)) ?? null;
}

export function splitAssignedJobs<T extends StaffJobListItem>(jobs: T[], today = localDateKey()): { upcoming: T[]; past: T[] } {
  const ordered = orderAssignedJobs(jobs, today).filter(staffShiftVisible);
  return {
    upcoming: ordered.filter((job) => isUpcomingJob(job, today)),
    past: ordered.filter((job) => !isUpcomingJob(job, today)),
  };
}

export function availableOpenJobs<T extends StaffJobListItem>(jobs: T[], today = localDateKey()): T[] {
  return jobs
    .filter((job) => job.status === "open" && job.cancelled !== true && isUpcomingJob(job, today))
    .sort((left, right) => left.dateKey.localeCompare(right.dateKey));
}
