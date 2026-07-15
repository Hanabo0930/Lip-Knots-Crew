export type CancellationReasonCategory =
  | "maker"
  | "client"
  | "already_staffed"
  | "store"
  | "weather"
  | "other";

export type CancellationFinancialTreatment =
  | "invoice_and_pay"
  | "invoice_only"
  | "pay_only"
  | "neither";

export type AnalyticsJob = {
  id?: string;
  dateKey?: string;
  workDate?: string;
  status?: string;
  cancelled?: boolean;
  cancellationReason?: string;
  cancellationReasonCategory?: CancellationReasonCategory | string;
  cancellationFinancialTreatment?: CancellationFinancialTreatment | string;
  rawStaffName?: string;
  rawClientName?: string;
  clientName?: string;
  storeName?: string;
  makerName?: string;
  menuName?: string;
  assignedStaffId?: string;
  assignedStaffName?: string;
  subcontractorName?: string;
  financials?: {
    clientChargeTotal?: number | null;
    clientChargeAdditionsTotal?: number | null;
    staffPaymentTotal?: number | null;
    subcontractorTotal?: number | null;
  };
  preContactLate?: boolean;
  submissionStatus?: {
    report?: { lateFirstSubmission?: boolean };
    salesFloor?: { lateFirstSubmission?: boolean };
  };
};

export type JobFinance = {
  invoice: number;
  payment: number;
  grossProfit: number;
  grossMargin: number | null;
  treatment: CancellationFinancialTreatment;
};

export type NamedCount = { name: string; count: number };

export type MonthlyDashboard = {
  month: string;
  asOfDate: string;
  counts: {
    totalRequests: number;
    effectiveJobs: number;
    implemented: number;
    scheduled: number;
    cancelled: number;
    open: number;
    assigned: number;
    stopped: number;
    draft: number;
    executionRate: number | null;
    cancellationRate: number | null;
  };
  finance: {
    bookedInvoice: number;
    bookedPayment: number;
    bookedGrossProfit: number;
    bookedGrossMargin: number | null;
    implementedInvoice: number;
    implementedPayment: number;
    implementedGrossProfit: number;
  };
  cancellationReasons: NamedCount[];
  cancellationTreatments: NamedCount[];
  clients: Array<NamedCount & {
    invoice: number;
    payment: number;
    grossProfit: number;
    cancelled: number;
  }>;
};

export type StaffPerformance = {
  staffId: string;
  from: string;
  through: string;
  totals: {
    assignedJobs: number;
    implementedJobs: number;
    scheduledJobs: number;
    cancelledJobs: number;
    preContactLate: number;
    reportLate: number;
    salesFloorLate: number;
    invoice: number;
    payment: number;
    grossProfit: number;
  };
  clients: NamedCount[];
  makers: NamedCount[];
  menus: NamedCount[];
  stores: NamedCount[];
  months: NamedCount[];
  recentJobs: Array<{
    id: string;
    dateKey: string;
    clientName: string;
    storeName: string;
    makerName: string;
    menuName: string;
    cancelled: boolean;
  }>;
};

const CANCELLATION_MARKER = /[（(]\s*キャンセル\s*[）)]/u;

export const cancellationReasonLabels: Record<CancellationReasonCategory, string> = {
  maker: "メーカー都合",
  client: "クライアント都合",
  already_staffed: "他社で手配済み",
  store: "店舗都合",
  weather: "天候・災害",
  other: "その他",
};

export const cancellationTreatmentLabels: Record<CancellationFinancialTreatment, string> = {
  invoice_and_pay: "請求あり・支払あり",
  invoice_only: "請求あり・支払なし",
  pay_only: "請求なし・支払あり",
  neither: "請求なし・支払なし",
};

export function inferCancellationTreatment(
  job: AnalyticsJob
): CancellationFinancialTreatment {
  if (isTreatment(job.cancellationFinancialTreatment)) {
    return job.cancellationFinancialTreatment;
  }

  if (CANCELLATION_MARKER.test(String(job.rawStaffName ?? ""))) {
    return "invoice_only";
  }
  if (CANCELLATION_MARKER.test(String(job.rawClientName ?? ""))) {
    return "pay_only";
  }

  const invoice = nonNegative(job.financials?.clientChargeTotal) +
    nonNegative(job.financials?.clientChargeAdditionsTotal);
  const payment = selectedPayment(job);

  if (invoice > 0 && payment > 0) return "invoice_and_pay";
  if (invoice > 0) return "invoice_only";
  if (payment > 0) return "pay_only";
  return "neither";
}

export function computeJobFinance(job: AnalyticsJob): JobFinance {
  const baseInvoice = nonNegative(job.financials?.clientChargeTotal) +
    nonNegative(job.financials?.clientChargeAdditionsTotal);
  const basePayment = selectedPayment(job);
  const treatment = isCancelled(job)
    ? inferCancellationTreatment(job)
    : "invoice_and_pay";

  const invoice = treatment === "pay_only" || treatment === "neither"
    ? 0
    : baseInvoice;
  const payment = treatment === "invoice_only" || treatment === "neither"
    ? 0
    : basePayment;
  const grossProfit = invoice - payment;

  return {
    invoice,
    payment,
    grossProfit,
    grossMargin: invoice > 0 ? grossProfit / invoice : null,
    treatment,
  };
}

export function buildMonthlyDashboard(
  jobs: AnalyticsJob[],
  month: string,
  asOfDate: string
): MonthlyDashboard {
  const selected = jobs.filter((job) => dateKey(job).startsWith(`${month}-`));
  const effective = selected.filter((job) => !isCancelled(job));
  const cancelled = selected.filter(isCancelled);
  const implemented = effective.filter((job) => dateKey(job) <= asOfDate);
  const scheduled = effective.filter((job) => dateKey(job) > asOfDate);
  const elapsedScope = selected.filter((job) => dateKey(job) <= asOfDate);
  const elapsedImplemented = elapsedScope.filter((job) => !isCancelled(job));
  const elapsedCancelled = elapsedScope.filter(isCancelled);

  const bookedFinance = sumFinance(selected);
  const implementedFinance = sumFinance(implemented);
  const clientMap = new Map<string, {
    count: number;
    invoice: number;
    payment: number;
    grossProfit: number;
    cancelled: number;
  }>();

  for (const job of selected) {
    const name = cleanLabel(job.clientName || job.rawClientName || "未設定");
    const current = clientMap.get(name) ?? {
      count: 0,
      invoice: 0,
      payment: 0,
      grossProfit: 0,
      cancelled: 0,
    };
    const finance = computeJobFinance(job);
    current.count++;
    current.invoice += finance.invoice;
    current.payment += finance.payment;
    current.grossProfit += finance.grossProfit;
    if (isCancelled(job)) current.cancelled++;
    clientMap.set(name, current);
  }

  const clients = [...clientMap.entries()]
    .map(([name, value]) => ({ name, ...value }))
    .sort((a, b) => b.invoice - a.invoice || b.count - a.count || a.name.localeCompare(b.name, "ja"));

  const executionDenominator = elapsedImplemented.length + elapsedCancelled.length;

  return {
    month,
    asOfDate,
    counts: {
      totalRequests: selected.length,
      effectiveJobs: effective.length,
      implemented: implemented.length,
      scheduled: scheduled.length,
      cancelled: cancelled.length,
      open: selected.filter((job) => job.status === "open").length,
      assigned: selected.filter((job) => job.status === "assigned").length,
      stopped: selected.filter((job) => job.status === "stopped").length,
      draft: selected.filter((job) => job.status === "draft").length,
      executionRate: executionDenominator > 0
        ? elapsedImplemented.length / executionDenominator
        : null,
      cancellationRate: selected.length > 0
        ? cancelled.length / selected.length
        : null,
    },
    finance: {
      bookedInvoice: bookedFinance.invoice,
      bookedPayment: bookedFinance.payment,
      bookedGrossProfit: bookedFinance.grossProfit,
      bookedGrossMargin: bookedFinance.invoice > 0
        ? bookedFinance.grossProfit / bookedFinance.invoice
        : null,
      implementedInvoice: implementedFinance.invoice,
      implementedPayment: implementedFinance.payment,
      implementedGrossProfit: implementedFinance.grossProfit,
    },
    cancellationReasons: countNames(cancelled.map((job) =>
      reasonLabel(job.cancellationReasonCategory, job.cancellationReason)
    )),
    cancellationTreatments: countNames(cancelled.map((job) =>
      cancellationTreatmentLabels[inferCancellationTreatment(job)]
    )),
    clients,
  };
}

export function buildStaffPerformance(
  jobs: AnalyticsJob[],
  staffId: string,
  from: string,
  through: string,
  asOfDate: string
): StaffPerformance {
  const selected = jobs
    .filter((job) => job.assignedStaffId === staffId)
    .filter((job) => {
      const date = dateKey(job);
      return date >= from && date <= through;
    })
    .sort((a, b) => dateKey(b).localeCompare(dateKey(a)));

  const effective = selected.filter((job) => !isCancelled(job));
  const implemented = effective.filter((job) => dateKey(job) <= asOfDate);
  const scheduled = effective.filter((job) => dateKey(job) > asOfDate);
  const finance = sumFinance(selected);

  return {
    staffId,
    from,
    through,
    totals: {
      assignedJobs: effective.length,
      implementedJobs: implemented.length,
      scheduledJobs: scheduled.length,
      cancelledJobs: selected.filter(isCancelled).length,
      preContactLate: selected.filter((job) => job.preContactLate === true).length,
      reportLate: selected.filter((job) =>
        job.submissionStatus?.report?.lateFirstSubmission === true
      ).length,
      salesFloorLate: selected.filter((job) =>
        job.submissionStatus?.salesFloor?.lateFirstSubmission === true
      ).length,
      invoice: finance.invoice,
      payment: finance.payment,
      grossProfit: finance.grossProfit,
    },
    clients: topCounts(effective.map((job) => job.clientName || job.rawClientName || "未設定")),
    makers: topCounts(effective.map((job) => job.makerName || "未設定")),
    menus: topCounts(effective.map((job) => job.menuName || "未設定")),
    stores: topCounts(effective.map((job) => job.storeName || "未設定")),
    months: topCounts(effective.map((job) => dateKey(job).slice(0, 7)), 24),
    recentJobs: selected.slice(0, 30).map((job) => ({
      id: String(job.id ?? ""),
      dateKey: dateKey(job),
      clientName: cleanLabel(job.clientName || job.rawClientName || ""),
      storeName: job.storeName ?? "",
      makerName: job.makerName ?? "",
      menuName: job.menuName ?? "",
      cancelled: isCancelled(job),
    })),
  };
}

export function topCounts(values: string[], limit = 10): NamedCount[] {
  return countNames(values).slice(0, limit);
}

function countNames(values: string[]): NamedCount[] {
  const counts = new Map<string, number>();
  for (const raw of values) {
    const name = cleanLabel(raw || "未設定") || "未設定";
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "ja"));
}

function sumFinance(jobs: AnalyticsJob[]): {
  invoice: number;
  payment: number;
  grossProfit: number;
} {
  return jobs.reduce((total, job) => {
    const finance = computeJobFinance(job);
    total.invoice += finance.invoice;
    total.payment += finance.payment;
    total.grossProfit += finance.grossProfit;
    return total;
  }, { invoice: 0, payment: 0, grossProfit: 0 });
}

function selectedPayment(job: AnalyticsJob): number {
  const external = String(job.subcontractorName ?? "").trim().length > 0;
  return external
    ? nonNegative(job.financials?.subcontractorTotal)
    : nonNegative(job.financials?.staffPaymentTotal);
}

function isCancelled(job: AnalyticsJob): boolean {
  return job.cancelled === true || job.status === "cancelled";
}

function isTreatment(
  value: unknown
): value is CancellationFinancialTreatment {
  return ["invoice_and_pay", "invoice_only", "pay_only", "neither"].includes(
    String(value)
  );
}

function reasonLabel(category: unknown, fallback: unknown): string {
  const key = String(category ?? "") as CancellationReasonCategory;
  if (key in cancellationReasonLabels) return cancellationReasonLabels[key];
  return cleanLabel(String(fallback ?? "")) || "その他";
}

function cleanLabel(value: string): string {
  return value.replace(CANCELLATION_MARKER, "").trim();
}

function dateKey(job: AnalyticsJob): string {
  const value = String(job.dateKey ?? job.workDate ?? "");
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (iso) return value;
  return value;
}

function nonNegative(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) && number > 0 ? number : 0;
}
