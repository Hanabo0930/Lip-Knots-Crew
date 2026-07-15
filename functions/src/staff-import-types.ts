export type StaffColumnConfig = {
  displayName: string;
  homePrefecture?: string;
  nearestStation?: string;
  birthDate?: string;
  email: string;
  phone?: string;
  manualInactive?: string;
  rank?: string;
  evaluationTags?: string;
  evaluationMemo?: string;
};

export type StaffImportConfig = {
  companyId: string;
  enabled: boolean;
  scheduleEnabled: boolean;
  spreadsheetId: string;
  spreadsheetLabel?: string;
  activeSheets: string[];
  excludedSheets: string[];
  sheetAreas: Record<string, string>;
  headerRow?: number | null;
  dataStartRow?: number | null;
  maxRowsPerSheet: number;
  readRangeEndColumn: string;
  maxSheetsPerRun: number;
  markMissingInactive: boolean;
  revokeRemovedEmailSessions: boolean;
  configVersion: string;
  columns: StaffColumnConfig;
};

export type ParsedStaffRow = {
  companyId: string;
  staffId: string;
  displayName: string;
  normalizedName: string;
  emails: string[];
  invalidEmails: string[];
  phone: string;
  homePrefecture: string;
  nearestStation: string;
  birthDateRaw: string;
  areaLabel: string;
  manualInactive: boolean;
  rank: string;
  evaluationTags: string[];
  evaluationMemo: string;
  sourceRef: {
    spreadsheetId: string;
    sheetName: string;
    row: number;
    headerRow: number;
  };
  warnings: string[];
};

export type MergedStaffProfile = {
  companyId: string;
  staffId: string;
  displayName: string;
  normalizedName: string;
  emails: string[];
  invalidEmails: string[];
  primaryEmail: string;
  phone: string;
  homePrefecture: string;
  nearestStation: string;
  birthDateRaw: string;
  areaLabels: string[];
  active: boolean;
  rank: string;
  evaluationTags: string[];
  evaluationMemo: string;
  sourceRefs: ParsedStaffRow["sourceRef"][];
  conflictWarnings: string[];
};

export type StaffSheetSummary = {
  sheetName: string;
  headerRow: number;
  dataStartRow: number;
  rowsRead: number;
  staffRows: number;
  invalidEmailCount: number;
  warnings: string[];
};

export type StaffParseResult = {
  rows: ParsedStaffRow[];
  summary: StaffSheetSummary;
};
