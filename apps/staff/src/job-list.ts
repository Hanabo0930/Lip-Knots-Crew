type StaffJobListItem = {
  dateKey: string;
  status: string;
  cancelled?: boolean;
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

export function nextShiftJob<T extends StaffJobListItem>(jobs: T[], today = localDateKey()): T | null {
  return orderAssignedJobs(jobs, today).find((job) => isUpcomingJob(job, today)) ?? null;
}

export function splitAssignedJobs<T extends StaffJobListItem>(jobs: T[], today = localDateKey()): { upcoming: T[]; past: T[] } {
  const ordered = orderAssignedJobs(jobs, today);
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
