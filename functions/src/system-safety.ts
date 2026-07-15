import { HttpsError } from "firebase-functions/v2/https";
import { db } from "./firebase";

export type ProductionOperationalState = {
  enforced: boolean;
  operational: boolean;
  productionEnabled: boolean;
  emergencyLock: boolean;
  generation: number;
  reason: string;
};

export async function getProductionOperationalState(companyId: string): Promise<ProductionOperationalState> {
  if ((process.env.APP_ENVIRONMENT ?? "development") !== "production") {
    return {
      enforced: false,
      operational: true,
      productionEnabled: false,
      emergencyLock: false,
      generation: 0,
      reason: "non_production",
    };
  }
  const control = await db.collection("productionControls").doc(companyId).get();
  const data = control.data() ?? {};
  const productionEnabled = data.productionEnabled === true;
  const emergencyLock = data.emergencyLock === true;
  return {
    enforced: true,
    operational: productionEnabled && !emergencyLock,
    productionEnabled,
    emergencyLock,
    generation: Number(data.generation ?? 0),
    reason: emergencyLock ? "emergency_lock" : productionEnabled ? "enabled" : "release_not_enabled",
  };
}

export async function assertProductionOperational(companyId: string): Promise<void> {
  const state = await getProductionOperationalState(companyId);
  if (!state.operational) {
    throw new HttpsError(
      "failed-precondition",
      state.emergencyLock
        ? "全体停止スイッチが作動中です。アプリから解除できません。"
        : "本番公開承認が未完了のため処理を停止しています。"
    );
  }
}
