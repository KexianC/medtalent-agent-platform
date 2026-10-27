import PlatformOperationsPanel from '../components/admin/PlatformOperationsPanel';
import KnowledgeGovernancePanel from '../components/admin/KnowledgeGovernancePanel';
import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Activity, ArrowLeft, Bot, CheckCircle2, Database, FileText, History, LayoutDashboard, Layers3, LogOut, Menu, Network, Package, Plus, RefreshCw, Search, Settings, ShieldCheck, Sparkles, Stethoscope, X } from 'lucide-react';
import { ApiError, errorMessage, platformApi, post, type AdminUser, type PlatformAgent, type PlatformSettings } from '../lib/platformApi';
import { EmptyState, ErrorBanner, Field, Loading, useAction, useResource } from '../components/admin/shared';
import BuilderConversation from '../components/admin/BuilderConversation';
import ConfigPackagePanel from '../components/admin/ConfigPackages';
import ChannelWorkbench from '../components/admin/ChannelWorkbench';
import AgentBulkActions from '../components/admin/AgentBulkActions';
import { TemplatesPanel } from '../components/admin/BuilderTemplates';
import AgentEditor, { createEmptyAgent } from '../components/admin/AgentEditor';
import { KnowledgePanel } from '../components/admin/Knowledge';
import { NasPanel } from '../components/admin/NasPanel';
import { AuditPanel, BatchPanel, ContentPanel, JobsPanel, OverviewPanel, SettingsPanel } from '../components/admin/Operations';
import './admin.css';
import { ConfirmationProvider, useConfirm } from '../components/admin/Confirmation';

type Section = 'agents' | 'templates' | 'studio' | 'packages' | 'channels' | 'platform-operations' | 'knowledge-governance' | 'overview' | 'batch' | 'knowledge' | 'nas' | 'content' | 'jobs' | 'audit' | 'settings';
const navigation: Array<{ id: Section; label: string; icon: typeof Bot; description: string }> = [
  { id: 'overview', label: '运营概览', icon: LayoutDashboard, description: '查看平台真实运行数据、知识处理进度与近期活动。' },
  { id: 'agents', label: '智能体管理', icon: Bot, description: '集中管理智能体的资料、角色、模型、知识来源与发布版本。' },
  { id: 'templates', label: '模板库', icon: Layers3, description: '复用专科配置与组件，通过模板参数快速创建独立智能体草稿。' },
  { id: 'studio', label: 'AI 搭建对话', icon: Sparkles, description: '多轮澄清需求、比较搭建方案，确认后才应用到智能体草稿。' },
  { id: 'packages', label: '配置包迁移', icon: Package, description: '导出脱敏配置包，检查依赖后以新身份导入独立草稿。' },
  { id: 'channels', label: '渠道候选', icon: Network, description: '创建本地候选、下载构建包并登记人工渠道回执。' },
  { id: 'batch', label: 'AI 批量建档', icon: Sparkles, description: '批量生成可编辑草稿，人工确认后入库，审核通过后再发布。' },
  { id: 'platform-operations', label: '机构与平台运营', icon: Settings, description: '按授权范围查看机构、成员、业务服务、审计和平台运行情况。' },
  { id: 'knowledge-governance', label: '知识治理与反馈', icon: ShieldCheck, description: '管理知识审核、有效期、来源与用户反馈处理。' },
  { id: 'knowledge', label: '知识库', icon: Database, description: '上传、审核和检索智能体的专属知识，追踪每一个来源。' },
  { id: 'nas', label: 'NAS 自动同步', icon: Network, description: '将绿联云 NAS 目录映射至对应智能体，按计划同步新增与变更文件。' },
  { id: 'content', label: '内容运营', icon: FileText, description: '维护文章、百问、通知与服务内容，按智能体独立发布。' },
  { id: 'jobs', label: '任务中心', icon: Activity, description: '查看文档处理、NAS 同步任务的实际进度，重试失败任务。' },
  { id: 'audit', label: '操作审计', icon: History, description: '追溯平台配置、发布和资料管理的操作记录。' },
];

export default function Admin() {
  return <ConfirmationProvider><AdminConsole /></ConfirmationProvider>;
}

function AdminConsole() {
  const confirm = useConfirm();
  const routeNavigate = useNavigate();
  const [user, setUser] = useState<AdminUser | null>();
  const [sessionError, setSessionError] = useState('');
  const [sessionRevision, setSessionRevision] = useState(0);
  const [section, setSection] = useState<Section>('agents');
  const [knowledgeTab,setKnowledgeTab] = useState<'documents'|'extractions'>('documents');
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSlug, setSelectedSlug] = useState('');
  const [selectionOwner,setSelectionOwner]=useState('');
  useEffect(()=>{if(!user){setSelectionOwner('');setSelectedSlug('');return}try{setSelectedSlug(window.localStorage.getItem('medtalent:admin-selected:v1:'+encodeURIComponent(user.id))||'')}catch{setSelectedSlug('')}setSelectionOwner(user.id)},[user]);
  useEffect(()=>{if(!user||selectionOwner!==user.id||!selectedSlug)return;try{window.localStorage.setItem('medtalent:admin-selected:v1:'+encodeURIComponent(user.id),selectedSlug)}catch{/* Selection is optional; draft persistence reports its own errors. */}},[selectedSlug,selectionOwner,user]);
  const [search, setSearch] = useState('');
  const [revision, setRevision] = useState(0);
  const [dirty, setDirty] = useState(false);
  const [creating, setCreating] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean }>();
  const notify = useCallback((text: string, error = false) => setMessage({ text, error }), []);
  const { busy, run } = useAction(notify);
  const agents = useResource<PlatformAgent[]>(user ? '/api/admin/agents' : null, revision);
  const settings = useResource<PlatformSettings>(user ? '/api/admin/settings' : null, revision);
  const current = agents.data?.find(agent => agent.slug === selectedSlug) || agents.data?.[0];
  const canEdit = !!user && user.role !== 'viewer';
  const isAdmin = user?.role === 'admin';
  const reload = () => setRevision(value => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setSessionError(''); setUser(undefined);
    platformApi<{ user: AdminUser }>('/api/admin/session', { signal: controller.signal }).then(result => setUser(result.user)).catch(error => {
      if (controller.signal.aborted) return;
      if (error instanceof ApiError && error.status === 401) setUser(null); else setSessionError(errorMessage(error));
    });
    return () => controller.abort();
  }, [sessionRevision]);
  useEffect(() => { const required = () => { setUser(null); setDirty(false); }; window.addEventListener('platform-auth-required', required); return () => window.removeEventListener('platform-auth-required', required); }, []);
  useEffect(() => { const beforeUnload = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = ''; } }; window.addEventListener('beforeunload', beforeUnload); return () => window.removeEventListener('beforeunload', beforeUnload); }, [dirty]);
  useEffect(() => { if (!message || message.error) return; const timer = window.setTimeout(() => setMessage(undefined), 5000); return () => window.clearTimeout(timer); }, [message]);
  const mayLeave = async () => !dirty || await confirm('存在尚未保存的修改。确认放弃这些修改？');
  const navigate = async (next: Section) => { if (next === section) { setSidebarOpen(false); return; } if (!await mayLeave()) return; setDirty(false); setSection(next); setSidebarOpen(false); setMessage(undefined); };
  const selectAgent = async (slug: string) => { if (!await mayLeave()) return; setDirty(false); setSelectedSlug(slug); };
  const title = section === 'settings' ? '系统设置' : navigation.find(item => item.id === section)?.label || '智能体配置中心';
  const description = section === 'settings' ? '检查模型、向量、语音与 NAS 的服务端连接配置。敏感凭据不在浏览器存储。' : navigation.find(item => item.id === section)?.description;
  if (sessionError) return <main className="agent-console platform-auth"><div className="platform-login"><ErrorBanner message={sessionError} onRetry={() => setSessionRevision(value => value + 1)} /><Link to="/">返回前台</Link></div></main>;
  if (user === undefined) return <main className="agent-console platform-auth"><Loading label="正在验证管理权限…" /></main>;
  if (!user) return <Login onLogin={value => { setUser(value); reload(); }} />;

  return <main className="agent-console">
    <div className={`agent-sidebar-backdrop ${sidebarOpen ? 'is-open' : ''}`} onClick={() => setSidebarOpen(false)} />
    <aside className={`agent-sidebar ${sidebarOpen ? 'is-open' : ''}`}>
      <div className="agent-brand"><span><Stethoscope size={21} /></span><div><b>有医说医</b><small>智能体管理中心</small></div><button type="button" onClick={() => setSidebarOpen(false)} aria-label="关闭菜单"><X size={18} /></button></div>
      <div className="agent-nav-label">工作台</div>
      <nav className="agent-nav" aria-label="后台导航">{navigation.map(({ id, label, icon: Icon }) => <button key={id} type="button" className={section === id ? 'active' : ''} onClick={() => navigate(id)} aria-current={section === id ? 'page' : undefined}><Icon size={18} /><span>{label}</span>{id === 'agents' && <small>{agents.data?.length ?? '—'}</small>}</button>)}</nav>
      <div className="agent-sidebar-footer"><button type="button" onClick={() => navigate('settings')}><Settings size={18} />系统设置</button><Link to="/" onClick={async event => { if (!dirty) return; event.preventDefault(); if (await mayLeave()) { setDirty(false); routeNavigate('/'); } }}><ArrowLeft size={18} />返回前台矩阵</Link><div className="agent-admin-user"><span>{user.name?.slice(0, 1) || '管'}</span><div><b>{user.name || user.username}</b><small>{{ admin: '平台管理员', editor: '内容编辑', viewer: '只读成员' }[user.role]}</small></div><ShieldCheck size={17} /></div></div>
    </aside>
    <section className="agent-main">
      <header className="agent-topbar"><button type="button" className="agent-menu-button" onClick={() => setSidebarOpen(true)} aria-label="打开菜单"><Menu size={20} /></button><div className="agent-breadcrumb"><span>医生智能体</span><i>/</i><b>{title}</b></div><label className="agent-global-search"><Search size={16} /><input aria-label="搜索智能体" placeholder="搜索名称、机构或专业" value={search} onChange={event => setSearch(event.target.value)} /></label><div className="agent-top-actions"><button type="button" disabled={busy || agents.loading} aria-label="刷新数据" title="刷新数据" onClick={async () => { if (await mayLeave()) { setDirty(false); reload(); } }}><RefreshCw size={18} /></button><button type="button" disabled={busy} aria-label="退出登录" title="退出登录" onClick={async () => { if (await mayLeave()) void run(async () => { await post('/api/auth/logout'); setUser(null); setDirty(false); }); }}><LogOut size={18} /></button></div></header>
      <div className="agent-content">
        {message && <div className={`platform-alert ${message.error ? 'is-error' : 'is-success'}`} role={message.error ? 'alert' : 'status'}><CheckCircle2 size={17} /><span>{message.text}</span><button type="button" aria-label="关闭提示" onClick={() => setMessage(undefined)}><X size={15} /></button></div>}
        <div className="agent-page-heading"><div><span className="agent-eyebrow">AGENT STUDIO</span><h1>{section === 'agents' ? '智能体配置中心' : title}</h1><p>{description}</p></div>{section === 'agents' && <div className="agent-heading-actions"><button className="agent-secondary-button" type="button" onClick={() => navigate('templates')}><Layers3 size={16} />从模板创建</button><button className="agent-secondary-button" type="button" disabled={!canEdit} onClick={() => navigate('batch')}><Sparkles size={16} />批量 AI 建档</button><button className="agent-primary-button" type="button" disabled={!canEdit} onClick={async () => { if (await mayLeave()) { setDirty(false); setCreating(true); } }}><Plus size={16} />新建智能体</button></div>}</div>
        {user.role === 'viewer' && <div className="platform-alert"><ShieldCheck size={16} /><span>当前账户为只读成员，可以查看数据，不能修改或发布。</span></div>}
        {agents.error && <ErrorBanner message={agents.error} onRetry={agents.reload} />}
        {(section === 'agents' || section === 'knowledge' || section === 'content') && !agents.loading && agents.data && <div className="platform-agent-picker"><label className="agent-field"><span>当前智能体</span><select value={current?.slug || ''} onChange={event => selectAgent(event.target.value)}>{agents.data.filter(agent => agent.slug === current?.slug || !search || `${agent.name} ${agent.hospital} ${agent.specialty}`.includes(search)).map(agent => <option key={agent.slug} value={agent.slug}>{agent.name} · {agent.department} · {agent.status === 'published' ? '已发布' : agent.status === 'archived' ? '已归档' : '草稿'}</option>)}</select></label>{search && <small>按“{search}”筛选并保留当前智能体；清空搜索可显示全部。</small>}</div>}
        {section === 'agents' && <AgentBulkActions agents={agents.data || []} canEdit={canEdit} dirty={dirty} onChanged={reload} notify={notify} />}
        {section === 'agents' && (agents.loading ? <Loading /> : current ? <AgentEditor key={`${current.slug}:${current.updatedAt}`} agent={current} canEdit={canEdit} canReview={isAdmin} draftOwnerId={user.id} onCreated={slug => { setDirty(false); setSelectedSlug(slug); reload(); }} settings={settings.data} onOpenKnowledgeGovernance={tab => {setKnowledgeTab(tab);void navigate('knowledge-governance')}} onOpenNas={() => void navigate('nas')} onDirty={setDirty} onSaved={() => { setDirty(false); reload(); }} notify={notify} /> : <EmptyState title="还没有智能体" detail="新建一个智能体，或用 AI 批量建档开始。" />)}
        {section === 'templates' && <TemplatesPanel key={revision} previewOwnerId={user.id} agents={agents.data || []} canEdit={canEdit} notify={notify} onDirty={setDirty} onCreated={slug => { setDirty(false); setSelectedSlug(slug); setSection('agents'); reload(); }} />}
        {section === 'studio' && <BuilderConversation agents={agents.data || []} canEdit={canEdit} notify={notify} onDirty={setDirty} onCreated={slug => { setDirty(false); setSelectedSlug(slug); setSection('agents'); reload(); }} />}
        {section === 'packages' && <ConfigPackagePanel agents={agents.data || []} canEdit={canEdit} notify={notify} onCreated={slug => { setDirty(false); setSelectedSlug(slug); setSection('agents'); reload(); }} />}
        {section === 'channels' && <ChannelWorkbench canEdit={isAdmin} notify={notify} />}
        {section === 'platform-operations' && <PlatformOperationsPanel agents={agents.data || []} user={user} notify={notify} />}
        {section === 'knowledge-governance' && <KnowledgeGovernancePanel key={(current?.slug || '')+':'+knowledgeTab} agents={agents.data || []} user={user} agentSlug={current?.slug || ''} initialTab={knowledgeTab} onSelectAgent={selectAgent} onOpenKnowledge={() => void navigate('knowledge')} />}
        {section === 'overview' && <OverviewPanel revision={revision} />}
        {section === 'batch' && <BatchPanel key={revision} canEdit={canEdit} aiConfigured={settings.data?.aiConfigured} notify={notify} onDirty={setDirty} onCreated={(slug) => { setDirty(false); setSelectedSlug(slug); setSection('agents'); reload(); }} />}
        {section === 'knowledge' && (agents.loading ? <Loading /> : current ? <KnowledgePanel key={current.slug} agentSlug={current.slug} canEdit={canEdit} notify={notify} onOpenGovernance={tab => {setKnowledgeTab(tab);void navigate('knowledge-governance')}} onOpenNas={() => void navigate('nas')} /> : <EmptyState title="请先创建智能体" />)}
        {section === 'nas' && <NasPanel agents={agents.data || []} canEdit={isAdmin} notify={notify} agentSlug={current?.slug || ''} onSelectAgent={selectAgent} onOpenKnowledge={slug => {void selectAgent(slug).then(() => navigate('knowledge'))}} />}
        {section === 'content' && (agents.loading ? <Loading /> : current ? <ContentPanel key={current.slug} agentSlug={current.slug} canEdit={canEdit} aiConfigured={settings.data?.aiConfigured} notify={notify} onDirty={setDirty} /> : <EmptyState title="请先创建智能体" />)}
        {section === 'jobs' && <JobsPanel canEdit={canEdit} notify={notify} />}
        {section === 'audit' && <AuditPanel revision={revision} />}
        {section === 'settings' && <SettingsPanel data={settings.data} loading={settings.loading} error={settings.error} reload={settings.reload} isAdmin={isAdmin} notify={notify} />}
      </div>
    </section>
    {creating && <CreateAgent busy={busy} onCancel={() => setCreating(false)} onCreate={agent => void run(async () => { const result = await post<PlatformAgent>('/api/admin/agents', agent); setCreating(false); setSelectedSlug(result.slug); setSection('agents'); reload(); }, '智能体草稿已创建，完成配置后可发布。')} />}
  </main>;
}

type SignupCapabilities={enabled:boolean;plans:Array<{id:string;name:string;priceCents:number;currency:string;quotas:{agents:number;users:number;storageBytes:number;monthlyRequests:number}}>};
function Login({ onLogin }: { onLogin: (user: AdminUser) => void }) {
  const [username, setUsername] = useState(''); const [password, setPassword] = useState(''); const [error, setError] = useState(''); const [busy, setBusy] = useState(false);const [signupNotice,setSignupNotice]=useState('');
  const signup=useResource<SignupCapabilities>('/api/signup/capabilities');
  const submit = async (event: FormEvent) => { event.preventDefault(); setBusy(true); setError(''); try { await post('/api/auth/login', { username, password }); const result = await platformApi<{ user: AdminUser }>('/api/admin/session'); onLogin(result.user); } catch (error) { setError(errorMessage(error)); } finally { setBusy(false); } };
  const loginForm=<form className="platform-login" onSubmit={submit}><div className="platform-login-brand"><Stethoscope size={28} /><span>有医说医</span></div><span className="agent-eyebrow">AGENT STUDIO</span><h1>登录管理中心</h1><p>统一管理智能体、知识库与 NAS 自动同步。</p>{error && <ErrorBanner message={error} />}{signupNotice&&<p role="status">{signupNotice}</p>}<Field label="账户"><input required autoComplete="username" value={username} onChange={event => setUsername(event.target.value)} autoFocus /></Field><Field label="密码"><input required type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} /></Field><button type="submit" className="agent-primary-button" disabled={busy}>{busy ? '正在登录…' : '安全登录'}</button><small>请使用部署时生成的管理员凭据登录，并在首次登录后更换独立强密码。</small><Link to="/">返回前台矩阵</Link></form>;
  return <main className="agent-console platform-auth">{signup.data?.enabled?<div style={{width:'min(420px, 100%)',display:'grid',gap:16}}>{loginForm}<SelfSignup capabilities={signup.data} onCreated={account=>{setUsername(account);setPassword('');setSignupNotice('免费机构已创建，请使用刚设置的密码登录。开通成功不会自动登录。')}}/></div>:loginForm}</main>;
}
function SelfSignup({capabilities,onCreated}:{capabilities:SignupCapabilities;onCreated:(username:string)=>void}){
 const [open,setOpen]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState('');const [value,setValue]=useState({username:'',name:'',tenantName:'',password:'',confirmPassword:'',planId:''});const freePlans=capabilities.plans.filter(plan=>plan.priceCents===0);const planId=freePlans.some(plan=>plan.id===value.planId)?value.planId:freePlans[0]?.id||'';const plan=freePlans.find(plan=>plan.id===planId);
 const submit=async(event:FormEvent)=>{event.preventDefault();if(busy)return;setError('');if(!plan){setError('当前没有可直接开通的免费套餐，请联系业务人员。');return}if(value.password!==value.confirmPassword){setError('两次输入的密码不一致。');return}setBusy(true);try{const result=await post<{status:string;user:{username:string}}>('/api/signup',{username:value.username,name:value.name,tenantName:value.tenantName,password:value.password,planId});if(result.status!=='created'||!result.user?.username)throw new Error('开通结果未确认，请联系平台核对同一账户，勿重复提交。');setValue({username:'',name:'',tenantName:'',password:'',confirmPassword:'',planId:''});setOpen(false);onCreated(result.user.username)}catch(reason){setError(errorMessage(reason))}finally{setBusy(false)}};
 return <details className="platform-login" open={open} onToggle={event=>setOpen(event.currentTarget.open)}><summary style={{cursor:'pointer',fontWeight:600}}>开通独立机构（免费方案）</summary><form onSubmit={submit} style={{display:'grid',gap:16}}><p>建立独立机构与管理员账户；仅免费套餐可自助开通，收费方案需另行确认业务开通和付款。</p>{error&&<ErrorBanner message={error}/>}<fieldset disabled={busy} style={{border:0,margin:0,padding:0,display:'grid',gap:16}}><Field label="机构名称"><input required maxLength={100} value={value.tenantName} onChange={event=>setValue({...value,tenantName:event.target.value})}/></Field><Field label="管理员显示名称"><input required maxLength={100} value={value.name} onChange={event=>setValue({...value,name:event.target.value})}/></Field><Field label="新账户" hint="3—80位字母、数字、点、下划线、@或连字符。"><input required pattern="[A-Za-z0-9_.@-]{3,80}" maxLength={80} autoComplete="username" value={value.username} onChange={event=>setValue({...value,username:event.target.value})}/></Field><Field label="设置独立密码" hint="至少12位；不要使用开发或示例密码。"><input required type="password" minLength={12} maxLength={1024} autoComplete="new-password" value={value.password} onChange={event=>setValue({...value,password:event.target.value})}/></Field><Field label="再次输入密码"><input required type="password" minLength={12} maxLength={1024} autoComplete="new-password" value={value.confirmPassword} onChange={event=>setValue({...value,confirmPassword:event.target.value})}/></Field><Field label="开通套餐"><select value={planId} onChange={event=>setValue({...value,planId:event.target.value})}>{!freePlans.length&&<option value="">当前无可开通的免费套餐</option>}{capabilities.plans.map(item=><option key={item.id} value={item.id} disabled={item.priceCents>0}>{item.name} · {item.priceCents===0?'免费':('¥'+(item.priceCents/100).toFixed(2)+'，待业务开通')}</option>)}</select></Field>{plan&&<p>免费方案额度：{plan.quotas.agents}个智能体、{plan.quotas.users}名成员、{Math.round(plan.quotas.storageBytes/1048576)}MiB知识与头像存储、每月{plan.quotas.monthlyRequests}次模型请求。外部服务是否可用以配置为准。</p>}<button type="submit" className="agent-primary-button" disabled={!planId}>{busy?'正在开通…':'创建免费机构与账户'}</button></fieldset></form></details>;
}

function CreateAgent({ busy, onCancel, onCreate }: { busy: boolean; onCancel: () => void; onCreate: (agent: PlatformAgent) => void }) {
  const [draft, setDraft] = useState(createEmptyAgent);
  const update = (key: string, value: string) => setDraft(current => ({ ...current, [key]: value }));
  return <div className="platform-modal-mask"><form className="platform-modal" role="dialog" aria-modal="true" aria-labelledby="create-agent-title" onSubmit={async event => { event.preventDefault(); onCreate(draft); }}><header><div><span className="agent-eyebrow">NEW AGENT</span><h2 id="create-agent-title">新建智能体草稿</h2></div><button className="platform-icon-button" type="button" onClick={onCancel} disabled={busy} aria-label="关闭"><X size={19} /></button></header><div className="platform-form-grid"><Field label="智能体名称 *"><input autoFocus required maxLength={80} value={draft.name} onChange={event => update('name', event.target.value)} /></Field><Field label="唯一标识 *" hint="3—64 位小写英文、数字或连字符；创建后不能修改。"><input required pattern="[a-z0-9][a-z0-9-]{1,62}[a-z0-9]" value={draft.slug} onChange={event => update('slug', event.target.value)} /></Field><Field label="专业 / 科室 *"><input required value={draft.department} onChange={event => update('department', event.target.value)} /></Field><Field label="机构"><input value={draft.hospital} onChange={event => update('hospital', event.target.value)} /></Field><Field label="专业方向 *" wide><input required value={draft.specialty} onChange={event => update('specialty', event.target.value)} /></Field></div><p className="platform-note">新建不会直接对外发布；请核验医生姓名、机构与资质的使用授权。</p><footer><button className="agent-secondary-button" type="button" onClick={onCancel} disabled={busy}>取消</button><button className="agent-primary-button" type="submit" disabled={busy}>{busy ? '正在创建…' : '创建草稿'}</button></footer></form></div>;
}
