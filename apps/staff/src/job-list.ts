type StaffJobListItem = {
  dateKey: string;
  status: string;
  cancelled?: boolean;
};

const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

export function localDateKey(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function hasValidDateKey(job: StaffJobListItem): boolean {
  return DATE_KEY_PATTERN.test(job.dateKey);
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
