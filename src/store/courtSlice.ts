import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type { ConflictRecord, Evidence, LocalChange, Objection, SessionPhase, SessionState, SyncStatus, TimelineEntry } from "../types";

function now() { return new Date().toISOString(); }

const seedEvidence: Evidence[] = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定", order: 0, updatedAt: now(), version: 1 },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩", order: 1, updatedAt: now(), version: 1 },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45", order: 2, updatedAt: now(), version: 1 }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  online: boolean;
  /** 离线暂存队列：断网时的修改先放这里，联网后合并 */
  pendingChanges: LocalChange[];
  /** 双方修改冲突记录：保留两个版本待人工确认 */
  conflicts: ConflictRecord[];
  /** 同步状态 */
  syncStatus: SyncStatus;
  /** 上次成功同步时间 */
  lastSyncedAt: string | null;
}

const initialState: State = {
  initialized: false,
  evidence: seedEvidence,
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [],
  session: seedSession,
  online: true,
  pendingChanges: [],
  conflicts: [],
  syncStatus: "idle",
  lastSyncedAt: null
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

/** 应用本地修改：立即更新状态、盖时间戳、入暂存队列 */
function applyLocalChange(state: State, evidenceId: string, changes: Partial<Evidence>) {
  const item = state.evidence.find((entry) => entry.id === evidenceId);
  if (!item) return;
  const baseUpdatedAt = item.updatedAt ?? "";
  const ts = now();
  Object.assign(item, changes, { updatedAt: ts });
  state.pendingChanges.push({
    id: crypto.randomUUID(),
    evidenceId,
    changedAt: ts,
    changes,
    baseUpdatedAt
  });
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    initialize(state, action: PayloadAction<Evidence[]>) {
      if (!state.initialized) {
        const data = action.payload.length ? action.payload : seedEvidence;
        const serverMap = new Map(data.map((entry) => [entry.id, entry]));

        // 以本地工作副本为基础（保留暂存修改），合并服务器证据
        const merged = state.evidence.map((local) => {
          const server = serverMap.get(local.id);
          if (server && server.updatedAt && (!local.updatedAt || server.updatedAt > local.updatedAt)) {
            return { ...server, order: server.order ?? local.order };
          }
          return local;
        });

        // 补充服务器有但本地没有的项
        const localIds = new Set(merged.map((entry) => entry.id));
        for (const server of data) {
          if (!localIds.has(server.id)) {
            merged.push({ ...server, order: server.order ?? merged.length });
          }
        }

        // 排序并标记旧数据
        state.evidence = merged
          .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
          .map((item, index) => ({
            ...item,
            order: item.order ?? index,
            pendingReview: item.pendingReview ?? !item.updatedAt
          }));
        state.initialized = true;
      }
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.online = action.payload;
      if (!action.payload) {
        state.syncStatus = "offline";
      }
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      const oldMap = new Map(state.evidence.map((entry) => [entry.id, entry]));
      const ts = now();
      state.evidence = action.payload.map((item, index) => {
        const old = oldMap.get(item.id);
        if (old && old.order !== index) {
          // 顺序确实变了：盖时间戳并入暂存队列
          state.pendingChanges.push({
            id: crypto.randomUUID(),
            evidenceId: item.id,
            changedAt: ts,
            changes: { order: index },
            baseUpdatedAt: old.updatedAt ?? ""
          });
          return { ...item, order: index, updatedAt: ts };
        }
        return { ...item, order: index };
      });
      addEntry(state, "书记员", "调整证据顺序", "已更新举证顺序");
    },
    selectEvidence(state, action: PayloadAction<string>) { const item = state.evidence.find((entry) => entry.id === action.payload); if (!item) return; state.session.currentEvidenceId = item.id; state.session.timerSeconds = item.duration * 60; addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`); },
    showEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "展示中"; state.session.phase = "质证"; addEntry(state, item.presenter, "开始展示", item.title); },
    completeEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "已展示"; const next = state.evidence.find((entry) => entry.status === "待展示"); state.session.currentEvidenceId = next?.id ?? null; state.session.timerSeconds = (next?.duration ?? 0) * 60; state.session.phase = next ? "举证" : "休庭"; addEntry(state, "审判庭", "完成质证", item.title); },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      const baseUpdatedAt = item.updatedAt ?? "";
      const ts = now();
      item.sensitive = !item.sensitive;
      item.updatedAt = ts;
      state.pendingChanges.push({
        id: crypto.randomUUID(),
        evidenceId: item.id,
        changedAt: ts,
        changes: { sensitive: item.sensitive },
        baseUpdatedAt
      });
      addEntry(state, "审判庭", item.sensitive ? "隐藏敏感内容" : "恢复公开内容", item.title);
    },
    updateNote(state, action: PayloadAction<{ id: string; note: string }>) {
      applyLocalChange(state, action.payload.id, { note: action.payload.note });
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) { const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId); state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString() }); state.session.phase = "质证"; addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`); },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) { const objection = state.objections.find((entry) => entry.id === action.payload.id); if (!objection) return; objection.status = action.payload.status; const item = state.evidence.find((entry) => entry.id === objection.evidenceId); if (action.payload.status === "支持" && item) { item.status = "已跳过"; addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`); } else { addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证"); } },
    snapshot(state, action: PayloadAction<string>) { state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId }); state.snapshots = state.snapshots.slice(0, 10); },
    restore(state, action: PayloadAction<string>) { const snapshot = state.snapshots.find((entry) => entry.id === action.payload); if (!snapshot) return; state.evidence = structuredClone(snapshot.evidence); state.session.phase = snapshot.phase; state.session.currentEvidenceId = snapshot.currentEvidenceId; addEntry(state, "审判庭", "恢复庭审快照", snapshot.label); },
    tick(state) { if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1; },
    setPhase(state, action: PayloadAction<SessionPhase>) { state.session.phase = action.payload; addEntry(state, "审判庭", "切换庭审阶段", action.payload); },

    // ── 同步相关 ──
    setSyncStatus(state, action: PayloadAction<SyncStatus>) {
      state.syncStatus = action.payload;
    },
    /** 应用合并结果：更新证据、记录冲突 */
    applyMerge(state, action: PayloadAction<{ evidence: Evidence[]; conflicts: ConflictRecord[] }>) {
      state.evidence = action.payload.evidence;
      state.conflicts = action.payload.conflicts;
      state.syncStatus = action.payload.conflicts.length > 0 ? "conflict" : "idle";
      state.lastSyncedAt = action.payload.conflicts.length === 0 ? now() : state.lastSyncedAt;
    },
    /** 人工确认冲突：选择保留本地或服务器版本 */
    resolveConflict(state, action: PayloadAction<{ id: string; keep: "local" | "server" }>) {
      const conflict = state.conflicts.find((entry) => entry.id === action.payload.id);
      if (!conflict) return;
      const item = state.evidence.find((entry) => entry.id === conflict.evidenceId);
      if (action.payload.keep === "local") {
        if (item) Object.assign(item, conflict.localVersion);
        // 更新暂存队列的基线时间戳，避免重复检测到同一冲突
        for (const change of state.pendingChanges.filter((c) => c.evidenceId === conflict.evidenceId)) {
          change.baseUpdatedAt = conflict.serverVersion.updatedAt ?? "";
        }
      } else {
        if (item) Object.assign(item, conflict.serverVersion);
        // 保留服务器版本：清除该项的暂存修改
        state.pendingChanges = state.pendingChanges.filter((c) => c.evidenceId !== conflict.evidenceId);
      }
      state.conflicts = state.conflicts.filter((c) => c.id !== action.payload.id);
      if (state.conflicts.length === 0) {
        state.syncStatus = "idle";
      }
    },
    /** 清除已成功同步的暂存修改 */
    clearPendingChanges(state) {
      state.pendingChanges = [];
    },
    /** 标记旧数据为待确认 */
    markLegacyPending(state, action: PayloadAction<string[]>) {
      for (const id of action.payload) {
        const item = state.evidence.find((entry) => entry.id === id);
        if (item) item.pendingReview = true;
      }
    }
  }
});

export const {
  initialize, setOnline, setMode, reorder, selectEvidence, showEvidence, completeEvidence,
  toggleSensitive, updateNote, addObjection, resolveObjection, snapshot, restore, tick, setPhase,
  setSyncStatus, applyMerge, resolveConflict, clearPendingChanges, markLegacyPending
} = slice.actions;
export default slice.reducer;
