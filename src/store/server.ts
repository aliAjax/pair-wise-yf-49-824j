import type { FieldMeta, ServerEvidence, ServerFieldVersion, SyncResult, SyncedField } from "../types";

/**
 * 模拟「在线版本」服务端：独立于本地状态持久化，保存字段级版本。
 * 断网时操作台完全不触碰这里；网络恢复后带 baseRev 提交，
 * 服务端只接受基于当前版本的修改，否则回报冲突。
 */
const SERVER_KEY = "pair-wise-yf-49/server";
const FORCE_FAIL_KEY = "pair-wise-yf-49/server-fail";
const SYNC_FIELDS: SyncedField[] = ["exhibitNo", "title", "note", "sensitive", "order"];

interface Submission {
  evidenceId: string;
  field: SyncedField;
  value: string | number | boolean;
  baseRev: number | null;
  clientAt: string;
}

function readRaw(): ServerEvidence[] | null {
  const raw = localStorage.getItem(SERVER_KEY);
  return raw ? (JSON.parse(raw) as ServerEvidence[]) : null;
}

function writeRaw(data: ServerEvidence[]) {
  localStorage.setItem(SERVER_KEY, JSON.stringify(data));
}

/** 旧数据引导：无版本信息的数据原样落库，服务端也不替它补修订号 */
export function seedServerIfEmpty(evidence: { id: string }[]): ServerEvidence[] {
  const existing = readRaw();
  if (existing) return existing;
  const seeded: ServerEvidence[] = evidence.map((item) => ({ id: item.id, fields: {} }));
  writeRaw(seeded);
  return seeded;
}

export function readServer(): ServerEvidence[] {
  return readRaw() ?? [];
}

/** 测试/演示用：让下一次同步失败一次，验证失败重试与本地批次不丢 */
export function armNextSyncFailure() {
  localStorage.setItem(FORCE_FAIL_KEY, "1");
}

function currentRev(data: ServerEvidence[], evidenceId: string, field: SyncedField): number {
  return data.find((item) => item.id === evidenceId)?.fields[field]?.rev ?? 0;
}

/**
 * 提交一批本地修改。
 * - baseRev 与服务端当前修订一致（或双方都在旧数据 rev=0 之上首次写入）才接受；
 * - 同一项已被对端改过则不覆盖，记入 conflicts 并回传服务端当前版本；
 * - 整批要么一起被服务端处理（冲突的条目单独回报），调用方据此重试剩余条目。
 */
export function submitToServer(submissions: Submission[]): Promise<SyncResult> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (localStorage.getItem(FORCE_FAIL_KEY) === "1") {
        // 仅失败一次，随后恢复，配合指数退避重试
        localStorage.removeItem(FORCE_FAIL_KEY);
        reject(new Error("网络波动，同步失败"));
        return;
      }
      const data = readRaw() ?? [];
      const conflicts: SyncResult["conflicts"] = [];
      const applied: SyncResult["applied"] = [];
      let revision = Math.max(0, ...data.flatMap((item) => SYNC_FIELDS.map((field) => item.fields[field]?.rev ?? 0)));

      for (const sub of submissions) {
        let record = data.find((item) => item.id === sub.evidenceId);
        if (!record) {
          record = { id: sub.evidenceId, fields: {} };
          data.push(record);
        }
        const serverVersion = record.fields[sub.field] as ServerFieldVersion | undefined;
        const serverRev = serverVersion?.rev ?? 0;
        const base = sub.baseRev ?? 0;
        if (base !== serverRev) {
          // 同一项两边都动过：服务端保留自己的版本，交给客户端做双版本保留与重新确认
          if (serverVersion) {
            conflicts.push({
              evidenceId: sub.evidenceId,
              field: sub.field,
              baseRev: sub.baseRev,
              local: { value: sub.value, at: sub.clientAt },
              server: structuredClone(serverVersion)
            });
          }
          continue;
        }
        revision += 1;
        const meta: FieldMeta = { rev: revision, updatedAt: sub.clientAt, origin: "local" };
        record.fields[sub.field] = { ...meta, value: sub.value };
        applied.push({ evidenceId: sub.evidenceId, field: sub.field, rev: revision });
      }

      writeRaw(data);
      resolve({ revision, evidence: data, conflicts, applied });
    }, 250);
  });
}

/** 拉取在线版本（轮询用），延迟后返回全量字段版本 */
export function pullFromServer(): Promise<ServerEvidence[]> {
  return new Promise((resolve, reject) => {
    window.setTimeout(() => {
      if (localStorage.getItem(FORCE_FAIL_KEY) === "1") {
        reject(new Error("网络不可达"));
        return;
      }
      resolve(readRaw() ?? []);
    }, 200);
  });
}

/**
 * 演示/对端入口：模拟另一台操作台（书记员席）直接写入在线版本。
 * 与本地提交走同一套版本规则，用于复现「同一证据同一项两边改动」。
 */
export function simulateRemoteEdit(input: {
  evidenceId: string;
  field: SyncedField;
  value: string | number | boolean;
  at: string;
}): ServerEvidence[] {
  const data = readRaw() ?? [];
  let record = data.find((item) => item.id === input.evidenceId);
  if (!record) {
    record = { id: input.evidenceId, fields: {} };
    data.push(record);
  }
  const revision =
    Math.max(0, ...data.flatMap((item) => SYNC_FIELDS.map((field) => item.fields[field]?.rev ?? 0))) + 1;
  record.fields[input.field] = {
    rev: revision,
    updatedAt: input.at,
    origin: "remote",
    value: input.value
  };
  writeRaw(data);
  return data;
}
