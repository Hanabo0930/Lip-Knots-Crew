import { useRef, useState } from "react";

const statusLabels = {
  readback_required: "反映結果の確認待ち",
  verified_pending: "月別表の反映を確認済み・管理記録の確定待ち",
  completed: "反映・管理記録確定済み",
  rejected: "この操作では書込みなし",
} as const;
const operationIdFormat = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

export type ExpenseOperation = { operationId: string; status: keyof typeof statusLabels };

export function parseExpenseOperation(value: unknown, jobId: string, requestedId?: string): ExpenseOperation | null {
  const response = value as { jobId?: unknown; confirmationOperation?: unknown } | null;
  if (response?.jobId === jobId) {
    if (response.confirmationOperation === null && !requestedId) return null;
    const operation = response.confirmationOperation as Partial<ExpenseOperation> | undefined;
    if (typeof operation?.operationId === "string" && operationIdFormat.test(operation.operationId) &&
        (!requestedId || requestedId === operation.operationId) && typeof operation.status === "string" &&
        Object.hasOwn(statusLabels, operation.status)) {
      return { operationId: operation.operationId, status: operation.status };
    }
  }
  throw new Error("照会結果を確認できません。案件と操作IDを確認してください。");
}

export default function AdminExpenseOperation({ lookup }: {
  lookup: (operationId?: string) => Promise<ExpenseOperation | null>;
}) {
  const [input, setInput] = useState("");
  const [operation, setOperation] = useState<ExpenseOperation | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  const inFlight = useRef(false);

  async function showStatus() {
    if (inFlight.current) return;
    const operationId = input.trim().toLowerCase();
    setOperation(null);
    if (operationId && !operationIdFormat.test(operationId)) {
      setMessage("操作IDの形式を確認してください。");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setMessage("照会中");
    try {
      const result = await lookup(operationId || undefined);
      setOperation(result);
      setMessage(result ? "" : "この案件に経費確定の操作記録はありません。");
    } catch {
      setMessage("照会できませんでした。案件と操作IDを確認してください。");
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <div className="sync-actions">
      <label>経費の操作ID
        <input value={input} onChange={event => { setInput(event.target.value); setOperation(null); setMessage(""); }}
          disabled={busy} placeholder="空欄なら最新の操作" autoComplete="off" />
      </label>
      <button className="ghost" type="button" onClick={() => void showStatus()} disabled={busy}>経費の反映状況を照会</button>
      {message && <p role="status">{message}</p>}
      {operation && <p role="status" style={{ overflowWrap: "anywhere" }}>
        {statusLabels[operation.status]}<br />操作ID <code>{operation.operationId}</code>
      </p>}
    </div>
  );
}
