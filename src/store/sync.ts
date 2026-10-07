import { createAsyncThunk } from "@reduxjs/toolkit";
import type { AppDispatch, RootState } from "./index";
import { courtApi } from "./api";
import {
  applyMerge,
  clearPendingChanges,
  markLegacyPending,
  setSyncStatus
} from "./courtSlice";
import type { ConflictRecord, Evidence, LocalChange } from "../types";

function now() { return new Date().toISOString(); }

interface MergeResult {
  evidence: Evidence[];
  conflicts: ConflictRecord[];
  pushed: number;
  pulled: number;
}

/**
 * 合并本地与服务器证据。
 *
 * 规则：
 * 1. 本地无暂存修改 → 服务器更新则取服务器版本（按时间合并）
 * 2. 本地有暂存修改、服务器未变 → 推送本地修改
 * 3. 本地有暂存修改、服务器也变了 → 冲突，保留两个版本待人工确认
 * 4. 服务器有本地没有的项 → 拉取到本地
 * 5. 旧数据（缺 updatedAt）→ 标记待确认，不补号不覆盖
 */
function mergeEvidence(
  local: Evidence[],
  server: Evidence[],
  pendingChanges: LocalChange[]
): MergeResult {
  const serverMap = new Map(server.map((e) => [e.id, e]));
  const localMap = new Map(local.map((e) => [e.id, e]));
  const merged: Evidence[] = [];
  const conflicts: ConflictRecord[] = [];
  const pushedIds = new Set<string>();
  let pulled = 0;

  // 处理本地证据项
  for (const localItem of local) {
    const serverItem = serverMap.get(localItem.id);
    const itemChanges = pendingChanges.filter((c) => c.evidenceId === localItem.id);

    if (itemChanges.length === 0) {
      // 无本地修改：按时间取较新版本
      if (serverItem && serverItem.updatedAt && (!localItem.updatedAt || serverItem.updatedAt > localItem.updatedAt)) {
        merged.push({ ...serverItem });
        pulled++;
      } else {
        merged.push(localItem);
      }
      continue;
    }

    // 有本地修改
    if (serverItem) {
      // 检查服务器是否在本地基线之后也改了
      const oldestBase = itemChanges.reduce(
        (oldest, c) => (c.baseUpdatedAt < oldest ? c.baseUpdatedAt : oldest),
        itemChanges[0].baseUpdatedAt
      );

      if (serverItem.updatedAt && serverItem.updatedAt > oldestBase) {
        // 两边都改了同一项 → 冲突，保留两个版本
        conflicts.push({
          id: crypto.randomUUID(),
          evidenceId: localItem.id,
          localVersion: { ...localItem },
          serverVersion: { ...serverItem },
          detectedAt: now()
        });
        merged.push(localItem); // 工作状态保留本地版本，待人工确认
      } else {
        // 仅本地修改 → 推送
        merged.push(localItem);
        pushedIds.add(localItem.id);
      }
    } else {
      // 服务器无此项 → 推送本地新增
      merged.push(localItem);
      pushedIds.add(localItem.id);
    }
  }

  // 处理服务器有但本地没有的项
  for (const serverItem of server) {
    if (!localMap.has(serverItem.id)) {
      merged.push({ ...serverItem });
      pulled++;
    }
  }

  // 按 order 排序，保证公开屏编号一致
  merged.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  return { evidence: merged, conflicts, pushed: pushedIds.size, pulled };
}

/** 执行一次同步 */
async function performSync(dispatch: AppDispatch, getState: () => RootState) {
  const state = getState().court;

  if (!state.online) {
    return { synced: 0, conflicts: 0, pulled: 0 };
  }

  dispatch(setSyncStatus("syncing"));

  try {
    // 拉取服务器当前状态
    const serverResult = await dispatch(courtApi.endpoints.getEvidence.initiate()).unwrap();

    // 合并
    const result = mergeEvidence(state.evidence, serverResult, state.pendingChanges);

    // 推送合并结果到服务器
    await dispatch(courtApi.endpoints.saveEvidence.initiate(result.evidence)).unwrap();

    // 应用合并结果到本地
    dispatch(applyMerge({ evidence: result.evidence, conflicts: result.conflicts }));

    // 标记旧数据为待确认
    const legacyIds = result.evidence.filter((e) => !e.updatedAt).map((e) => e.id);
    if (legacyIds.length > 0) {
      dispatch(markLegacyPending(legacyIds));
    }

    // 无冲突时清除已同步的暂存修改
    if (result.conflicts.length === 0) {
      dispatch(clearPendingChanges());
    }

    dispatch(setSyncStatus(result.conflicts.length > 0 ? "conflict" : "idle"));

    return { synced: result.pushed, conflicts: result.conflicts.length, pulled: result.pulled };
  } catch (error) {
    dispatch(setSyncStatus("error"));
    throw error;
  }
}

/** 手动同步 */
export const syncWithServer = createAsyncThunk<
  { synced: number; conflicts: number; pulled: number },
  void,
  { state: RootState; dispatch: AppDispatch }
>("court/syncWithServer", async (_, { dispatch, getState }) => {
  return performSync(dispatch, getState);
});

/**
 * 失败后重试：指数退避，不丢失本地暂存修改。
 * 网络恢复后自动重试，直到成功或离线。
 */
export const retrySync = createAsyncThunk<
  { synced: number; conflicts: number; pulled: number },
  void,
  { state: RootState; dispatch: AppDispatch }
>("court/retrySync", async (_, { dispatch, getState }) => {
  const delays = [1000, 2000, 4000, 8000, 16000, 30000];
  let lastError: unknown;

  for (const delay of delays) {
    const state = getState().court;
    if (!state.online) {
      // 离线了，等下次联网再试
      return { synced: 0, conflicts: 0, pulled: 0 };
    }
    try {
      return await performSync(dispatch, getState);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // 最后一次尝试
  try {
    return await performSync(dispatch, getState);
  } catch (error) {
    throw lastError ?? error;
  }
});
