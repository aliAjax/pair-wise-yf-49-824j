import { createSlice, type PayloadAction } from "@reduxjs/toolkit";
import type {
  Evidence,
  FieldConflict,
  FieldMeta,
  Objection,
  OutboxOp,
  SessionPhase,
  SessionState,
  SyncedField,
  SyncResult,
  TimelineEntry
} from "../types";
import {
  applySyncResult,
  evidencePendingConfirm,
  isLegacy,
  LEGACY_META,
  mergeServerPull,
  resolveConflictChooseLocal,
  sortedEvidence,
  SYNCED_FIELDS
} from "./merge";
import { loadLocal } from "./localStore";

/** 迁移前的旧种子数据：没有任何版本信息 */
const legacySeed: Array<Record<string, unknown> & { id: string }> = [
  { id: "e1", exhibitNo: "原告-003", title: "项目验收会议纪要", type: "书证", duration: 8, presenter: "原告", sensitive: false, status: "待展示", note: "第4页涉及合同补充约定" },
  { id: "e2", exhibitNo: "原告-004", title: "设备故障检测报告", type: "书证", duration: 10, presenter: "原告", sensitive: true, status: "待展示", note: "含第三方客户名称，公开屏需遮罩" },
  { id: "e3", exhibitNo: "被告-002", title: "系统运行日志", type: "电子数据", duration: 12, presenter: "被告", sensitive: false, status: "待展示", note: "重点展示 14:20 至 14:45" }
];
const seedSession: SessionState = { phase: "举证", currentEvidenceId: "e1", timerSeconds: 8 * 60, operatorMode: "庭审控制" };

export interface SyncStatus {
  online: boolean;
  syncing: boolean;
  /** 上次成功同步时间 */
  lastSyncAt: string | null;
  /** 最近一次失败信息；存在待发批次时由调度器重试 */
  syncError: string | null;
}

interface State {
  initialized: boolean;
  evidence: Evidence[];
  objections: Objection[];
  timeline: TimelineEntry[];
  snapshots: { id: string; label: string; time: string; evidence: Evidence[]; phase: SessionPhase; currentEvidenceId: string | null }[];
  session: SessionState;
  /** 断网期间的本地修改批次，网络恢复前绝不写回在线版本 */
  outbox: OutboxOp[];
  /** 同一证据同一项两边改动：两个版本都保留，等待重新确认 */
  conflicts: FieldConflict[];
  sync: SyncStatus;
}

function buildSeedEvidence(): Evidence[] {
  const migrated = sortedEvidence(
    legacySeed.map((raw, index) => {
      const meta = {} as Record<SyncedField, FieldMeta>;
      for (const field of SYNCED_FIELDS) meta[field] = { ...LEGACY_META };
      return {
        id: raw.id,
        exhibitNo: String(raw.exhibitNo),
        title: String(raw.title),
        note: String(raw.note),
        sensitive: Boolean(raw.sensitive),
        order: index,
        type: raw.type as Evidence["type"],
        duration: Number(raw.duration),
        presenter: raw.presenter as Evidence["presenter"],
        status: raw.status as Evidence["status"],
        meta
      };
    })
  );
  return migrated;
}

const persisted = loadLocal();

const initialState: State = {
  initialized: false,
  evidence: persisted.evidence ?? buildSeedEvidence(),
  objections: [{ id: "o1", evidenceId: "e2", ground: "关联性异议", explanation: "检测报告来源和保管链尚未说明。", status: "待裁定", createdAt: new Date().toISOString() }],
  timeline: [{ id: "t1", time: new Date().toISOString(), actor: "书记员", action: "庭审开始", detail: "核对到庭人员并宣布法庭纪律" }],
  snapshots: [],
  session: seedSession,
  outbox: persisted.outbox,
  conflicts: persisted.conflicts,
  sync: { online: true, syncing: false, lastSyncAt: persisted.lastSyncAt, syncError: persisted.syncError }
};

function addEntry(state: State, actor: TimelineEntry["actor"], action: string, detail: string) {
  state.timeline.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor, action, detail });
}

/**
 * 本地修改：先放本地发件箱，不直接盖回在线版本。
 * - 未解决冲突的字段拒绝再次入队，必须先重新确认；
 * - 同一字段连续修改合并到同一条（baseRev 保持首次修改时的基准）；
 * - 修改即视为操作员对该字段完成人工核对，旧数据的待确认随之消除，但不补修订号。
 */
function stageEdit(
  state: State,
  payload: { evidenceId: string; field: SyncedField; value: string | number | boolean }
): boolean {
  const item = state.evidence.find((entry) => entry.id === payload.evidenceId);
  if (!item) return false;
  const blocked = state.conflicts.some(
    (conflict) =>
      conflict.evidenceId === payload.evidenceId &&
      conflict.field === payload.field &&
      conflict.status === "待重新确认"
  );
  if (blocked) return false;

  const now = new Date().toISOString();
  const baseMeta = item.meta[payload.field];
  item[payload.field] = payload.value as never;
  const wasLegacy = isLegacy(baseMeta);
  item.meta[payload.field] = {
    // 旧数据：仍不补修订号（rev 保持 null），只记录已被人工核对，待同步时以首版提交
    rev: baseMeta.rev,
    updatedAt: now,
    origin: "local",
    confirmed: wasLegacy ? true : (baseMeta.confirmed ?? true)
  };

  const existing = state.outbox.find(
    (op) =>
      op.evidenceId === payload.evidenceId &&
      op.field === payload.field &&
      op.status === "pending"
  );
  if (existing) {
    existing.value = payload.value;
    existing.clientAt = now;
  } else {
    state.outbox.push({
      id: crypto.randomUUID(),
      evidenceId: payload.evidenceId,
      field: payload.field,
      value: payload.value,
      baseRev: baseMeta.rev,
      baseUpdatedAt: baseMeta.updatedAt,
      clientAt: now,
      status: "pending",
      attempts: 0
    });
  }
  return true;
}

const slice = createSlice({
  name: "court",
  initialState,
  reducers: {
    /** 用迁移后的旧数据初始化（或从本地暂存恢复，已在 initialState 完成则跳过） */
    initialize(state, action: PayloadAction<Evidence[]>) {
      if (state.initialized) return;
      if (!persisted.evidence && action.payload.length) state.evidence = sortedEvidence(action.payload);
      state.initialized = true;
    },
    setOnline(state, action: PayloadAction<boolean>) {
      state.sync.online = action.payload;
      if (action.payload) state.sync.syncError = null;
    },
    setMode(state, action: PayloadAction<SessionState["operatorMode"]>) { state.session.operatorMode = action.payload; },
    reorder(state, action: PayloadAction<Evidence[]>) {
      // 拖拽结果按数组位置生成各证据「顺序」字段的修改，逐个进本地发件箱，不再整表盖回
      action.payload.forEach((item, index) => {
        const current = state.evidence.find((entry) => entry.id === item.id);
        if (current && Number(current.order) !== index) {
          stageEdit(state, { evidenceId: item.id, field: "order", value: index });
        }
      });
      addEntry(state, "书记员", "调整证据顺序", "顺序改动已暂存本地，等待同步合并");
    },
    editField(state, action: PayloadAction<{ id: string; field: SyncedField; value: string | number | boolean }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      const applied = stageEdit(state, { evidenceId: action.payload.id, field: action.payload.field, value: action.payload.value });
      if (!applied) return; // 该字段存在未解决冲突，必须先重新确认
      const labels: Record<SyncedField, string> = { exhibitNo: "编号", title: "标题", note: "备注", sensitive: "遮罩", order: "顺序" };
      addEntry(state, "书记员", `修改${labels[action.payload.field]}`, `${item.exhibitNo} ${item.title}（本地暂存）`);
    },
    /** 旧数据人工核对确认：只标待确认消除，不补号、不覆盖、不入发件箱 */
    confirmLegacyField(state, action: PayloadAction<{ id: string; field: SyncedField }>) {
      const item = state.evidence.find((entry) => entry.id === action.payload.id);
      if (!item) return;
      item.meta[action.payload.field] = { ...item.meta[action.payload.field], confirmed: true };
      addEntry(state, "书记员", "确认迁移前版本", `${item.exhibitNo} ${item.title}`);
    },
    confirmAllLegacy(state) {
      for (const item of state.evidence) {
        for (const field of SYNCED_FIELDS) {
          if (isLegacy(item.meta[field])) item.meta[field] = { ...item.meta[field], confirmed: true };
        }
      }
      addEntry(state, "书记员", "批量确认旧数据", "仅标记人工核对，未补修订号");
    },
    selectEvidence(state, action: PayloadAction<string>) { const item = state.evidence.find((entry) => entry.id === action.payload); if (!item) return; state.session.currentEvidenceId = item.id; state.session.timerSeconds = item.duration * 60; addEntry(state, item.presenter, "切换展示证据", `${item.exhibitNo} ${item.title}`); },
    showEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "展示中"; state.session.phase = "质证"; addEntry(state, item.presenter, "开始展示", item.title); },
    completeEvidence(state) { const item = state.evidence.find((entry) => entry.id === state.session.currentEvidenceId); if (!item) return; item.status = "已展示"; const next = sortedEvidence(state.evidence).find((entry) => entry.status === "待展示"); state.session.currentEvidenceId = next?.id ?? null; state.session.timerSeconds = (next?.duration ?? 0) * 60; state.session.phase = next ? "举证" : "休庭"; addEntry(state, "审判庭", "完成质证", item.title); },
    toggleSensitive(state, action: PayloadAction<string>) {
      const item = state.evidence.find((entry) => entry.id === action.payload);
      if (!item) return;
      const becomesSensitive = !item.sensitive;
      const applied = stageEdit(state, { evidenceId: item.id, field: "sensitive", value: becomesSensitive });
      if (applied) addEntry(state, "审判庭", becomesSensitive ? "隐藏敏感内容" : "恢复公开内容", `${item.title}（本地暂存）`);
    },
    addObjection(state, action: PayloadAction<{ evidenceId: string; ground: string; explanation: string }>) { const item = state.evidence.find((entry) => entry.id === action.payload.evidenceId); state.objections.unshift({ ...action.payload, id: crypto.randomUUID(), status: "待裁定", createdAt: new Date().toISOString() }); state.session.phase = "质证"; addEntry(state, item?.presenter ?? "审判庭", "提出异议", `${item?.exhibitNo ?? ""} ${action.payload.ground}`); },
    resolveObjection(state, action: PayloadAction<{ id: string; status: "支持" | "驳回" }>) { const objection = state.objections.find((entry) => entry.id === action.payload.id); if (!objection) return; objection.status = action.payload.status; const item = state.evidence.find((entry) => entry.id === objection.evidenceId); if (action.payload.status === "支持" && item) { item.status = "已跳过"; addEntry(state, "审判庭", "异议成立", `${item.exhibitNo} 暂不展示`); } else { addEntry(state, "审判庭", "异议驳回", item?.title ?? "继续质证"); } },
    snapshot(state, action: PayloadAction<string>) { state.snapshots.unshift({ id: crypto.randomUUID(), label: action.payload, time: new Date().toISOString(), evidence: structuredClone(state.evidence), phase: state.session.phase, currentEvidenceId: state.session.currentEvidenceId }); state.snapshots = state.snapshots.slice(0, 10); },
    restore(state, action: PayloadAction<string>) { const snapshot = state.snapshots.find((entry) => entry.id === action.payload); if (!snapshot) return; state.evidence = structuredClone(snapshot.evidence); state.session.phase = snapshot.phase; state.session.currentEvidenceId = snapshot.currentEvidenceId; addEntry(state, "审判庭", "恢复庭审快照", snapshot.label); },
    tick(state) { if (state.session.phase === "质证" && state.session.timerSeconds > 0) state.session.timerSeconds -= 1; },
    setPhase(state, action: PayloadAction<SessionPhase>) { state.session.phase = action.payload; addEntry(state, "审判庭", "切换庭审阶段", action.payload); },

    /* ---------- 同步生命周期 ---------- */

    syncStarted(state) { state.sync.syncing = true; state.sync.syncError = null; },
    syncSucceeded(state, action: PayloadAction<SyncResult>) {
      const now = new Date().toISOString();
      const merged = applySyncResult(state.evidence, state.conflicts, state.outbox, action.payload, now);
      state.evidence = sortedEvidence(merged.evidence);
      state.conflicts = merged.conflicts;
      state.outbox = merged.ops;
      state.sync.syncing = false;
      state.sync.syncError = null;
      state.sync.lastSyncAt = now;
      const conflictCount = action.payload.conflicts.length;
      if (conflictCount > 0) {
        addEntry(state, "书记员", "同步发现两边改动", `${conflictCount} 项保留两个版本，等待重新确认（公开屏已拦截）`);
      } else if (action.payload.applied.length > 0) {
        addEntry(state, "书记员", "本地修改已合并", `${action.payload.applied.length} 项写入在线版本`);
      }
    },
    syncFailed(state, action: PayloadAction<string>) {
      state.sync.syncing = false;
      state.sync.syncError = action.payload;
      // 失败后整批保留，只记尝试次数，由调度器按退避重试 —— 本地那批修改不丢
      for (const op of state.outbox) if (op.status === "pending") op.attempts += 1;
    },
    pullSucceeded(state, action: PayloadAction<import("../types").ServerEvidence[]>) {
      const merged = mergeServerPull(state.evidence, state.conflicts, state.outbox, action.payload, new Date().toISOString());
      state.evidence = sortedEvidence(merged.evidence);
      state.conflicts = merged.conflicts;
      state.sync.lastSyncAt = new Date().toISOString();
    },
    /** 重新确认：采用本地版本 -> 以对端修订号为 base 重新提交 */
    resolveChooseLocal(state, action: PayloadAction<string>) {
      const conflict = state.conflicts.find((entry) => entry.id === action.payload);
      if (!conflict || conflict.status !== "待重新确认") return;
      const { op, status } = resolveConflictChooseLocal(conflict, new Date().toISOString());
      state.outbox.push(op);
      conflict.status = status;
      conflict.resolvedAt = new Date().toISOString();
      const item = state.evidence.find((entry) => entry.id === conflict.evidenceId);
      if (item) item[conflict.field] = conflict.localValue as never;
      addEntry(state, "书记员", "重新确认冲突", `保留本地版本，重新提交在线合并`);
    },
    /** 重新确认：采用对端版本 -> 本地直接对齐，不再提交 */
    resolveChooseRemote(state, action: PayloadAction<string>) {
      const conflict = state.conflicts.find((entry) => entry.id === action.payload);
      if (!conflict || conflict.status !== "待重新确认") return;
      const item = state.evidence.find((entry) => entry.id === conflict.evidenceId);
      if (item) {
        item[conflict.field] = conflict.remoteValue as never;
        item.meta[conflict.field] = { rev: conflict.remoteRev, updatedAt: conflict.remoteAt || null, origin: "remote", confirmed: true };
      }
      conflict.status = "已采用对端";
      conflict.resolvedAt = new Date().toISOString();
      addEntry(state, "书记员", "重新确认冲突", `采用对端版本，公开屏解除拦截`);
    }
  }
});

export const {
  initialize, setOnline, setMode, reorder, editField, confirmLegacyField, confirmAllLegacy,
  selectEvidence, showEvidence, completeEvidence, toggleSensitive, addObjection, resolveObjection,
  snapshot, restore, tick, setPhase,
  syncStarted, syncSucceeded, syncFailed, pullSucceeded, resolveChooseLocal, resolveChooseRemote
} = slice.actions;

export const selectors = {
  sortedEvidence: (state: { court: State }) => sortedEvidence(state.court.evidence),
  pendingCount: (state: { court: State }) => state.court.outbox.filter((op) => op.status === "pending").length,
  unresolvedConflicts: (state: { court: State }) => state.court.conflicts.filter((entry) => entry.status === "待重新确认"),
  pendingLegacy: (state: { court: State }) =>
    state.court.evidence.filter((item) =>
      SYNCED_FIELDS.some((field) => isLegacy(item.meta[field]) && !item.meta[field].confirmed)
    ),
  evidencePendingConfirm
};

export default slice.reducer;
