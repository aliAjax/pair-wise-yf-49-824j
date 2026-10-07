import type {
  Evidence,
  FieldConflict,
  FieldMeta,
  OutboxOp,
  ServerEvidence,
  SyncResult,
  SyncedField
} from "../types";

export const SYNCED_FIELDS: SyncedField[] = ["exhibitNo", "title", "note", "sensitive", "order"];

const FIELD_LABELS: Record<SyncedField, string> = {
  exhibitNo: "编号",
  title: "标题",
  note: "备注",
  sensitive: "遮罩",
  order: "顺序"
};

export function fieldLabel(field: SyncedField): string {
  return FIELD_LABELS[field];
}

/** 旧数据的字段元信息：无修订号、无时间、无来源 —— 只标待确认，不补号 */
export const LEGACY_META: FieldMeta = { rev: null, updatedAt: null, origin: null };

export function isLegacy(meta: FieldMeta): boolean {
  return meta.rev === null;
}

/**
 * 把迁移前的旧证据转成带版本槽位的结构。
 * 旧值原样保留，版本一律为 null（待确认），绝不替旧数据补修订号。
 */
export function migrateLegacy(
  legacy: Array<Record<string, unknown> & { id: string }>
): Evidence[] {
  return legacy.map((raw, index) => {
    const meta = {} as Record<SyncedField, FieldMeta>;
    for (const field of SYNCED_FIELDS) meta[field] = { ...LEGACY_META };
    return {
      id: String(raw.id),
      exhibitNo: String(raw.exhibitNo ?? ""),
      title: String(raw.title ?? ""),
      note: String(raw.note ?? ""),
      sensitive: Boolean(raw.sensitive),
      // 旧数据没有独立顺序版本：用数组位置作展示次序，同样标待确认
      order: typeof raw.order === "number" ? raw.order : index,
      type: (raw.type as Evidence["type"]) ?? "书证",
      duration: Number(raw.duration ?? 0),
      presenter: (raw.presenter as Evidence["presenter"]) ?? "审判庭",
      status: (raw.status as Evidence["status"]) ?? "待展示",
      meta
    };
  });
}

/** 按合并结果排序：顺序字段优先（旧数据按初始次序兜底） */
export function sortedEvidence(evidence: Evidence[]): Evidence[] {
  return [...evidence].sort((a, b) => {
    const diff = Number(a.order) - Number(b.order);
    return diff !== 0 ? diff : a.id.localeCompare(b.id);
  });
}

/** 该证据是否还有任何一项是迁移前旧版本（待确认） */
export function evidencePendingConfirm(evidence: Evidence): boolean {
  return SYNCED_FIELDS.some((field) => isLegacy(evidence.meta[field]));
}

/** 该证据是否存在任一未解决的两边冲突 —— 公开屏据此拦截 */
export function evidenceBlocked(evidence: Evidence, conflicts: FieldConflict[]): boolean {
  return conflicts.some(
    (conflict) => conflict.evidenceId === evidence.id && conflict.status === "待重新确认"
  );
}

export function hasPendingLocal(ops: OutboxOp[], evidenceId: string): boolean {
  return ops.some((op) => op.evidenceId === evidenceId && op.status === "pending");
}

/**
 * 按时间比较两个时间戳：较新者胜。
 * null（旧数据）永远比任何带时间的版本旧，绝不覆盖对方。
 */
export function newer(a: string | null, b: string | null): boolean {
  if (a === null) return false;
  if (b === null) return true;
  return a > b;
}

/**
 * 处理一次同步结果：
 * - 成功提交的字段：本地推进到服务端新修订号；
 * - 冲突字段：保留两个版本，生成「待重新确认」，按时间给出暂定建议；
 * - 其余字段的服务端版本：若比本地新（且本地没有待发修改），按时间并入。
 * 返回新的 evidence、冲突列表与仍待重试的 outbox。
 */
export function applySyncResult(
  evidence: Evidence[],
  conflicts: FieldConflict[],
  ops: OutboxOp[],
  result: SyncResult,
  now: string
): {
  evidence: Evidence[];
  conflicts: FieldConflict[];
  ops: OutboxOp[];
} {
  const nextEvidence = evidence.map((item) => ({ ...item, meta: { ...item.meta } }));
  const nextConflicts = conflicts.map((item) => ({ ...item }));
  const appliedSet = new Set(
    result.applied.map((entry) => `${entry.evidenceId}:${entry.field}`)
  );
  const newRevisions = new Map(
    result.applied.map((entry) => [`${entry.evidenceId}:${entry.field}`, entry.rev])
  );
  const pendingOpKeys = new Set(
    ops.filter((op) => op.status === "pending").map((op) => `${op.evidenceId}:${op.field}`)
  );
  const rawConflictKeys = new Set(
    result.conflicts.map((entry) => `${entry.evidenceId}:${entry.field}`)
  );

  const byId = new Map(nextEvidence.map((item) => [item.id, item]));

  // 1) 被接受的提交：本地成为权威版本，推进修订号
  for (const { evidenceId, field } of result.applied) {
    const target = byId.get(evidenceId);
    if (!target) continue;
    target.meta[field] = {
      rev: newRevisions.get(`${evidenceId}:${field}`) ?? target.meta[field].rev,
      updatedAt: now,
      origin: "local",
      confirmed: true
    };
  }

  // 2) 服务端回报的两边冲突：两个版本都保留
  for (const raw of result.conflicts) {
    const target = byId.get(raw.evidenceId);
    if (!target) continue;
    const existing = nextConflicts.find(
      (entry) =>
        entry.evidenceId === raw.evidenceId &&
        entry.field === raw.field &&
        entry.status === "待重新确认"
    );
    const localAt = raw.local.at;
    const remoteAt = raw.server.updatedAt;
    const suggested = newer(localAt, remoteAt) ? "local" : "remote";
    if (existing) {
      existing.localValue = raw.local.value;
      existing.remoteValue = raw.server.value;
      existing.localAt = localAt;
      existing.remoteAt = remoteAt ?? "";
      existing.localBaseRev = raw.baseRev;
      existing.remoteRev = raw.server.rev;
      existing.suggested = suggested;
    } else {
      nextConflicts.push({
        id: crypto.randomUUID(),
        evidenceId: raw.evidenceId,
        field: raw.field,
        localValue: raw.local.value,
        remoteValue: raw.server.value,
        localAt,
        remoteAt: remoteAt ?? "",
        localBaseRev: raw.baseRev,
        remoteRev: raw.server.rev,
        suggested,
        status: "待重新确认",
        detectedAt: now,
        resolvedAt: null
      });
    }
    // 暂定显示按时间较新的一版，但状态仍为冲突 -> 公开屏拦截
    const provisional = suggested === "local" ? raw.local.value : raw.server.value;
    target[raw.field] = provisional as never;
    target.meta[raw.field] = {
      rev: raw.server.rev,
      updatedAt: remoteAt,
      origin: "remote"
    };
  }

  // 3) 提交返回的其余服务端版本：按时间并入；本地有待发修改时不覆盖
  for (const record of result.evidence) {
    const target = byId.get(record.id);
    if (!target) continue;
    for (const field of SYNCED_FIELDS) {
      const serverVersion = record.fields[field];
      if (!serverVersion) continue;
      const key = `${record.id}:${field}`;
      if (appliedSet.has(key) || rawConflictKeys.has(key) || pendingOpKeys.has(key)) continue;
      const localMeta = target.meta[field];
      if (isLegacy(localMeta) || newer(serverVersion.updatedAt, localMeta.updatedAt)) {
        target[field] = serverVersion.value as never;
        target.meta[field] = {
          rev: serverVersion.rev,
          updatedAt: serverVersion.updatedAt,
          origin: serverVersion.origin
        };
      }
    }
  }

  // 4) 发件箱：成功提交的移除；冲突的保留并转 conflict（本地那批修改不丢，供重新确认/审计）；其余保留等重试
  const appliedKeys = new Set(
    result.applied.map((entry) => `${entry.evidenceId}:${entry.field}`)
  );
  const nextOps = ops
    .filter((op) => !(op.status === "pending" && appliedKeys.has(`${op.evidenceId}:${op.field}`)))
    .map((op) =>
      rawConflictKeys.has(`${op.evidenceId}:${op.field}`) && op.status === "pending"
        ? { ...op, status: "conflict" as const }
        : { ...op }
    );

  return { evidence: nextEvidence, conflicts: nextConflicts, ops: nextOps };
}

/** 纯轮询并入服务端版本（无本地批次时）。同样遵守：不覆盖待发修改，不覆盖旧数据的待确认属性由专门逻辑处理 */
export function mergeServerPull(
  evidence: Evidence[],
  conflicts: FieldConflict[],
  ops: OutboxOp[],
  server: ServerEvidence[],
  now: string
): { evidence: Evidence[]; conflicts: FieldConflict[] } {
  const pendingOpKeys = new Set(
    ops.filter((op) => op.status === "pending").map((op) => `${op.evidenceId}:${op.field}`)
  );
  const unresolvedConflictKeys = new Set(
    conflicts
      .filter((entry) => entry.status === "待重新确认")
      .map((entry) => `${entry.evidenceId}:${entry.field}`)
  );
  const nextEvidence = evidence.map((item) => ({ ...item, meta: { ...item.meta } }));
  const byId = new Map(nextEvidence.map((item) => [item.id, item]));

  for (const record of server) {
    const target = byId.get(record.id);
    if (!target) continue;
    for (const field of SYNCED_FIELDS) {
      const serverVersion = record.fields[field];
      if (!serverVersion) continue;
      const key = `${record.id}:${field}`;
      if (pendingOpKeys.has(key) || unresolvedConflictKeys.has(key)) continue;
      const localMeta = target.meta[field];
      if (isLegacy(localMeta) || newer(serverVersion.updatedAt, localMeta.updatedAt)) {
        target[field] = serverVersion.value as never;
        target.meta[field] = {
          rev: serverVersion.rev,
          updatedAt: serverVersion.updatedAt,
          origin: serverVersion.origin
        };
      }
    }
  }
  return { evidence: nextEvidence, conflicts };
}

/**
 * 重新确认后采用本地版本：以对端修订号为新 base 生成提交。
 * 冲突两个版本都已在冲突记录中保留，这里只产生新的待发操作。
 */
export function resolveConflictChooseLocal(
  conflict: FieldConflict,
  now: string
): { op: OutboxOp; status: FieldConflict["status"] } {
  return {
    op: {
      id: crypto.randomUUID(),
      evidenceId: conflict.evidenceId,
      field: conflict.field,
      value: conflict.localValue,
      baseRev: conflict.remoteRev,
      baseUpdatedAt: conflict.remoteAt || null,
      clientAt: now,
      status: "pending",
      attempts: 0
    },
    status: "已采用本地"
  };
}

export function describeValue(field: SyncedField, value: string | number | boolean): string {
  if (field === "sensitive") return value ? "公开屏遮罩" : "公开屏不遮罩";
  if (field === "order") return `第 ${Number(value) + 1} 位`;
  return String(value);
}
