export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

/** 参与合并的字段：编号、标题、备注、遮罩、顺序 */
export type SyncedField = "exhibitNo" | "title" | "note" | "sensitive" | "order";

/** 变更来源：本地操作台，或对端（书记员/另一操作端）经服务端到达 */
export type FieldOrigin = "local" | "remote";

/**
 * 字段版本。
 * rev 为 null 表示这是迁移前的旧数据：只标成「待确认」，不补修订号，也不覆盖在线版本。
 */
export interface FieldMeta {
  rev: number | null;
  updatedAt: string | null;
  origin: FieldOrigin | null;
  /** 旧数据经人工核对确认；确认本身不补修订号，也不触发覆盖 */
  confirmed?: boolean;
}

export interface FieldValues {
  exhibitNo: string;
  title: string;
  note: string;
  sensitive: boolean;
  order: number;
}

/** 证据：每个受合并管理的字段都带一份版本信息 */
export interface Evidence extends FieldValues {
  id: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  status: EvidenceStatus;
  meta: Record<SyncedField, FieldMeta>;
}

/** 旧数据（缺版本信息）在本地被确认前的状态 */
export type ConfirmState = "正常" | "待确认" | "冲突";

/** 本地待发修改。断网期间留在本地，同步成功后才移除，失败则重试 */
export interface OutboxOp {
  id: string;
  evidenceId: string;
  field: SyncedField;
  value: string | number | boolean;
  baseRev: number | null;
  baseUpdatedAt: string | null;
  clientAt: string;
  status: "pending" | "conflict";
  attempts: number;
}

/** 同一证据同一项被两边改动：两个版本都保留，等待重新确认 */
export interface FieldConflict {
  id: string;
  evidenceId: string;
  field: SyncedField;
  localValue: string | number | boolean;
  remoteValue: string | number | boolean;
  localAt: string;
  remoteAt: string;
  /** 本地版本所基于的服务端修订号（旧数据为 null） */
  localBaseRev: number | null;
  /** 对端版本的服务端修订号，重新确认后用它作为新提交的 base */
  remoteRev: number | null;
  /** 按时间合并的暂定建议（较新一方），确认前公开屏仍然拦截 */
  suggested: FieldOrigin;
  status: "待重新确认" | "已采用本地" | "已采用对端";
  detectedAt: string;
  resolvedAt: string | null;
}

export interface ServerFieldVersion extends FieldMeta {
  value: string | number | boolean;
}

export interface ServerEvidence {
  id: string;
  fields: Partial<Record<SyncedField, ServerFieldVersion>>;
}

export interface SyncConflict {
  evidenceId: string;
  field: SyncedField;
  baseRev: number | null;
  local: { value: string | number | boolean; at: string };
  server: ServerFieldVersion;
}

export interface SyncResult {
  revision: number;
  evidence: ServerEvidence[];
  conflicts: SyncConflict[];
  applied: { evidenceId: string; field: SyncedField; rev: number }[];
}

export interface Objection {
  id: string;
  evidenceId: string;
  ground: string;
  explanation: string;
  status: "待裁定" | "支持" | "驳回";
  createdAt: string;
}

export interface TimelineEntry {
  id: string;
  time: string;
  actor: Party | "书记员";
  action: string;
  detail: string;
}

export interface SessionState {
  phase: SessionPhase;
  currentEvidenceId: string | null;
  timerSeconds: number;
  operatorMode: "庭审控制" | "公开屏预览";
}
