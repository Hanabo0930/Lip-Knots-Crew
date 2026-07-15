export type PublicationMode = "draft" | "immediate" | "scheduled";

export type AdminJobInput = {
  workDate: string;
  clientName: string;
  storeName: string;
  storeAddress: string;
  storeNearestStation: string;
  makerName: string;
  menuName: string;
  entryTime: string;
  workTime: string;
  subcontractorName: string;
  slots: number;
  basePay: number | null;
  publicationMode: PublicationMode;
  publishAt: string | null;
};

export type EditableJobInputs = {
  clientName?: string;
  storeName?: string;
  storeAddress?: string;
  storeNearestStation?: string;
  makerName?: string;
  menuName?: string;
  entryTime?: string;
  workTime?: string;
  subcontractorName?: string;
  assignedStaffId?: string | null;
  clientChargeInputs?: Record<string, number | null>;
  staffPaymentInputs?: Record<string, number | null>;
};

export const clientInputKeys = [
  "invoiceBase",
  "invoiceBusinessAllowance",
  "invoiceRemoteAllowance",
  "invoiceUrgentAllowance",
  "invoiceOutsideAllowance",
  "invoiceBusyAllowance",
  "invoiceMedicalCheck",
  "invoiceOther",
] as const;

export const staffInputKeys = [
  "staffBasePay",
  "staffBusinessAllowance",
  "staffRemoteAllowance",
  "staffUrgentAllowance",
  "staffOutsideAllowance",
  "staffBusyAllowance",
  "staffMedicalCheck",
  "staffOther",
] as const;

export function normalizeJobInput(
  raw: Partial<AdminJobInput>
): { value: AdminJobInput; errors: string[] } {
  const errors: string[] = [];
  const workDate = normalizeText(raw.workDate);
  const clientName = normalizeText(raw.clientName);
  const storeName = normalizeText(raw.storeName);
  const storeAddress = normalizeText(raw.storeAddress);
  const storeNearestStation = normalizeText(raw.storeNearestStation);
  const makerName = normalizeText(raw.makerName);
  const menuName = normalizeText(raw.menuName);
  const entryTime = normalizeText(raw.entryTime);
  const workTime = normalizeText(raw.workTime);
  const subcontractorName = normalizeText(raw.subcontractorName);
  const slots = Number(raw.slots ?? 1);
  const publicationMode = raw.publicationMode ?? "draft";
  const publishAt = raw.publishAt ? String(raw.publishAt) : null;
  const basePay = raw.basePay === null || raw.basePay === undefined
    ? null
    : Number(raw.basePay);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) errors.push("実施日が正しくありません。");
  if (!clientName) errors.push("クライアント名は必須です。");
  if (!storeName) errors.push("店舗名は必須です。");
  if (storeAddress.length > 300) errors.push("店舗住所は300文字以内で入力してください。");
  if (storeNearestStation.length > 120) errors.push("最寄駅は120文字以内で入力してください。");
  if (!makerName) errors.push("メーカー名は必須です。");
  if (!menuName) errors.push("メニュー名は必須です。");
  if (!workTime) errors.push("実施時間は必須です。");
  if (!Number.isInteger(slots) || slots < 1 || slots > 20) {
    errors.push("募集人数は1～20名で入力してください。");
  }
  if (basePay !== null && (!Number.isFinite(basePay) || basePay < 0 || basePay > 1_000_000)) {
    errors.push("基本単価が正しくありません。");
  }
  if (!["draft", "immediate", "scheduled"].includes(publicationMode)) {
    errors.push("公開方法が正しくありません。");
  }
  if (publicationMode === "scheduled") {
    if (!publishAt || Number.isNaN(Date.parse(publishAt))) {
      errors.push("公開予約日時を入力してください。");
    }
  }

  return {
    value: {
      workDate, clientName, storeName, storeAddress, storeNearestStation, makerName, menuName,
      entryTime, workTime, subcontractorName,
      slots: Number.isInteger(slots) ? slots : 1,
      basePay,
      publicationMode,
      publishAt,
    },
    errors,
  };
}

export function resolvePublication(input: {
  requestedMode: PublicationMode;
  publishAt: string | null;
  sourceReady: boolean;
  nowIso: string;
}): {
  status: "draft" | "open" | "scheduled";
  publishable: boolean;
  recruitmentStopped: boolean;
  scheduledPublishAt: string | null;
  blockedReason: string | null;
} {
  if (input.requestedMode === "draft") {
    return {
      status: "draft",
      publishable: false,
      recruitmentStopped: true,
      scheduledPublishAt: null,
      blockedReason: null,
    };
  }

  if (!input.sourceReady) {
    return {
      status: "draft",
      publishable: false,
      recruitmentStopped: true,
      scheduledPublishAt:
        input.requestedMode === "scheduled" ? input.publishAt : null,
      blockedReason: "sheet_source_not_ready",
    };
  }

  if (input.requestedMode === "scheduled") {
    const due = Boolean(input.publishAt) &&
      Date.parse(String(input.publishAt)) <= Date.parse(input.nowIso);
    if (!due) {
      return {
        status: "scheduled",
        publishable: false,
        recruitmentStopped: true,
        scheduledPublishAt: input.publishAt,
        blockedReason: null,
      };
    }
  }

  return {
    status: "open",
    publishable: true,
    recruitmentStopped: false,
    scheduledPublishAt: null,
    blockedReason: null,
  };
}

export function normalizeMoneyRecord(
  raw: Record<string, unknown> | undefined,
  allowedKeys: readonly string[]
): { values: Record<string, number | null>; errors: string[] } {
  const values: Record<string, number | null> = {};
  const errors: string[] = [];
  if (!raw) return { values, errors };

  for (const [key, rawValue] of Object.entries(raw)) {
    if (!allowedKeys.includes(key)) {
      errors.push(`編集できない金額項目です: ${key}`);
      continue;
    }
    if (rawValue === "" || rawValue === null || rawValue === undefined) {
      values[key] = null;
      continue;
    }
    const normalized = String(rawValue)
      .normalize("NFKC")
      .replace(/[￥¥円,\s　]/g, "")
      .replace(/[▲△]/g, "-");
    const parsed = Number(normalized);
    if (!Number.isFinite(parsed) || parsed < -1_000_000 || parsed > 10_000_000) {
      errors.push(`${key}の金額が正しくありません。`);
      continue;
    }
    values[key] = parsed;
  }
  return { values, errors };
}

export function csvCell(value: unknown): string {
  const text = String(value ?? "").replace(/\r?\n/g, " ");
  return `"${text.replace(/"/g, '""')}"`;
}

export function buildJobCsv(rows: Array<Record<string, unknown>>): string {
  const headers = [
    "実施日", "クライアント", "店舗", "メーカー", "メニュー",
    "実施時間", "スタッフ", "状態", "請求概算", "支払概算", "粗利概算",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push([
      row.workDate ?? row.dateKey ?? "",
      row.clientName ?? "",
      row.storeName ?? "",
      row.makerName ?? "",
      row.menuName ?? "",
      row.workTime ?? "",
      row.assignedStaffName ?? "",
      row.status ?? "",
      row.invoice ?? 0,
      row.payment ?? 0,
      row.grossProfit ?? 0,
    ].map(csvCell).join(","));
  }
  return "\uFEFF" + lines.join("\r\n");
}

function normalizeText(value: unknown): string {
  return String(value ?? "").normalize("NFKC").trim();
}
