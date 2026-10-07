export type Party = "原告" | "被告" | "审判庭";
export type EvidenceStatus = "待展示" | "展示中" | "已展示" | "已跳过";
export type SessionPhase = "开庭" | "举证" | "质证" | "休庭" | "结束";

export interface Evidence {
  id: string;
  exhibitNo: string;
  title: string;
  type: "书证" | "物证" | "电子数据" | "证人";
  duration: number;
  presenter: Party;
  sensitive: boolean;
  status: EvidenceStatus;
  note: string;
  /** 排序序号，用于离线时记录顺序调整 */
  order: number;
  /** 最后修改时间戳；缺失表示旧版本数据，需标待确认 */
  updatedAt?: string;
  /** 单调版本号；旧数据可能缺失 */
  version?: number;
  /** 旧数据标记：待人工确认，不补号不覆盖 */
  pendingReview?: boolean;
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

/** 本地暂存队列中的一条修改记录 */
export interface LocalChange {
  id: string;
  evidenceId: string;
  changedAt: string;
  changes: Partial<Evidence>;
  /** 该修改所基于的版本时间戳，用于检测服务器是否也改了同一项 */
  baseUpdatedAt: string;
}

/** 双方修改冲突记录：保留两个版本待人工确认 */
export interface ConflictRecord {
  id: string;
  evidenceId: string;
  localVersion: Evidence;
  serverVersion: Evidence;
  detectedAt: string;
}

export type SyncStatus = "idle" | "syncing" | "offline" | "conflict" | "error";
