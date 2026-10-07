import type { AppState } from "./state-types";

const STATE_KEY = "pair-wise-yf-49/court-state";

/**
 * 加载持久化的本地庭审状态。
 * 暂存队列和冲突记录在页面刷新后不丢失。
 * 在线状态和同步状态不持久化——每次加载重新检测。
 */
export function loadCourtState(): AppState | undefined {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return undefined;
    const parsed = JSON.parse(raw) as Partial<AppState>;
    if (!parsed.court) return undefined;
    return {
      ...parsed,
      court: {
        ...parsed.court,
        online: typeof navigator !== "undefined" ? navigator.onLine : true,
        syncStatus: "idle",
        initialized: false
      }
    } as AppState;
  } catch {
    return undefined;
  }
}

/** 保存本地庭审状态（含暂存队列和冲突记录） */
export function saveCourtState(state: AppState) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {
    // 存储失败不影响使用
  }
}
