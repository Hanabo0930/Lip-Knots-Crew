export type ShiftColumnConfig = {
  workDate: string;
  staffName: string;
  temperature?: string;
  arrivalTime?: string;
  clientName: string;
  storeName: string;
  makerName: string;
  menuName: string;
  entryTime?: string;
  workTime: string;
  subcontractorName?: string;
  materialStatus?: string;
  basePayColumns?: string[];
  clientChargeTotal?: string;
  clientChargeAdditionColumns?: string[];
  staffPaymentTotal?: string;
  subcontractorTotal?: string;
  transportation?: string;
  purchase8?: string;
  purchase10?: string;
  netPrintCost?: string;
  postageCost?: string;
  recruitmentStopped?: string;
  cancelled?: string;
  cancellationReason?: string;
  caseId?: string;
};

export type ShiftImportConfig = {
  companyId: string;
  enabled: boolean;
  spreadsheetId: string;
  spreadsheetLabel?: string;
  monthlySheetPattern: string;
  importFrom?: string | null;
  importThrough?: string | null;
  includeSheets?: string[];
  excludeSheets?: string[];
  headerRow?: number | null;
  dataStartRow?: number | null;
  maxRowsPerSheet: number;
  readRangeEndColumn: string;
  maxSheetsPerRun: number;
  scheduleEnabled: boolean;
  markMissingAsArchived: boolean;
  columns: ShiftColumnConfig;
  configVersion: string;
};

export type SheetDescriptor = {
  sheetId: number;
  title: string;
  hidden: boolean;
  rowCount: number;
  columnCount: number;
};

export type ParsedShiftJob = {
  jobId: string;
  caseId: string;
  companyId: string;
  sourceIdentityKey: string;
  identityFingerprint: string;
  sourceOccurrence: number;
  workDate: string;
  dateKey: string;
  clientName: string;
  rawClientName: string;
  storeName: string;
  makerName: string;
  menuName: string;
  menuConditions: string[];
  entryTime: string;
  workTime: string;
  subcontractorName: string;
  assignedStaffName: string;
  rawStaffName: string;
  status: "open" | "assigned" | "stopped" | "cancelled" | "draft";
  publishable: boolean;
  recruitmentStopped: boolean;
  cancelled: boolean;
  cancellationReason: string;
  basePay: number | null;
  financials: {
    clientChargeTotal: number | null;
    clientChargeAdditionsTotal: number | null;
    staffPaymentTotal: number | null;
    subcontractorTotal: number | null;
  };
  expenses: {
    transportation: number | null;
    purchase8: number | null;
    purchase10: number | null;
    netPrintCost: number | null;
    postageCost: number | null;
  };
  preContact: {
    temperature: string;
    arrivalTime: string;
  } | null;
  sheetRef: {
    spreadsheetId: string;
    sheetId: number | null;
    sheetName: string;
    currentRow: number;
    headerRow: number;
  };
  importWarnings: string[];
};

export type SheetParseSummary = {
  sheetName: string;
  headerRow: number;
  dataStartRow: number;
  rowsRead: number;
  jobsFound: number;
  skippedRows: number;
  counts: {
    open: number;
    assigned: number;
    stopped: number;
    cancelled: number;
    draft: number;
  };
  warnings: string[];
};

export type SheetParseResult = {
  jobs: ParsedShiftJob[];
  summary: SheetParseSummary;
};
