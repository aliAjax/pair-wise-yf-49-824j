import { useEffect, useMemo, useState } from "react";
import { Button, Card, Form, Input, Message, Modal, Radio, Select, Space, Statistic, Switch, Tag, Timeline, Tooltip } from "@arco-design/web-react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { useTranslation } from "react-i18next";
import { NavLink, Route, Routes } from "react-router-dom";
import { useGetEvidenceQuery } from "./store/api";
import { useAppDispatch, useAppSelector } from "./store/hooks";
import {
  addObjection, completeEvidence, initialize, reorder, resolveConflict, resolveObjection,
  restore, selectEvidence, setMode, setOnline, setPhase, showEvidence, snapshot, tick,
  toggleSensitive, updateNote
} from "./store/courtSlice";
import { retrySync, syncWithServer } from "./store/sync";
import type { Evidence, Party, SessionPhase } from "./types";

const objectionSchema = z.object({ ground: z.string().min(2), explanation: z.string().min(6) });
type ObjectionForm = z.infer<typeof objectionSchema>;

function formatTime(seconds: number) { return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`; }

const syncStatusMeta: Record<string, { color: string; label: string }> = {
  idle: { color: "green", label: "已同步" },
  syncing: { color: "blue", label: "同步中…" },
  offline: { color: "gray", label: "离线模式" },
  conflict: { color: "red", label: "冲突待确认" },
  error: { color: "red", label: "同步失败，重试中" }
};

/** 冲突字段对比行 */
function ConflictField({ label, local, server }: { label: string; local: string; server: string }) {
  const diff = local !== server;
  return (
    <div className="conflict-field">
      <span className="conflict-field-label">{label}</span>
      <div className="conflict-field-values">
        <span className={diff ? "diff" : ""}>{local || "—"}</span>
        <span className="conflict-arrow">⇄</span>
        <span className={diff ? "diff" : ""}>{server || "—"}</span>
      </div>
    </div>
  );
}

function CourtControl() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const [mode, setLocalMode] = useState<"控制" | "预览">("控制");
  const [objectionOpen, setObjectionOpen] = useState(false);
  const [noteEditOpen, setNoteEditOpen] = useState(false);
  const [noteEditTarget, setNoteEditTarget] = useState<Evidence | null>(null);
  const [noteValue, setNoteValue] = useState("");
  const current = state.evidence.find((item) => item.id === state.session.currentEvidenceId);
  const pending = state.objections.filter((item) => item.status === "待裁定");
  const hasConflict = state.conflicts.length > 0;
  const { control, handleSubmit, reset } = useForm<ObjectionForm>({ resolver: zodResolver(objectionSchema), defaultValues: { ground: "关联性异议", explanation: "" } });

  useEffect(() => { const timer = window.setInterval(() => dispatch(tick()), 1000); return () => window.clearInterval(timer); }, [dispatch]);
  const submitObjection = (values: ObjectionForm) => { if (!current) return; dispatch(addObjection({ evidenceId: current.id, ...values })); reset(); setObjectionOpen(false); Message.warning("异议已进入待裁定分支"); };

  const openNoteEdit = (item: Evidence) => { setNoteEditTarget(item); setNoteValue(item.note); setNoteEditOpen(true); };
  const saveNote = () => { if (noteEditTarget) { dispatch(updateNote({ id: noteEditTarget.id, note: noteValue })); setNoteEditOpen(false); setNoteEditTarget(null); } };

  return <div className="court-grid">
    <Card className="operator" title="证据操作台" extra={<Space><Tag color={state.online ? "green" : "red"}>{state.online ? "本地审计在线" : "离线恢复模式"}</Tag><Button size="small" onClick={() => dispatch(snapshot("手动存档"))}>保存快照</Button></Space>}>
      <div className="evidence-list">{state.evidence.map((item, index) => <article key={item.id} draggable onDragStart={(event) => event.dataTransfer.setData("text/plain", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData("text/plain")); const items = [...state.evidence]; const [moved] = items.splice(from, 1); items.splice(index, 0, moved); dispatch(reorder(items)); }} className={current?.id === item.id ? "active" : ""}>
        <span>{index + 1}</span>
        <div>
          <b>{item.exhibitNo} · {item.title}</b>
          <small>{item.type} · {item.presenter} · {item.duration}分钟</small>
          {item.pendingReview && <Tag color="orange" size="small">待确认</Tag>}
        </div>
        <Tag color={item.status === "已展示" ? "green" : item.status === "展示中" ? "orange" : "gray"}>{item.status}</Tag>
        <Space>
          <Button size="mini" onClick={() => dispatch(selectEvidence(item.id))}>选中</Button>
          <Button size="mini" onClick={() => openNoteEdit(item)}>备注</Button>
        </Space>
      </article>)}</div>
      <div className="control-strip">
        <Button type="primary" onClick={() => dispatch(showEvidence())} disabled={!current}>开始展示</Button>
        <Button onClick={() => dispatch(completeEvidence())} disabled={!current}>完成并切换下一条</Button>
        <Button status="warning" onClick={() => setObjectionOpen(true)} disabled={!current}>提出异议</Button>
        <Button onClick={() => dispatch(toggleSensitive(current?.id ?? ""))} disabled={!current}>{current?.sensitive ? "恢复敏感内容" : "隐藏敏感内容"}</Button>
      </div>
    </Card>
    <div className="side-stack">
      <Card title="公开屏预览" extra={<Select size="small" value={mode} onChange={(value) => { setLocalMode(value as "控制" | "预览"); dispatch(setMode(value === "预览" ? "公开屏预览" : "庭审控制")); }} options={[{ value: "控制", label: "控制者视图" }, { value: "预览", label: "公开屏" }]} />} className="preview-card">
        {hasConflict ? (
          <div className="public-screen blocked">
            <small>同步拦截</small>
            <h3>同步冲突待确认</h3>
            <p>公开屏已拦截：{state.conflicts.length} 项证据存在双方修改冲突，请先在冲突列表中确认保留版本。</p>
            <Button type="primary" onClick={() => dispatch(setMode("庭审控制"))}>前往处理</Button>
          </div>
        ) : (
          <div className="public-screen">{mode === "预览" ? <><small>公开展示</small><h2>{current?.exhibitNo ?? "暂无证据"}</h2><h3>{current?.title ?? "庭审进行中"}</h3>{current?.sensitive ? <div className="redaction"><b>敏感内容已遮罩</b><p>该证据包含不适宜公开的信息，庭审结束后统一入卷。</p></div> : <p>{current?.note}</p>}<footer>计时 {formatTime(state.session.timerSeconds)} · {state.session.phase}</footer></> : <><small>控制者私有视图</small><h2>敏感内容可预览</h2><p>{current?.sensitive ? "此证据将在公开屏遮罩客户名称，控制者可查看完整备注。" : "当前证据可完整公开。"}</p><Tag color="red">操作端专属</Tag></>}</div>
        )}
      </Card>
      <Card title="待审异议" extra={<Tag color="red">{pending.length}</Tag>}>{pending.map((item) => <div className="objection" key={item.id}><b>{item.ground}</b><p>{item.explanation}</p><Space><Button size="mini" status="success" onClick={() => dispatch(resolveObjection({ id: item.id, status: "支持" }))}>支持并跳过</Button><Button size="mini" onClick={() => dispatch(resolveObjection({ id: item.id, status: "驳回" }))}>驳回继续</Button></Space></div>)}{!pending.length && <p>当前没有待裁定异议。</p>}</Card>
    </div>

    {/* 异议提出弹窗 */}
    <Modal title="提出证据异议" visible={objectionOpen} onCancel={() => setObjectionOpen(false)} onOk={() => handleSubmit(submitObjection)()}><Form layout="vertical"><Form.Item label="异议类型"><Controller name="ground" control={control} render={({ field }) => <Select {...field} options={[{ value: "关联性异议", label: "关联性异议" }, { value: "真实性异议", label: "真实性异议" }, { value: "合法性异议", label: "合法性异议" }]} />} /></Form.Item><Form.Item label="异议说明"><Controller name="explanation" control={control} render={({ field }) => <Input.TextArea {...field} placeholder="说明异议依据和希望法庭裁定的事项" />} /></Form.Item></Form></Modal>

    {/* 备注编辑弹窗 */}
    <Modal title="编辑证据备注" visible={noteEditOpen} onCancel={() => setNoteEditOpen(false)} onOk={saveNote} okText="保存"><Input.TextArea value={noteValue} onChange={(value) => setNoteValue(value)} placeholder="输入证据备注" rows={4} /></Modal>

    {/* 冲突解决弹窗 */}
    <Modal
      title="同步冲突 — 双方修改了同一项"
      visible={hasConflict}
      footer={null}
      style={{ width: 720, maxWidth: "90vw" }}
      maskClosable={false}
    >
      <p className="conflict-tip">以下证据在离线期间被双方修改过，请确认保留版本。确认后公开屏将恢复展示。</p>
      {state.conflicts.map((conflict) => {
        const local = conflict.localVersion;
        const server = conflict.serverVersion;
        return (
          <div className="conflict-card" key={conflict.id}>
            <h4>{local.exhibitNo} · {local.title}</h4>
            <ConflictField label="编号" local={local.exhibitNo} server={server.exhibitNo} />
            <ConflictField label="标题" local={local.title} server={server.title} />
            <ConflictField label="备注" local={local.note} server={server.note} />
            <ConflictField label="遮罩" local={local.sensitive ? "已遮罩" : "未遮罩"} server={server.sensitive ? "已遮罩" : "未遮罩"} />
            <ConflictField label="顺序" local={String(local.order)} server={String(server.order)} />
            <div className="conflict-actions">
              <Button type="primary" onClick={() => { dispatch(resolveConflict({ id: conflict.id, keep: "local" })); dispatch(syncWithServer()); }}>保留本地版本</Button>
              <Button onClick={() => { dispatch(resolveConflict({ id: conflict.id, keep: "server" })); dispatch(syncWithServer()); }}>保留服务器版本</Button>
            </div>
          </div>
        );
      })}
    </Modal>

    <Card title="庭审阶段" className="phase-card"><Radio.Group value={state.session.phase} onChange={(value) => dispatch(setPhase(value as SessionPhase))}><Radio value="开庭">开庭</Radio><Radio value="举证">举证</Radio><Radio value="质证">质证</Radio><Radio value="休庭">休庭</Radio><Radio value="结束">结束</Radio></Radio.Group></Card>
  </div>;
}

function TimelinePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <div className="timeline-grid"><Card title="庭审时间线"><Timeline>{state.timeline.map((item) => <Timeline.Item key={item.id} label={new Date(item.time).toLocaleTimeString("zh-CN", { hour12: false })}><b>{item.action}</b> <Tag>{item.actor}</Tag><p>{item.detail}</p></Timeline.Item>)}</Timeline></Card><Card title="本地恢复点"><p>每次手动存档或关键操作都会保留当前证据顺序和阶段。</p>{state.snapshots.map((item) => <div className="snapshot" key={item.id}><b>{item.label}</b><small>{new Date(item.time).toLocaleString("zh-CN")}</small><Button size="mini" onClick={() => dispatch(restore(item.id))}>恢复</Button></div>)}</Card></div>;
}

function EvidencePage() {
  const state = useAppSelector((root) => root.court);
  const dispatch = useAppDispatch();
  return <Card title="证据目录与公开属性"><div className="catalog">{state.evidence.map((item) => <article key={item.id}><div><b>{item.exhibitNo} {item.title}</b><p>{item.note}</p>{item.pendingReview && <Tag color="orange" size="small">待确认（旧数据）</Tag>}</div><Tag>{item.type}</Tag><div className="switch-line"><span>公开屏敏感遮罩</span><Switch checked={item.sensitive} onChange={() => dispatch(toggleSensitive(item.id))} /></div></article>)}</div></Card>;
}

export default function App() {
  const dispatch = useAppDispatch();
  const state = useAppSelector((root) => root.court);
  const { data = [] } = useGetEvidenceQuery();
  const { t, i18n } = useTranslation();

  useEffect(() => { if (data.length) dispatch(initialize(data)); }, [data, dispatch]);

  // 联网时自动同步
  useEffect(() => {
    if (state.online && state.initialized) {
      dispatch(syncWithServer());
    }
  }, [state.online, state.initialized, dispatch]);

  // 在线时定期同步（每30秒）
  useEffect(() => {
    if (!state.online) return;
    const timer = window.setInterval(() => { dispatch(syncWithServer()); }, 30000);
    return () => window.clearInterval(timer);
  }, [state.online, dispatch]);

  // 同步失败时自动重试
  useEffect(() => {
    if (state.syncStatus === "error" && state.online) {
      dispatch(retrySync());
    }
  }, [state.syncStatus, state.online, dispatch]);

  const metrics = useMemo(() => ({
    shown: state.evidence.filter((item) => item.status === "已展示").length,
    sensitive: state.evidence.filter((item) => item.sensitive).length,
    objections: state.objections.length,
    pending: state.pendingChanges.length,
    conflicts: state.conflicts.length
  }), [state]);

  const syncMeta = syncStatusMeta[state.syncStatus] ?? syncStatusMeta.idle;

  return <div className="shell"><aside><div className="brand"><b>COURT</b><span>庭审控制</span></div><nav><NavLink to="/">{t("control")}</NavLink><NavLink to="/evidence">证据目录</NavLink><NavLink to="/timeline">{t("timeline")}</NavLink></nav><Button onClick={() => void i18n.changeLanguage(i18n.language === "zh" ? "en" : "zh")}>{i18n.language === "zh" ? "EN" : "中文"}</Button></aside><main><header><div><small>案件号 2026-民初-1084 · 全流程审计开启</small><h1>{t("title")}</h1></div><div className="top-tools">
    <label>本地恢复 <Switch checked={!state.online} onChange={(value) => dispatch(setOnline(!value))} /></label>
    <Tag color={state.online ? "green" : "orange"}>{state.online ? "协作同步" : "离线操作"}</Tag>
    <Tooltip content={state.lastSyncedAt ? `上次同步：${new Date(state.lastSyncedAt).toLocaleString("zh-CN")}` : "尚未同步"}>
      <Tag color={syncMeta.color}>{syncMeta.label}</Tag>
    </Tooltip>
    {state.pendingChanges.length > 0 && <Tag color="blue">待同步 {state.pendingChanges.length}</Tag>}
    {state.conflicts.length > 0 && <Tag color="red">冲突 {state.conflicts.length}</Tag>}
    <Button size="small" type="primary" onClick={() => dispatch(syncWithServer())} loading={state.syncStatus === "syncing"}>立即同步</Button>
  </div></header><section className="metrics"><Card><Statistic title="证据总数" value={state.evidence.length} /></Card><Card><Statistic title="已完成质证" value={metrics.shown} /></Card><Card><Statistic title="敏感证据" value={metrics.sensitive} /></Card><Card><Statistic title="待同步修改" value={metrics.pending} /></Card></section><Routes><Route path="/" element={<CourtControl />} /><Route path="/evidence" element={<EvidencePage />} /><Route path="/timeline" element={<TimelinePage />} /></Routes></main></div>;
}
