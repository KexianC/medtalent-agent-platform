import { useEffect, useMemo, useState } from 'react';
import { Cloud, KeyRound, Network, Plus, RefreshCw, X } from 'lucide-react';
import {
  errorMessage,
  formatTime,
  getNasAdminStatus,
  post,
  put,
  remove,
  type NasAdminStatus,
  type NasSource,
  type NasTestResult,
  type PlatformAgent,
} from '../../lib/platformApi';
import { NAS_TRANSPORT_OPTIONS, nasSourcePathError, nasTransportLabel, toNasS3Display } from '../../lib/nasConnectors';
import { Checks, EmptyState, ErrorBanner, Field, Loading, Panel, Status, useAction, useResource } from './shared';
import { useConfirm } from './Confirmation';

import type { KnowledgeDiagnostics } from '../../lib/knowledgeDiagnostics';
import { KnowledgeCoverage } from './KnowledgeCoverage';
type Notify = (message: string, error?: boolean) => void;
type SourceTestResult = NasTestResult & { id: string };

const emptySource = (agentSlug: string): NasSource => ({
  id: '',
  name: '',
  agentSlug,
  transport: 'webdav',
  path: '',
  enabled: true,
  autoPublish: false,
  intervalMinutes: 5,
  deleteMissing: false,
});

function connectionStatus(configured: boolean, health: 'healthy' | 'error' | 'unknown') {
  if (!configured) return 'not_configured';
  if (health === 'healthy') return 'ready';
  if (health === 'error') return 'error';
  return 'configured';
}

function sourceFileCount(result: NasTestResult) {
  if (Array.isArray(result.files)) return result.files.length;
  return typeof result.files === 'number' && Number.isFinite(result.files) && result.files >= 0 ? result.files : undefined;
}

export function NasPanel({ agents, canEdit, notify, agentSlug, onSelectAgent, onOpenKnowledge }: { agents: PlatformAgent[]; canEdit: boolean; notify: Notify; agentSlug?: string; onSelectAgent?: (slug: string) => void | Promise<void>; onOpenKnowledge?: (slug: string) => void }) {
  const confirm = useConfirm();
  const resource = useResource<NasAdminStatus>('/api/admin/nas');
  const [localSlug,setLocalSlug]=useState('');
  const selectedSlug=agentSlug || localSlug || agents[0]?.slug || '';
  const diagnostics=useResource<KnowledgeDiagnostics>(selectedSlug?'/api/admin/knowledge/diagnostics?agentSlug='+encodeURIComponent(selectedSlug):null);
  const reloadNasDiagnostics=diagnostics.reload;
  useEffect(()=>{if(resource.data)reloadNasDiagnostics()},[resource.data,reloadNasDiagnostics]);
  const visibleSources=(resource.data?.sources || []).filter(source=>!selectedSlug||source.agentSlug===selectedSlug);
  const sourceIds=new Set(visibleSources.map(source=>source.id));
  const visibleRuns=(resource.data?.runs || []).filter(item=>sourceIds.has(item.sourceId));
  const [form, setForm] = useState<NasSource>();
  const [testResult, setTestResult] = useState<SourceTestResult>();
  const { busy, run } = useAction(notify);
  useEffect(()=>{setForm(undefined);setTestResult(undefined)},[selectedSlug]);

  useEffect(() => {
    const controller = new AbortController();
    const timer = window.setInterval(() => {
      void getNasAdminStatus(controller.signal).then(resource.setData).catch(() => undefined);
    }, 10000);
    return () => { controller.abort(); window.clearInterval(timer); };
  }, [resource.setData]);

  const s3Display = useMemo(() => toNasS3Display(resource.data?.s3), [resource.data?.s3]);
  const testedS3Source = testResult && resource.data?.sources.find((source) => source.id === testResult.id && source.transport === 's3');
  const s3Health = testedS3Source ? (testResult?.ok ? 'healthy' : 'error') : s3Display.health;
  const s3Configured = Boolean(resource.data?.configured?.s3);
  const s3Capabilities = s3Display.capabilities.length
    ? s3Display.capabilities.join('、')
    : s3Configured ? '列出对象、读取对象、同步入库（需通过连接测试确认）' : '配置完成后可执行连接测试';

  const update = (key: keyof NasSource, value: unknown) => {
    setForm((current) => current ? ({ ...current, [key]: value }) : current);
  };

  const save = async () => {
    if (!form) return;
    const pathError = nasSourcePathError(form.transport, form.path);
    if (pathError) {
      notify(pathError, true);
      return;
    }
    if (form.autoPublish && !await confirm('此映射启用了知识自动审核生效。今后该目录或对象前缀的新增、修改文件可能直接进入检索，确定仅有受信任人员可以写入？')) return;
    if (form.deleteMissing && !await confirm('此映射启用了同步删除。NAS 文件或对象消失时，对应知识将被移除。确认启用？')) return;
    void run(async () => {
      if (form.id) await put(`/api/admin/nas/sources/${encodeURIComponent(form.id)}`, form);
      else await post('/api/admin/nas/sources', form);
      setForm(undefined);
      resource.reload();
    }, 'NAS / 对象存储映射已保存。');
  };

  return <div className="platform-stack">
    <Panel
      title="绿联云 NAS 与对象存储映射"
      description="支持 WebDAV、服务器本地挂载和 MinIO / S3。连接地址、存储桶与凭据统一由服务端环境变量注入，浏览器不会接收访问密钥。"
      action={<button className="agent-primary-button" type="button" disabled={!canEdit || !agents.length || busy} onClick={() => setForm(emptySource(selectedSlug))}><Plus size={15} />新增映射</button>}
    >
      <Field label="当前智能体"><select value={selectedSlug} disabled={busy||!agents.length} onChange={event=>{setTestResult(undefined);if(onSelectAgent)void onSelectAgent(event.target.value);else setLocalSlug(event.target.value)}}>{!agents.length&&<option value="">请选择</option>}{agents.map(agent=><option key={agent.slug} value={agent.slug}>{agent.name}</option>)}</select></Field>
      {selectedSlug&&(diagnostics.loading?<Loading label="正在核验当前医生知识覆盖…"/>:diagnostics.error?<ErrorBanner message="知识覆盖暂未核验；连接成功或同步完成不代表资料已经审核可检索。" onRetry={diagnostics.reload}/>:diagnostics.data?.agentSlug===selectedSlug&&<KnowledgeCoverage data={diagnostics.data}/>)}
      {selectedSlug&&onOpenKnowledge&&<button type="button" disabled={busy} onClick={()=>onOpenKnowledge(selectedSlug)}>查看该医生知识与人工审核</button>}
      <div className="platform-alert"><Network size={18} /><span>NAS 上传或对象写入 → 定时扫描变化 → 对应智能体解析入库 → 人工审核 → 参与 RAG 检索。默认 5 分钟同步一次。</span></div>
      {!canEdit && <p className="platform-note">仅平台管理员可以配置和执行存储映射操作。</p>}

      {resource.data && <>
        <div className="platform-connection-strip" aria-label="存储连接器配置状态">
          <span>WebDAV <Status value={resource.data.configured?.webdav ? 'configured' : 'not_configured'} /></span>
          <span>本地挂载 <Status value={resource.data.configured?.local ? 'configured' : 'not_configured'} /></span>
          <span>MinIO / S3 <Status value={connectionStatus(s3Configured, s3Health)} /></span>
        </div>
        <section className="platform-s3-summary" aria-labelledby="s3-summary-title">
          <header>
            <div><Cloud size={18} /><div><b id="s3-summary-title">MinIO / S3 服务端配置</b><p>公开连接摘要，仅显示非敏感配置。</p></div></div>
            <Status value={connectionStatus(s3Configured, s3Health)} />
          </header>
          <dl>
            <dt>Endpoint</dt><dd><code>{s3Display.endpoint}</code></dd>
            <dt>Bucket</dt><dd><code>{s3Display.bucket}</code></dd>
            <dt>Region</dt><dd>{s3Display.region}</dd>
            <dt>全局前缀</dt><dd><code>{s3Display.prefix}</code></dd>
            <dt>寻址方式</dt><dd>{s3Display.pathStyle === 'path' ? 'Path-style（适配 MinIO）' : s3Display.pathStyle === 'virtual-hosted' ? 'Virtual-hosted-style' : '由 NAS_S3_FORCE_PATH_STYLE 注入'}</dd>
            <dt>访问凭据</dt><dd className="platform-sensitive-status"><KeyRound size={13} />{(s3Display.credentialConfigured ?? s3Configured) ? '已在服务端配置，密钥不回显' : '未配置或不完整'}</dd>
            <dt>连接健康</dt><dd>{s3Health === 'healthy' ? '最近检测正常' : s3Health === 'error' ? '最近检测失败，请查看映射结果' : '尚未检测；请对一个 S3 映射执行“测试连接”'}{s3Display.checkedAt ? ` · ${formatTime(s3Display.checkedAt)}` : ''}</dd>
            <dt>同步能力</dt><dd>{s3Capabilities}</dd>
          </dl>
          <p className="platform-note"><code>NAS_S3_ENDPOINT / NAS_S3_REGION / NAS_S3_BUCKET / NAS_S3_PREFIX / NAS_S3_FORCE_PATH_STYLE</code><br />访问凭据由 <code>NAS_S3_ACCESS_KEY_ID / NAS_S3_SECRET_ACCESS_KEY</code> 注入，只展示“已配置 / 未配置”。</p>
        </section>
      </>}

      {resource.loading ? <Loading /> : resource.error ? <ErrorBanner message={resource.error} onRetry={resource.reload} /> : visibleSources.length ? <div className="platform-source-grid">
        {visibleSources.map((source) => {const coverage=diagnostics.data?.agentSlug===selectedSlug?diagnostics.data.sources?.find(item=>item.id===source.id):undefined;return <article className="platform-source" key={source.id}>
          <header><div><b>{source.name}</b><p>{agents.find((agent) => agent.slug === source.agentSlug)?.name || source.agentSlug}</p></div><Status value={source.scopeIssue ? 'error' : source.lastStatus === 'never' ? 'idle' : source.lastStatus} /></header>
          <dl>
            <dt>连接方式</dt><dd>{nasTransportLabel(source.transport)}</dd>
            <dt>{source.transport === 's3' ? '桶内前缀' : '相对目录'}</dt><dd>{source.path?'已配置相对映射（编辑时核对）':'使用已配置的根目录'}</dd>
            <dt>同步计划</dt><dd>{source.enabled ? `每 ${source.intervalMinutes} 分钟` : '已暂停'}</dd>
            <dt>内容审核</dt><dd>{source.autoPublish ? '自动审核生效' : '人工审核'}</dd>
            <dt>同步删除</dt><dd>{source.deleteMissing ? '启用' : '不删除'}</dd>
            <dt>最近同步</dt><dd>{formatTime(source.lastSyncAt)}</dd>
          </dl>
          {source.scopeIssue && <div className="platform-inline-result is-error" role="alert"><b>映射已暂停</b><p>{source.scopeIssue.message}</p></div>}
          {source.lastError && <p className="platform-error-text">上次同步失败或未完整完成，请核对来源配置和下方安全计数。</p>}
          <p className="platform-note">平台已入库{coverage?.documentCount??'待核验'}份，当前可检索{coverage?.searchableDocuments??'待核验'}份，失败{coverage?.errorDocuments??'待核验'}份。读取失败候选{source.syncFailureCount??'未知'}个。</p>
          {coverage&&<p className="platform-note">近期同步窗口：扫描{coverage.scanned??'未知'}个，读取失败{coverage.failed??'未知'}个，完整扫描{coverage.complete===true?'是':coverage.complete===false?'否':'未知'}。平台当前候选为0不证明物理NAS没有资料。</p>}
          <div className="platform-row-actions">
            <button type="button" disabled={!canEdit || busy} onClick={() => setForm({ ...source })}>编辑映射</button>
            <button type="button" disabled={!canEdit || busy || Boolean(source.scopeIssue)} title={source.scopeIssue ? '请先编辑并修复映射范围问题' : undefined} onClick={() => void run(async () => {
              try {
                const result = await post<NasTestResult>(`/api/admin/nas/sources/${encodeURIComponent(source.id)}/test`);
                setTestResult({ id: source.id, ...result });
              } catch (error) {
                setTestResult({ id: source.id, ok: false, files: 0, warning: errorMessage(error) });
                throw error;
              }
            }, '连接测试已完成，请查看结果。')}>测试连接</button>
            <button type="button" disabled={!canEdit || busy || Boolean(source.scopeIssue)} title={source.scopeIssue ? '请先编辑并修复映射范围问题' : undefined} onClick={() => void run(async () => {
              await post(`/api/admin/nas/sources/${encodeURIComponent(source.id)}/sync`);
              resource.reload();
            }, '同步任务已提交，可在任务中心查看进度。')}>立即同步</button>
            <button type="button" className="platform-danger" disabled={!canEdit || busy} onClick={async () => {
              if (await confirm(`确认删除“${source.name}”的同步映射？该操作不删除 NAS 或存储桶中的原始文件。`)) void run(async () => {
                await remove(`/api/admin/nas/sources/${encodeURIComponent(source.id)}`);
                resource.reload();
              }, '存储映射已删除。');
            }}>删除映射</button>
          </div>
          {testResult?.id === source.id && <div className={`platform-inline-result ${testResult.ok ? '' : 'is-error'}`} role="status">
            <b>{testResult.ok ? '连接成功' : '连接未通过'}</b>
            <p>可访问文件 / 对象：{String(sourceFileCount(testResult) ?? '未返回统计')}{testResult.complete === false ? '（扫描未完整完成）' : ''}</p>
            {testResult.warning && <p>本次连接检测有警告，请检查来源配置；检测结果不代表解析或审核通过。</p>}
            {testResult.sample?.length ? <small>已返回{Math.min(testResult.sample.length,5)}个抽样文件；路径不在此回显。</small> : null}
          </div>}
        </article>})}
      </div> : <EmptyState title="还没有存储映射" detail="当前智能体没有平台存储映射。请先核对目标医生和授权来源再创建；这不表示物理NAS没有资料。" />}
    </Panel>

    <Panel title="近期同步记录" action={<button className="agent-secondary-button" type="button" disabled={resource.loading} onClick={resource.reload}><RefreshCw size={14} />刷新</button>}>
      {visibleRuns.length ? <div className="platform-table-wrap"><table className="platform-table"><thead><tr><th>映射</th><th>状态</th><th>开始时间</th><th>完成时间 / 详情</th></tr></thead><tbody>{visibleRuns.map((item) => <tr key={item.id}><td>{resource.data?.sources.find((source) => source.id === item.sourceId)?.name || item.sourceId}</td><td><Status value={item.status} /></td><td>{formatTime(item.startedAt || item.createdAt)}</td><td>{formatTime(item.finishedAt)}{item.error && <small className="platform-error-text">本次同步未完成，请核对来源配置。</small>}<p>同步结果仅表示本轮扫描与入库任务状态；解析、人工审核和当前可检索覆盖分别核验。</p><SafeSyncCounters item={item}/> </td></tr>)}</tbody></table></div> : <EmptyState title="暂无同步记录" />}
    </Panel>

    {form && <div className="platform-modal-mask"><form className="platform-modal" role="dialog" aria-modal="true" aria-labelledby="nas-form-title" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <header><div><span className="agent-eyebrow">STORAGE SYNC</span><h2 id="nas-form-title">{form.id ? '编辑存储映射' : '新增存储映射'}</h2></div><button type="button" className="platform-icon-button" disabled={busy} aria-label="关闭映射表单" onClick={() => setForm(undefined)}><X size={19} /></button></header>
      <div className="platform-form-grid">
        <Field label="映射名称 *"><input autoFocus required value={form.name} onChange={(event) => update('name', event.target.value)} /></Field>
        <Field label="目标智能体 *" hint={form.id ? '已创建映射不可更换目标智能体。' : undefined}><select required value={form.agentSlug} disabled={!!form.id} onChange={(event) => update('agentSlug', event.target.value)}>{agents.map((agent) => <option value={agent.slug} key={agent.slug}>{agent.name}</option>)}</select></Field>
        <Field label="连接方式"><select value={form.transport} onChange={(event) => update('transport', event.target.value)}>{NAS_TRANSPORT_OPTIONS.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}</select></Field>
        <Field label="同步间隔（分钟）"><input required type="number" min={1} max={1440} value={form.intervalMinutes} onChange={(event) => update('intervalMinutes', Number(event.target.value))} /></Field>
        <Field
          label={form.transport === 's3' ? 'Bucket 内相对前缀 *' : 'NAS 相对目录'}
          wide
          hint={form.transport === 's3'
            ? '必填。相对于服务端 NAS_S3_BUCKET 与可选 NAS_S3_PREFIX，例如 doctors/gong-wenbo；不能使用绝对路径、空前缀或 ..。'
            : '相对于服务端配置的根目录，例如 doctors/gong-wenbo。留空为根目录；不能使用绝对路径或 ..。'}
        ><input
          key={form.transport}
          required={form.transport === 's3'}
          value={form.path}
          onChange={(event) => { event.currentTarget.setCustomValidity(''); update('path', event.target.value); }}
          onInvalid={(event) => event.currentTarget.setCustomValidity('请填写该智能体在 Bucket 内的相对前缀。')}
          placeholder="doctors/gong-wenbo"
        /></Field>
      </div>
      {form.transport === 's3' && <div className="platform-alert"><Cloud size={17} /><span>Endpoint、Bucket、Region、全局前缀和 Path-style 均由服务端环境变量管理；此处仅配置该智能体在 Bucket 内的相对前缀。Access Key 与 Secret Key 不会由 API 返回。</span></div>}
      <Checks values={[
        { key: 'enabled', label: '开启定时同步', detail: '后台按所设间隔扫描目录或对象前缀。', checked: form.enabled },
        { key: 'autoPublish', label: '知识自动审核生效', detail: '仅适用于受控、可信且已完成内容审查的来源；默认关闭。', checked: form.autoPublish },
        { key: 'deleteMissing', label: '同步删除缺失文件', detail: '源文件或对象删除后移除对应知识；默认关闭以防误删。', checked: form.deleteMissing },
      ]} onChange={(key, value) => update(key as keyof NasSource, value)} disabled={busy} />
      <footer><button type="button" className="agent-secondary-button" disabled={busy} onClick={() => setForm(undefined)}>取消</button><button className="agent-primary-button" type="submit" disabled={!canEdit || busy}>{busy ? '正在保存…' : '保存映射'}</button></footer>
    </form></div>}
  </div>;
}

function SafeSyncCounters({item}:{item:import('../../lib/platformApi').SyncRun}) {const stats=item.stats&&typeof item.stats==='object'?item.stats as Record<string,unknown>:{};const labels:Record<string,string>={scanned:'扫描',attempted:'尝试读取',created:'新增入库',updated:'更新入库',unchanged:'未变化',failed:'读取失败',deferred:'留待下轮',skipped:'跳过'};return <details><summary>本轮安全计数</summary><dl>{Object.entries(labels).map(([key,label])=><div key={key}><dt>{label}</dt><dd>{typeof stats[key]==='number'?String(stats[key]):'未知'}</dd></div>)}<dt>完整扫描</dt><dd>{stats.complete===true?'是':stats.complete===false?'否':'未知'}</dd></dl><p>未返回或未纳入候选的文件不能推定为成功；平台候选0不等于物理NAS无资料。</p></details>;}
