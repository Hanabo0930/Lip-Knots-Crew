import { useEffect, useState } from "react";
import { doc, onSnapshot } from "firebase/firestore";
import { db } from "./firebase";
import { staffShiftVisible, type ReservationJob } from "./job-list";

type LocationFields = { storeName?: unknown; storeAddress?: unknown; storeNearestStation?: unknown };
type RouteJob = ReservationJob & LocationFields;
export type RouteScope = { jobId: string; companyId: string; staffId: string };
export type ShiftRouteSnapshot = {
  job: RouteJob | null;
  fromCache: boolean;
  hasPendingWrites: boolean;
};
export type WatchShiftRoute = (id: string, receive: (snapshot: ShiftRouteSnapshot) => void, fail: () => void) => () => void;
type RouteState = { state: "checking" | "unavailable" } | { state: "confirmed"; location: LocationFields };
type Connectivity = {
  online: () => boolean;
  listen: (changed: () => void) => () => void;
};

export function observeShiftRoute(
  scope: RouteScope,
  watch: WatchShiftRoute,
  connectivity: Connectivity,
  show: (state: RouteState) => void,
): () => void {
  let generation = 0;
  let close = () => {};
  let available: boolean | undefined;
  let stopped = false;
  function subscribe() {
    if (stopped) return;
    const next = connectivity.online();
    if (next === available) return;
    available = next;
    const version = ++generation;
    close();
    close = () => {};
    if (!next) {
      show({ state: "unavailable" });
      return;
    }
    show({ state: "checking" });
    try {
      close = watch(scope.jobId, ({ job, fromCache, hasPendingWrites }) => {
        if (version !== generation) return;
        if (fromCache || hasPendingWrites || !job || job.id !== scope.jobId ||
            job.companyId !== scope.companyId || job.assignedStaffId !== scope.staffId ||
            job.status !== "assigned" || job.cancelled === true || !staffShiftVisible(job) ||
            !connectivity.online()) {
          show({ state: "unavailable" });
          return;
        }
        const { storeName, storeAddress, storeNearestStation } = job;
        show({ state: "confirmed", location: { storeName, storeAddress, storeNearestStation } });
      }, () => {
        if (version === generation) show({ state: "unavailable" });
      });
    } catch {
      if (version === generation) show({ state: "unavailable" });
    }
  }
  const stopListening = connectivity.listen(subscribe);
  subscribe();
  return () => {
    if (stopped) return;
    stopped = true;
    generation++;
    stopListening();
    close();
  };
}

export function browserShiftRouteConnectivity(): Connectivity {
  let pageHidden = false;
  return {
    online: () => !pageHidden && document.visibilityState === "visible" && navigator.onLine !== false,
    listen(changed) {
      const hide = () => { pageHidden = true; changed(); };
      const show = () => { pageHidden = false; changed(); };
      document.addEventListener("visibilitychange", changed);
      window.addEventListener("pagehide", hide);
      window.addEventListener("pageshow", show);
      window.addEventListener("online", changed);
      window.addEventListener("offline", changed);
      return () => {
        document.removeEventListener("visibilitychange", changed);
        window.removeEventListener("pagehide", hide);
        window.removeEventListener("pageshow", show);
        window.removeEventListener("online", changed);
        window.removeEventListener("offline", changed);
      };
    },
  };
}

export const watchShiftRoute: WatchShiftRoute = (id, receive, fail) => {
  if (!db) throw new Error("シフト表への接続を確認できません。");
  return onSnapshot(doc(db, "jobs", id), { includeMetadataChanges: true }, snapshot => {
    receive({
      job: snapshot.exists() ? { ...snapshot.data(), id: snapshot.id } as RouteJob : null,
      fromCache: snapshot.metadata.fromCache,
      hasPendingWrites: snapshot.metadata.hasPendingWrites,
    });
  }, fail);
};

function locationText(value: unknown): string {
  if (typeof value !== "string") return "";
  const text = value.replace(/\s+/gu, " ").trim();
  return /^(?:未入力|未定|確認中|未確認|不明|なし|詳細は別途|[-－―ー…]+|n\/?a)$/iu.test(text) ? "" : text;
}

function mapLinks({ storeName, storeAddress }: LocationFields) {
  const name = locationText(storeName);
  const address = locationText(storeAddress);
  if (!address || address === name || /^(?:https?:\/\/|www\.)/iu.test(address)) return null;
  const destination = [name, address].filter(Boolean).join(" ");
  const search = new URLSearchParams({ api: "1", query: destination });
  const directions = new URLSearchParams({ api: "1", destination, travelmode: "transit" });
  return { name, address, map: `https://www.google.com/maps/search/?${search}`, transit: `https://www.google.com/maps/dir/?${directions}` };
}

export function ShiftRouteDetails({
  current, copyAddress, copying,
}: {
  current: RouteState;
  copyAddress: (address: string) => void;
  copying: boolean;
}) {
  const location = current.state === "confirmed" ? current.location : null;
  const links = location ? mapLinks(location) : null;
  const station = locationText(location?.storeNearestStation);
  return (
    <div className="route-panel">
      <strong>店舗への行き方</strong>
      {current.state === "checking" && <p role="status">最新の店舗住所を確認しています。</p>}
      {current.state === "unavailable" && <p role="status">最新の店舗住所を確認できません。通信状態と担当シフトを確認してください。</p>}
      {location && !links && <p role="status">店舗住所が未確認です。管理者に店舗住所を確認してください。</p>}
      {links && (
        <>
          <p>{links.name && <>{links.name}<br /></>}{links.address}</p>
          <div className="route-actions">
            <button className="secondary" onClick={() => copyAddress(links.address)} disabled={copying}>住所をコピー</button>
            <a href={links.map} target="_blank" rel="noopener noreferrer">地図で店舗を見る</a>
            <a href={links.transit} target="_blank" rel="noopener noreferrer">公共交通の経路</a>
          </div>
        </>
      )}
      {station && <p>最寄駅 {station}</p>}
    </div>
  );
}

export default function ShiftRoutePanel({
  scope, demo, copyAddress, copying,
}: {
  scope: RouteScope;
  demo?: LocationFields;
  copyAddress: (address: string) => void;
  copying: boolean;
}) {
  const [current, setCurrent] = useState<RouteState>({ state: "checking" });
  const { jobId, companyId, staffId } = scope;
  useEffect(() => {
    if (demo) return;
    if (!jobId || jobId.includes("/") || !companyId || !staffId) {
      setCurrent({ state: "unavailable" });
      return;
    }
    return observeShiftRoute({ jobId, companyId, staffId }, watchShiftRoute, browserShiftRouteConnectivity(), setCurrent);
  }, [jobId, companyId, staffId, demo]);
  return <ShiftRouteDetails current={demo ? { state: "confirmed", location: demo } : current} copyAddress={copyAddress} copying={copying} />;
}
