import { db } from "./firebase";

const storeKey = (value: unknown) => typeof value === "string" ? value.normalize("NFKC").replace(/\s+/g, "").toLowerCase() : "";
// 照合を打ち切った場合も「重複なし」にしない。別メールとの自動統合は行わない。
export async function hasCaseMailCollision(tx: FirebaseFirestore.Transaction, companyId: string,
  receiptId: string, workDate: string, storeName: string, includeReview = true): Promise<boolean> {
  const [jobs, candidates] = await Promise.all([
    tx.get(db.collection("jobs").where("companyId", "==", companyId).where("workDate", "==", workDate).limit(201)),
    tx.get(db.collection("caseMailIntakeCandidates").where("companyId", "==", companyId).where("workDate", "==", workDate).limit(201)),
  ]);
  if (jobs.docs.length > 200 || candidates.docs.length > 200) return true;
  return jobs.docs.some(snap => {
    const job = snap.data();
    return job.mailIntake?.receiptId !== receiptId && storeKey(job.storeName) === storeKey(storeName);
  }) || candidates.docs.some(snap => {
    const candidate = snap.data();
    return candidate.receiptId !== receiptId && (includeReview || candidate.status !== "review") &&
      storeKey(candidate.input?.storeName) === storeKey(storeName);
  });
}

// 対応先候補の読取専用。日付ごとに再利用し、最大5日・各201件に制限する。
export function caseMailTargetReader(tx: FirebaseFirestore.Transaction, companyId: string, receiptId: string) {
  const days = new Map<string, FirebaseFirestore.QuerySnapshot>();
  return async (workDate: string, storeName: string) => {
    const date = new Date(workDate + "T00:00:00Z");
    const items: {jobId:string;workDate:string;storeName:string;clientName:string;makerName:string;menuName:string;entryTime:string;workTime:string;cancelled:boolean}[] = [];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate) || workDate < "2026-10-01" || !Number.isFinite(date.valueOf()) || date.toISOString().slice(0,10) !== workDate || !storeKey(storeName)) return {state:"insufficient" as const,items};
    if (!days.has(workDate)) {
      if (days.size >= 5) return {state:"limited" as const,items};
      days.set(workDate, await tx.get(db.collection("jobs").where("companyId","==",companyId).where("workDate","==",workDate).limit(201)));
    }
    const page = days.get(workDate)!;
    let limited = page.docs.length > 200;
    for (const snap of page.docs.slice(0,200)) {
      const job = snap.data();
      if (job.companyId !== companyId || job.workDate !== workDate || job.mailIntake?.receiptId === receiptId || storeKey(job.storeName) !== storeKey(storeName)) continue;
      if (items.length >= 10 || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/.test(snap.id)) { limited = true; continue; }
      const value = (key:string) => typeof job[key] === "string" ? job[key].slice(0,500) : "";
      items.push({jobId:snap.id,workDate,storeName:value("storeName"),clientName:value("clientName"),makerName:value("makerName"),menuName:value("menuName"),entryTime:value("entryTime"),workTime:value("workTime"),cancelled:job.cancelled === true || job.status === "cancelled"});
    }
    return {state:limited ? "limited" as const : "complete" as const,items};
  };
}
