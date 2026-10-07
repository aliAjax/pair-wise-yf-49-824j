import type { Evidence, FieldConflict, OutboxOp } from "../types";

/**
 * 本地暂存（独立于「在线版本」服务端存储）：
 * 断网时改过的备注、顺序、遮罩只写这里，绝不直接盖回在线版本。
 */
const LOCAL_KEY = "pair-wise-yf-49/local";

interface Persisted {
  evidence: Evidence[] | null;
  outbox: OutboxOp[];
  conflicts: FieldConflict[];
  lastSyncAt: string | null;
  syncError: string | null;
}

const EMPTY: Persisted = { evidence: null, outbox: [], conflicts: [], lastSyncAt: null, syncError: null };

export function loadLocal(): Persisted {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return EMPTY;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      evidence: Array.isArray(parsed.evidence) ? parsed.evidence : null,
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
      conflicts: Array.isArray(parsed.conflicts) ? parsed.conflicts : [],
      lastSyncAt: parsed.lastSyncAt ?? null,
      syncError: parsed.syncError ?? null
    };
  } catch {
    return EMPTY;
  }
}

export function saveLocal(data: Omit<Persisted, never>): void {
  localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify({
      evidence: data.evidence,
      outbox: data.outbox,
      conflicts: data.conflicts,
      lastSyncAt: data.lastSyncAt,
      syncError: data.syncError
    })
  );
}
