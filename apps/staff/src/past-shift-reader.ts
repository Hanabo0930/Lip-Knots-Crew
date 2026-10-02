import {
  collection, getDocsFromServer, limit, orderBy, query, startAfter, where,
  type Firestore, type QueryDocumentSnapshot,
} from "firebase/firestore";
import { PAST_SHIFT_PAGE_SIZE, type PastShiftReader, type PastShiftRecord } from "./past-shift-history";

export function firestorePastShiftReader<T extends PastShiftRecord>(database: Firestore): PastShiftReader<T, QueryDocumentSnapshot> {
  return {
    async oldest(scope) {
      const result = await getDocsFromServer(query(collection(database, "jobs"),
        where("companyId", "==", scope.companyId), where("assignedStaffId", "==", scope.staffId),
        where("dateKey", "<", scope.today), orderBy("dateKey", "asc"), limit(1)));
      const first = result.docs[0];
      return first ? { ...first.data(), id: first.id } as T : null;
    },
    async page(range, cursor) {
      const result = await getDocsFromServer(query(collection(database, "jobs"),
        where("companyId", "==", range.companyId), where("assignedStaffId", "==", range.staffId),
        where("dateKey", ">=", range.start), where("dateKey", "<", range.end),
        orderBy("dateKey", "asc"), ...(cursor ? [startAfter(cursor)] : []), limit(PAST_SHIFT_PAGE_SIZE + 1)));
      return result.docs.map(doc => ({ row: { ...doc.data(), id: doc.id } as T, cursor: doc }));
    },
  };
}
