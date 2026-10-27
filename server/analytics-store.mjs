import {PlatformError} from './domain.mjs';

export const ANALYTICS_RETENTION_DAYS = 90;
export const ANALYTICS_QUERY_MAX_EVENTS = 250000;
export const analyticsSqliteSchema = `CREATE TABLE IF NOT EXISTS analytics_events (
  id TEXT PRIMARY KEY, event_type TEXT NOT NULL, agent_slug TEXT, tenant_id TEXT,
  actor_kind TEXT, actor_hash TEXT, created_at TEXT NOT NULL, test_traffic INTEGER NOT NULL,
  safe_json TEXT NOT NULL CHECK (json_valid(safe_json))
);
CREATE INDEX IF NOT EXISTS analytics_created ON analytics_events(created_at,id);
CREATE INDEX IF NOT EXISTS analytics_scope ON analytics_events(tenant_id,agent_slug,created_at,id);
CREATE INDEX IF NOT EXISTS analytics_actor ON analytics_events(actor_kind,actor_hash,created_at);`;
export const analyticsMysqlStatements = [`CREATE TABLE IF NOT EXISTS analytics_events (
    id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    event_type VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    agent_slug VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
    tenant_id VARCHAR(100) CHARACTER SET ascii COLLATE ascii_bin NULL,
    actor_kind VARCHAR(40) CHARACTER SET ascii COLLATE ascii_bin NULL,
    actor_hash CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NULL,
    created_at CHAR(24) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    test_traffic TINYINT(1) NOT NULL,
    safe_json LONGTEXT CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
    PRIMARY KEY (id), KEY analytics_created (created_at,id),
    KEY analytics_scope (tenant_id,agent_slug,created_at,id),
    KEY analytics_actor (actor_kind,actor_hash,created_at),
    CONSTRAINT analytics_safe_json CHECK (JSON_VALID(safe_json))
  ) ENGINE=InnoDB DEFAULT CHARACTER SET=utf8mb4 COLLATE=utf8mb4_bin`];
const invalid=()=>{throw new PlatformError('统计事件或查询范围无效。',400,'INVALID_ANALYTICS_QUERY');};
export function analyticsDate(value){if(typeof value!=='string'||value.length>40||!Number.isFinite(Date.parse(value)))invalid();return new Date(value).toISOString();}
const safeText=(value,max)=>typeof value==='string'?value.replace(/[\u0000-\u001f\u007f]/g,'').slice(0,max):null;
const token=(value,pattern,max)=>value===null||value===undefined?null:typeof value==='string'&&value.length<=max&&pattern.test(value)?value:invalid();
const finite=(value,max=1e9)=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=max?value:null;
export function normalizeAnalyticsEvent(input){
 if(!input||typeof input!=='object'||Array.isArray(input))invalid();
 const id=token(input.id,/^[A-Za-z0-9_.:-]+$/,100);if(!id)invalid();
 if(!['agent-view','chat-request','login-complete','tenant-signup','model-call'].includes(input.type))invalid();
 const event={id,type:input.type,agentSlug:token(input.agentSlug,/^[a-z0-9]+(?:-[a-z0-9]+)*$/,64),tenantId:token(input.tenantId,/^[A-Za-z0-9_-]+$/,100),actorKind:input.actorKind===undefined||input.actorKind===null?null:['browser-session','authenticated-user'].includes(input.actorKind)?input.actorKind:invalid(),actorHash:token(input.actorHash,/^[a-f0-9]{24}$/,24),createdAt:analyticsDate(input.createdAt),testTraffic:input.testTraffic===true};
 const metadata={};
 for(const key of ['success'])if(typeof input[key]==='boolean')metadata[key]=input[key];
 if(Number.isSafeInteger(input.httpStatus)&&input.httpStatus>=100&&input.httpStatus<=599)metadata.httpStatus=input.httpStatus;
 if(input.type==='model-call'){
  metadata.requestId=token(input.requestId,/^[A-Za-z0-9_.:-]+$/,100);
  metadata.operation=safeText(input.operation,200);metadata.model=safeText(input.model,150);
  for(const key of ['inputTokens','outputTokens','totalTokens'])metadata[key]=Number.isSafeInteger(input[key])?finite(input[key]):null;
  metadata.estimatedCost=finite(input.estimatedCost,1e12);metadata.currency='CNY';metadata.costType=metadata.estimatedCost===null?'unavailable':'configured-price-estimate';
  metadata.usageSource=input.usageSource==='provider-response'?'provider-response':'not-provided';metadata.latencyMs=finite(input.latencyMs,86400000);
 }
 return {...event,...metadata};
}
export function analyticsRow(event){const normalized=normalizeAnalyticsEvent(event);const {id,type,agentSlug,tenantId,actorKind,actorHash,createdAt,testTraffic,...metadata}=normalized;return [id,type,agentSlug,tenantId,actorKind,actorHash,createdAt,testTraffic?1:0,JSON.stringify(metadata)];}
export function analyticsEventFromRow(row){return {...JSON.parse(row.safe_json),id:row.id,type:row.event_type,agentSlug:row.agent_slug,tenantId:row.tenant_id,actorKind:row.actor_kind,actorHash:row.actor_hash,createdAt:row.created_at,testTraffic:Boolean(Number(row.test_traffic))};}
const slugList=value=>{if(!Array.isArray(value)||value.length>5000)invalid();return [...new Set(value.map(item=>token(item,/^[a-z0-9]+(?:-[a-z0-9]+)*$/,64)||invalid()))];};
export function buildAnalyticsQuery(options={}){
 if(!options||typeof options!=='object'||Array.isArray(options))invalid();const clauses=[],parameters=[];
 const bind=(sql,values)=>{clauses.push(sql);parameters.push(...values);};
 for(const [key,operator] of [['from','>='],['to','<=']])if(options[key])bind('e.created_at'+operator+'?',[analyticsDate(options[key])]);
 if(options.from&&options.to&&analyticsDate(options.from)>analyticsDate(options.to))invalid();
 if(options.includeTest!==true)clauses.push('e.test_traffic=0');
 const agents=list=>{const values=slugList(list);bind(values.length?'e.agent_slug IN ('+values.map(()=>'?').join(',')+')':'0=1',values);};
 if(options.agentSlugs!==undefined)agents(options.agentSlugs);
 if(options.scope!==undefined&&options.scope!==null){const scope=options.scope;if(!scope||typeof scope!=='object'||Array.isArray(scope))invalid();const tenant=token(scope.tenantId,/^[A-Za-z0-9_-]+$/,100);if(!tenant)invalid();bind('e.tenant_id=?',[tenant]);agents(scope.agentSlugs);}
 return {where:clauses.length?' WHERE '+clauses.map(clause=>'('+clause+')').join(' AND '):'',parameters};
}
export function assertAnalyticsQuerySize(total){if(Number(total)>ANALYTICS_QUERY_MAX_EVENTS)throw new PlatformError('统计查询超过25万条事件，请缩小日期范围或选择智能体；平台不会截断统计。',413,'ANALYTICS_QUERY_TOO_LARGE');}
// The first activity is computed over the full retained window, before selecting the requested cohort dates.
export function buildAnalyticsRetentionQuery(options,day,dialect='sqlite'){
 if(![1,7,30].includes(day))invalid();const from=analyticsDate(options.from),to=analyticsDate(options.to),windowFrom=analyticsDate(options.windowFrom);
 const query=buildAnalyticsQuery({...options,from:windowFrom,to});
 const target=dialect==='mysql'?`DATE_ADD(CAST(SUBSTR(c.first_at,1,10) AS DATE), INTERVAL ${day} DAY)`:`DATE(c.first_at,'+${day} days')`;
 return {sql:'WITH scoped AS (SELECT e.actor_kind,e.actor_hash,e.created_at FROM analytics_events e'+query.where+' AND e.actor_hash IS NOT NULL), first_activity AS (SELECT actor_kind,actor_hash,MIN(created_at) first_at FROM scoped GROUP BY actor_kind,actor_hash), cohort AS (SELECT * FROM first_activity WHERE first_at>=? AND first_at<=?) SELECT COUNT(*) eligible,COALESCE(SUM(CASE WHEN EXISTS (SELECT 1 FROM scoped activity WHERE activity.actor_kind=c.actor_kind AND activity.actor_hash=c.actor_hash AND SUBSTR(activity.created_at,1,10)='+target+') THEN 1 ELSE 0 END),0) returned FROM cohort c WHERE '+target+'<=?',parameters:[...query.parameters,from,to,to.slice(0,10)]};
}
