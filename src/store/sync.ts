import type { AppDispatch, RootState } from "./index";
import { pullFromServer, seedServerIfEmpty, submitToServer } from "./server";
import { pullSucceeded, syncFailed, syncStarted, syncSucceeded } from "./courtSlice";
import { saveLocal } from "./localStore";
/**
 * 同步一次发件箱。
 * 关键约束：
 * - 只把字段级修改（带 baseRev）提交给在线版本，绝不整表覆盖；
 * - 失败不丢批次，交由调度器按指数退避重试；
 * - 成功但存在冲突时，冲突项保留两个版本并进入重新确认。
 */
export async function flushOutbox(dispatch: AppDispatch, getState: () => RootState): Promise<boolean> {
  const { court } = getState();
  const pending = court.outbox.filter((op) => op.status === "pending");
  if (pending.length === 0) return true;

  dispatch(syncStarted());
  try {
    const result = await submitToServer(
      pending.map((op) => ({
        evidenceId: op.evidenceId,
        field: op.field,
        value: op.value,
        baseRev: op.baseRev,
        clientAt: op.clientAt
      }))
    );
    dispatch(syncSucceeded(result));
    return result.conflicts.length === 0;
  } catch (error) {
    dispatch(syncFailed(error instanceof Error ? error.message : "同步失败"));
    return false;
  }
}

/** 轮询在线版本：只做按时间并入，本地待发项不被覆盖 */
export async function pullOnce(dispatch: AppDispatch): Promise<void> {
  try {
    const server = await pullFromServer();
    dispatch(pullSucceeded(server));
  } catch {
    // 拉取失败不影响本地批次，下个周期再试
  }
}

/** 首次引导：把证据登记到服务端（不带字段版本，旧数据不补号） */
export function bootstrapServer(evidence: { id: string }[]) {
  seedServerIfEmpty(evidence);
}

const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;

export function retryDelay(attempts: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

export interface SyncControllers {
  destroy: () => void;
}

/**
 * 同步调度器：
 * - 在线且发件箱有待发修改 -> 立即同步（新改动随时唤起，不依赖首次循环）；
 * - 失败后按 1s、2s、4s…（上限 30s）指数退避重试，期间批次始终留在本地；
 * - 无待发修改时周期拉取对端在线版本。
 */
export function startSyncEngine(store: {
  dispatch: AppDispatch;
  getState: () => RootState;
  subscribe: (listener: () => void) => () => void;
}): SyncControllers {
  const { dispatch, getState } = store;
  let cancelled = false;
  let running = false;
  let pullTimer: number | undefined;

  function wait(ms: number): Promise<void> {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function flushLoop() {
    if (running) return;
    running = true;
    try {
      while (!cancelled) {
        const { court } = getState();
        if (!court.sync.online) {
          await wait(1000);
          continue;
        }
        const pending = court.outbox.filter((op) => op.status === "pending");
        if (pending.length === 0) break;
        const ok = await flushOutbox(dispatch, getState);
        if (cancelled) return;
        if (!ok) {
          const attempts = Math.max(1, ...getState().court.outbox.map((op) => op.attempts));
          await wait(retryDelay(attempts));
        }
      }
    } finally {
      running = false;
    }
  }

  // 订阅切片：恢复在线或产生新本地批次时立刻唤起一轮
  let signature = "";
  const unsubscribe = store.subscribe(() => {
    if (cancelled || running) return;
    const { court } = getState();
    const next = `${court.sync.online ? 1 : 0}:${court.outbox
      .filter((op) => op.status === "pending")
      .map((op) => `${op.id}:${op.attempts}`)
      .join(",")}`;
    if (next === signature) return;
    signature = next;
    if (court.sync.online && court.outbox.some((op) => op.status === "pending")) {
      void flushLoop();
    }
  });
  void flushLoop();

  pullTimer = window.setInterval(() => {
    if (cancelled) return;
    const { court } = getState();
    if (court.sync.online) void pullOnce(dispatch);
  }, 10_000);

  return {
    destroy() {
      cancelled = true;
      unsubscribe();
      if (pullTimer !== undefined) window.clearInterval(pullTimer);
    }
  };
}

/**
 * 订阅需要本地留存的切片：断网修改、冲突、合并后的证据，刷新也不丢。
 * 写盘按 500ms 节流（计时器每秒 dispatch，无需每次都落盘），
 * 页面关闭/隐藏时立即补写一次，保证断电不丢。
 */
export function startPersistence(store: {
  getState: () => RootState;
  subscribe: (listener: () => void) => () => void;
}): () => void {
  let timer: number | undefined;
  let flush = () => {};

  const schedule = () => {
    if (timer !== undefined) return;
    timer = window.setTimeout(() => {
      timer = undefined;
      flush();
    }, 500);
  };

  const unsubscribe = store.subscribe(schedule);

  flush = () => {
    const { court } = store.getState();
    saveLocal({
      evidence: court.evidence,
      outbox: court.outbox,
      conflicts: court.conflicts,
      lastSyncAt: court.sync.lastSyncAt,
      syncError: court.sync.syncError
    });
  };

  const flushNow = () => {
    if (timer !== undefined) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    flush();
  };
  window.addEventListener("beforeunload", flushNow);
  document.addEventListener("visibilitychange", flushNow);

  flush();
  return () => {
    unsubscribe();
    flushNow();
    window.removeEventListener("beforeunload", flushNow);
    document.removeEventListener("visibilitychange", flushNow);
    if (timer !== undefined) window.clearTimeout(timer);
  };
}
