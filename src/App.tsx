import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Badge,
  Button,
  Card,
  Form,
  Input,
  Message,
  Modal,
  Popconfirm,
  Radio,
  Select,
  Space,
  Statistic,
  Switch,
  Tag,
  Timeline as ArcoTimeline
} from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addObjection,
  completeEvidence,
  confirmAllLegacy,
  confirmLegacyField,
  editField,
  initialize,
  reorder,
  resolveChooseLocal,
  resolveChooseRemote,
  resolveObjection,
  restore,
  selectEvidence,
  setMode,
  setOnline,
  setPhase,
  showEvidence,
  snapshot,
  tick,
  toggleSensitive
} from "./store/courtSlice";
import type { RootState } from "./store";
import {
  describeValue,
  evidenceBlocked,
  evidencePendingConfirm,
  fieldLabel,
  sortedEvidence,
  SYNCED_FIELDS
} from "./store/merge";
import { armNextSyncFailure, simulateRemoteEdit } from "./store/server";
import { bootstrapServer, startPersistence, startSyncEngine } from "./store/sync";
import { store } from "./store";
import type { Evidence, FieldConflict, OutboxOp, Party, SessionPhase, SyncedField } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** Input 产生字符串；遮罩是布尔，按字段转回正确的值类型再暂存 */
function toFieldValue(field: SyncedField, raw: string | boolean): string | number | boolean {
  if (field === "sensitive") return Boolean(raw);
  if (field === "order") return Number(raw);
  return String(raw);
}

/** 字段级状态标记：旧数据待确认 / 本地待同步 / 两边冲突待重新确认 */
function FieldBadges({ evidence, field }: { evidence: Evidence; field: SyncedField }) {
  const conflicts = useAppSelector((root: RootState) => root.court.conflicts);
  const outbox = useAppSelector((root: RootState) => root.court.outbox);
  const meta = evidence.meta[field];
  const pending = outbox.some((op: OutboxOp) => op.status === "pending" && op.evidenceId === evidence.id && op.field === field);
  const conflict = conflicts.find((item) => item.evidenceId === evidence.id && item.field === field);
  if (conflict) {
    if (conflict.status === "待重新确认") return <Tag color="red" size="small">两边改动·待重新确认</Tag>;
    return <Tag color="green" size="small">已确认·{conflict.status === "已采用本地" ? "本地版" : "对端版"}</Tag>;
  }
  if (meta.rev === null && !meta.confirmed) return <Tag color="orange" size="small">旧数据·待确认</Tag>;
  if (meta.rev === null && meta.confirmed) return <Tag color="gold" size="small">已核对·首版待同步</Tag>;
  if (pending) return <Tag color="arcoblue" size="small">本地暂存·待同步</Tag>;
  return <Tag color="gray" size="small">v{meta.rev}</Tag>;
}

/** 公开屏：编号、标题、遮罩一律读合并结果；存在两边冲突的证据在公开屏前拦下 */
function PublicScreen({ evidence, timer, phase, conflicts }: {
  evidence: Evidence | null;
  timer: number;
  phase: SessionPhase;
  conflicts: FieldConflict[];
}) {
  if (!evidence) {
    return <div className="public-screen"><small>公开展示</small><h2>暂无证据</h2><h3>庭审进行中</h3></div>;
  }
  const blocked = evidenceBlocked(evidence, conflicts);
  const legacyPending = evidencePendingConfirm(evidence);
  return (
    <div className="public-screen">
      <small>公开展示 · 内容与合并结果一致</small>
      <div className="public-tags">
        {blocked && <Tag color="red">冲突暂缓公示</Tag>}
        {!blocked && legacyPending && <Tag color="orange">部分内容待确认</Tag>}
        {!blocked && evidence.sensitive && <Tag color="gold">敏感遮罩生效</Tag>}
      </div>
      <h2>{blocked ? "编号暂缓公示" : evidence.exhibitNo}</h2>
      <h3>{blocked ? "该证据存在两边冲突，等待重新确认" : evidence.title}</h3>
      {blocked ? (
        <div className="redaction"><b>公开屏已拦截</b><p>同一证据同一项被操作台与对端同时修改，两个版本均已保留。经法庭重新确认前，编号、标题与遮罩不公示。</p></div>
      ) : evidence.sensitive ? (
        <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div>
      ) : (
        <p>{evidence.note}</p>
      )}
      <footer>计时 {formatTime(timer)} · {phase} · 顺序第 {Number(evidence.order) + 1} 位</footer>
    </div>
  );
}

function ConflictPanel({ compact = false }: { compact?: boolean }) {
  const dispatch = useAppDispatch();
  const conflicts = useAppSelector((root) => root.court.conflicts);
  const evidence = useAppSelector((root) => root.court.evidence);
  const unresolved = conflicts.filter((item) => item.status === "待重新确认");
  if (!unresolved.length) return <Alert type="success" content="没有待重新确认的两边冲突，公开屏正常公示。" />;
  return (
    <div className="conflict-list">
      {unresolved.map((conflict) => {
        const item = evidence.find((entry) => entry.id === conflict.evidenceId);
        return (
          <div className="conflict-card" key={conflict.id}>
            <div className="conflict-head">
              <b>{item?.exhibitNo} · {item?.title}</b>
              <Tag color="red">字段：{fieldLabel(conflict.field)}</Tag>
              <Tag color={conflict.suggested === "local" ? "arcoblue" : "purple"}>按时间建议：{conflict.suggested === "local" ? "本地较新" : "对端较新"}</Tag>
            </div>
            <div className="conflict-versions">
              <div className={`version ${conflict.suggested === "local" ? "suggested" : ""}`}>
                <small>本地操作台版本 · {new Date(conflict.localAt).toLocaleTimeString("zh-CN", { hour12: false })}</small>
                <p>{describeValue(conflict.field, conflict.localValue)}</p>
              </div>
              <div className={`version ${conflict.suggested === "remote" ? "suggested" : ""}`}>
                <small>对端在线版本 · {conflict.remoteAt ? new Date(conflict.remoteAt).toLocaleTimeString("zh-CN", { hour12: false }) : "—"}</small>
                <p>{describeValue(conflict.field, conflict.remoteValue)}</p>
              </div>
            </div>
            {!compact && (
              <Space>
                <Popconfirm title="保留本地版本，并以对端修订号为基准重新提交？" onOk={() => { dispatch(resolveChooseLocal(conflict.id)); }}>
                  <Button size="small" type="primary">采用本地版本</Button>
                </Popconfirm>
                <Popconfirm title="公开屏将按对端版本公示？" onOk={() => { dispatch(resolveChooseRemote(conflict.id)); }}>
                  <Button size="small" status="success">采用对端版本</Button>
                </Popconfirm>
              </Space>
            )}
          </div>
        );
      })}
    </div>
  );
}

function SyncStatusBar() {
  const dispatch = useAppDispatch();
  const sync = useAppSelector((root) => root.court.sync);
  const evidence = useAppSelector((root) => sortedEvidence(root.court.evidence));
  const pending = useAppSelector((root) => root.court.outbox.filter((op) => op.status === "pending"));
  const conflictCount = useAppSelector((root) => root.court.conflicts.filter((item) => item.status === "待重新确认").length);

  const demoRemote = () => {
    const target = evidence[0];
    if (!target) return Message.warning("没有可用证据");
    simulateRemoteEdit({ evidenceId: target.id, field: "title", value: `${target.title}（对端书记员修订）`, at: new Date().toISOString() });
    Message.info("对端已修改在线版本；本机下次同步或 10 秒轮询即出现两边冲突");
  };

  return (
    <Card className="sync-card" title="网络与合并状态">
      <div className="sync-row">
        <Tag color={sync.online ? "green" : "red"}>{sync.online ? "与公开屏在线" : "断网 · 仅本地暂存"}</Tag>
        <Tag color={pending.length ? "arcoblue" : "gray"}>{pending.length ? `本地批次 ${pending.length} 项待合并` : "发件箱已清空"}</Tag>
        <Tag color={conflictCount ? "red" : "green"}>{conflictCount ? `${conflictCount} 项待重新确认` : "无冲突"}</Tag>
      </div>
      <div className="sync-row">
        {sync.syncing && <Tag color="blue">合并中…</Tag>}
        {sync.syncError && <Tag color="red">同步失败：{sync.syncError}（自动重试中）</Tag>}
        {sync.lastSyncAt && <small>上次成功合并：{new Date(sync.lastSyncAt).toLocaleString("zh-CN", { hour12: false })}</small>}
      </div>
      <div className="sync-row">
        <Switch checked={sync.online} onChange={(value) => dispatch(setOnline(value))} />
        <span>{sync.online ? "在线：改动按字段版本与时间合并" : "离线：改动只留本地，不盖回在线版本"}</span>
      </div>
      <Space wrap>
        <Button size="small" onClick={demoRemote}>模拟对端修改第一项标题</Button>
        <Button size="small" onClick={() => { armNextSyncFailure(); Message.info("下次同步将失败一次，用于验证退避重试与批次保留"); }}>模拟下次同步失败</Button>
      </Space>
    </Card>
  );
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const evidence = useMemo(() => sortedEvidence(state.evidence), [state.evidence]);
  const [mode, setLocalMode] = useState<"控制" | "预览">("预览");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId) ?? null;
  const pendingObjections = state.objections.filter((item) => item.status === "待裁定");
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };

  return (
    <div className="court-grid">
      <Card
        className="operator"
        title="证据操作台"
        extra={<Space><Tag color={state.sync.online ? "green" : "red"}>{state.sync.online ? "在线合并" : "离线本地暂存"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}
      >
        <Alert
          type="info"
          style={{ marginBottom: 10 }}
          content="断网时的编号、标题、备注、遮罩、顺序改动只进本地发件箱；网络恢复后按字段版本与时间合并，绝不整表盖回。"
        />
        <div className="evidence-list">
          {evidence.map((item, index) => {
            const blocked = evidenceBlocked(item, state.conflicts);
            const legacy = evidencePendingConfirm(item);
            return (
              <article
                key={item.id}
                draggable
                onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))}
                onDragOver={(event) => event.preventDefault()}
                onDrop={(event) => {
                  const from = Number(event.dataTransfer.getData("text/plain"));
                  if (Number.isNaN(from) || from === index) return;
                  const items = [...evidence];
                  const [moved] = items.splice(from, 1);
                  items.splice(index, 0, moved);
                  dispatch(reorder(items));
                }}
                className={current?.id === item.id ? "active" : ""}
              >
                <span>{index + 1}</span>
                <div>
                  <b>{item.exhibitNo} · {item.title} {blocked && <Tag color="red" size="small">公开屏拦截</Tag>} {legacy && <Tag color="orange" size="small">待确认</Tag>}</b>
                  <small>{item.type} · {item.presenter} · {item.duration}分钟 · 备注：{item.note}</small>
                  <div className="field-badges">
                    {SYNCED_FIELDS.map((field) => (
                      <span key={field} className="field-badge">{fieldLabel(field)}<FieldBadges evidence={item} field={field} /></span>
                    ))}
                  </div>
                </div>
                <Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : "gray"}>{item.status}</Tag>
                <Button size="mini" onClick={() => dispatch(selectEvidence(item.id))}>选中</Button>
              </article>
            );
          })}
        </div>
        <div className="control-strip">
          <Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current}>开始展示</Button>
          <Button onClick={() => dispatch(completeEvidence())} disabled={!current}>完成并切换下一条</Button>
          <Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button>
          <Button onClick={() => current && dispatch(toggleSensitive(current.id))} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button>
        </div>
      </Card>
      <div className="side-stack">
        <Card
          title="公开屏预览"
          extra={<Select size="small" value={mode} onChange={(value) => { const next = value as "控制" | "预览"; setLocalMode(next); dispatch(setMode(next === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{ value: "预览", label: "公开屏" }, { value: "控制", label: "控制者视图" }]} />}
          className="preview-card"
        >
          {mode === "预览" ? (
            <PublicScreen evidence={current} timer={state.session.timerSeconds} phase={state.session.phase} conflicts={state.conflicts} />
          ) : (
            <div className="public-screen controller-view">
              <small>控制者私有视图</small>
              <h2>敏感内容可预览</h2>
              <p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p>
              <Tag color="red">操作端专属</Tag>
            </div>
          )}
        </Card>
        <SyncStatusBar />
        <Card title="待重新确认的两边改动" extra={<Badge count={state.conflicts.filter((item) => item.status === "待重新确认").length} />}>
          <ConflictPanel compact />
          <div style={{ marginTop: 8 }}>
            {state.conflicts.some((item) => item.status === "待重新确认") && <NavLink to="/conflicts">前往完整核对页 →</NavLink>}
          </div>
        </Card>
        <Card title="待审异议" extra={<Tag color="red">{pendingObjections.length}</Tag>}>
          {pendingObjections.map((item) => (
            <div className="objection" key={item.id}>
              <b>{item.ground}</b><p>{item.explanation}</p>
              <Space>
                <Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button>
                <Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button>
              </Space>
            </div>
          ))}
          {!pendingObjections.length && <p>当前没有待裁定异议。</p>}
        </Card>
      </div>
      <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}>
        <Form layout="vertical">
          <Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{ value: "关联性异议", label: "关联性异议" }, { value: "真实性异议", label: "真实性异议" }, { value: "合法性异议", label: "合法性异议" }]} />} /></Form.Item>
          <Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item>
        </Form>
      </Modal>
      <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group></Card>
    </div>
  );
}

function EvidencePage() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const evidence = useMemo(() => sortedEvidence(state.evidence), [state.evidence]);
  const legacyCount = evidence.filter((item) => evidencePendingConfirm(item)).length;
  return (
    <Card
      title="证据目录与公开属性"
      extra={legacyCount > 0 ? <Button status="warning" size="small" onClick={() => dispatch(confirmAllLegacy())}>批量确认旧数据（不补号）</Button> : undefined}
    >
      <Alert type={legacyCount > 0 ? "warning" : "success"} style={{ marginBottom: 12 }} content={legacyCount > 0 ? `${legacyCount} 条证据含迁移前字段，已标为待确认：人工核对前不补修订号、不覆盖在线版本。` : "全部字段均有版本信息或已人工确认。"} />
      <div className="catalog">
        {evidence.map((item) => (
          <article key={item.id}>
            <div className="catalog-main">
              <div className="catalog-line">
                <b>{item.exhibitNo} {item.title}</b>
                <Tag>{item.type}</Tag>
                {evidenceBlocked(item, state.conflicts) && <Tag color="red">公开屏拦截中</Tag>}
              </div>
              <div className="edit-grid">
                <label>编号<Input size="small" value={String(item.exhibitNo)} onChange={(value) => dispatch(editField({ id: item.id, field: "exhibitNo", value: toFieldValue("exhibitNo", value) }))} addAfter={<FieldBadges evidence={item} field="exhibitNo" />} /></label>
                <label>标题<Input size="small" value={String(item.title)} onChange={(value) => dispatch(editField({ id: item.id, field: "title", value: toFieldValue("title", value) }))} addAfter={<FieldBadges evidence={item} field="title" />} /></label>
                <label className="wide">备注<Input.TextArea autoSize value={String(item.note)} onChange={(value) => dispatch(editField({ id: item.id, field: "note", value: toFieldValue("note", value) }))} /></label>
              </div>
              <div className="field-badges">
                <span className="field-badge">备注<FieldBadges evidence={item} field="note" /></span>
                <span className="field-badge">顺序<FieldBadges evidence={item} field="order" /></span>
                {SYNCED_FIELDS.filter((field) => item.meta[field].rev === null && !item.meta[field].confirmed).map((field) => (
                  <Button key={field} size="mini" status="warning" onClick={() => dispatch(confirmLegacyField({ id: item.id, field }))}>确认旧{fieldLabel(field)}</Button>
                ))}
              </div>
            </div>
            <div className="switch-line">
              <span>公开屏敏感遮罩</span>
              <Switch checked={Boolean(item.sensitive)} onChange={() => dispatch(toggleSensitive(item.id))} />
              <FieldBadges evidence={item} field="sensitive" />
            </div>
          </article>
        ))}
      </div>
    </Card>
  );
}

function ConflictsPage() {
  return (
    <div className="timeline-grid">
      <Card title="两边改动核对（两个版本均保留）">
        <Alert type="warning" style={{ marginBottom: 12 }} content="同一证据同一项被操作台与对端同时修改。按时间给出暂定建议，但在法庭重新确认前，公开屏一律拦截，编号、标题与遮罩均不公示。" />
        <ConflictPanel />
      </Card>
      <ResolvedList />
    </div>
  );
}

function ResolvedList() {
  const conflicts = useAppSelector((root) => root.court.conflicts.filter((item) => item.status !== "待重新确认"));
  return (
    <Card title="已重新确认记录">
      {conflicts.length === 0 && <p>暂无。</p>}
      {conflicts.map((conflict) => (
        <div className="snapshot" key={conflict.id}>
          <b>{conflict.evidenceId} · {fieldLabel(conflict.field)} · {conflict.status}</b>
          <small>{conflict.resolvedAt ? new Date(conflict.resolvedAt).toLocaleString("zh-CN") : ""}</small>
        </div>
      ))}
    </Card>
  );
}

function TimelinePage() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  return (
    <div className="timeline-grid">
      <Card title="庭审时间线">
        <ArcoTimeline>
          {state.timeline.map((item) => (
            <ArcoTimeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}>
              <b>{item.action}</b> <Tag>{item.actor as Party}</Tag><p>{item.detail}</p>
            </ArcoTimeline.Item>
          ))}
        </ArcoTimeline>
      </Card>
      <Card title="本地恢复点">
        <p>每次手动存档保留当前证据顺序和阶段；断网修改另有独立本地发件箱，不与在线版本互相覆盖。</p>
        {state.snapshots.map((item) => (
          <div className="snapshot" key={item.id}>
            <b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small>
            <Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button>
          </div>
        ))}
      </Card>
    </div>
  );
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { t, i18n } = useTranslation();

  // 初始化：登记服务端骨架（旧数据不带字段版本），启动合并引擎与本地持久化
  const booted = useRef(false);
  useEffect(() => {
    if (booted.current) return;
    booted.current = true;
    dispatch(initialize(store.getState().court.evidence));
    bootstrapServer(store.getState().court.evidence.map((item) => ({ id: item.id })));
    const syncEngine = startSyncEngine(store);
    const stopPersistence = startPersistence(store);
    return () => { syncEngine.destroy(); stopPersistence(); };
  }, [dispatch]);

  const metrics = useMemo(() => ({
    shown: state.evidence.filter((item) => item.status === "已展示").length,
    sensitive: state.evidence.filter((item) => item.sensitive).length,
    objections: state.objections.length,
    pending: state.outbox.filter((op) => op.status === "pending").length,
    conflicts: state.conflicts.filter((item) => item.status === "待重新确认").length
  }), [state]);

  return (
    <div className="shell">
      <aside>
        <div className="brand"><b>COURT</b><span>庭审控制</span></div>
        <nav>
          <NavLink to="/">{t("control")}</NavLink>
          <NavLink to="/evidence">证据目录</NavLink>
          <NavLink to="/conflicts">冲突核对</NavLink>
          <NavLink to="/timeline">{t("timeline")}</NavLink>
        </nav>
        <Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button>
      </aside>
      <main>
        <header>
          <div><small>案件号 2026-民初-1084 · 字段级版本审计</small><h1>{t("title")}</h1></div>
          <div className="top-tools">
            <label>模拟断网 <Switch checked={!state.sync.online} onChange={(value) => dispatch(setOnline(!value))} /></label>
            <Tag color={state.sync.online ? "green" : "orange"}>{state.sync.online ? "协作同步" : "离线暂存"}</Tag>
          </div>
        </header>
        <section className="metrics">
          <Card><Statistic title="证据总数" value={state.evidence.length} /></Card>
          <Card><Statistic title="已完成质证" value={metrics.shown} /></Card>
          <Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card>
          <Card><Statistic title="本地待合并 / 两边冲突" value={metrics.pending} suffix={`/ ${metrics.conflicts}`} /></Card>
        </section>
        <Routes>
          <Route path="/" element={<CourtControl />} />
          <Route path="/evidence" element={<EvidencePage />} />
          <Route path="/conflicts" element={<ConflictsPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
        </Routes>
      </main>
    </div>
  );
}
