# API 合约

所有路径相对平台同源地址。开发API默认8788，浏览器经Vite5174代理。请求/响应默认JSON；失败统一 `{ "error": "安全的用户提示", "code": "ERROR_CODE" }`。

管理API必须登录，浏览器使用 `credentials: "include"`。Cookie为HttpOnly、SameSite=Strict，生产Secure；写入检查Origin。也可由受信任服务携带环境变量中配置的 `x-admin-token`（生产至少32位），不要把令牌放在URL/前端代码。viewer只读，editor管理业务，admin另可管理账号。

## 身份与公开端点

| 方法/路径 | 作用 |
| --- | --- |
| GET /api/health | 服务、版本、存储健康信息 |
| GET /api/wechat/capabilities | 微信能力预留：协议版本及四项 `enabled:false` |
| GET /api/wechat/session | 消费者会话预留：`enabled:false, authenticated:false, user:null`；不复用后台身份 |
| POST /api/wechat/login | 登录兑换预留：501 `WECHAT_LOGIN_NOT_CONFIGURED`，不处理或回显凭证 |
| POST /api/auth/login | `{username,password}` → `{user,expiresAt}` 并写入会话cookie |
| POST /api/auth/logout | 撤销当前会话 |
| GET /api/admin/session | `{user:{id,username,name,role,active,createdAt}}`；未登录401 |
| GET /api/doctors | 完整展示字段的已发布智能体数组，可能是空数组 |
| GET /api/doctors/:slug | 已发布展示字段+`content`（只含published），不含config/systemPrompt |
| POST /api/chat | `{doctorSlug,message,history?,healthContext?}` → `{reply,model,citations,retrievalMode,crisis?}` |
| POST /api/chat/stream | 同上；`application/x-ndjson`，见下文 |
| POST /api/asr | WAV/其他支持音频二进制，最多3 MB → `{text}` |
| POST /api/tts | `{text}` → 音频二进制 |
| POST /api/tts/stream | `{text,speechRunId?}` → audio/done/error NDJSON |

问题最多2000字符。历史仅接受user/assistant并限制轮数和长度。唐医生健康摘要必须主动 `consent:true`，只接收有限近30天记录；服务端不持久化聊天正文/健康摘要。聊天与语音有按IP限流。AI、DeepSeek、Embedding 与 DashScope 的服务端密钥必须为 8—8192 位、无空白的可打印 ASCII；异常配置在连接供应商前返回安全错误。

NDJSON每行一个JSON事件：

```json
{"type":"meta","model":"configured-model","crisis":false}
{"type":"delta","text":"回答片段"}
{"type":"done","model":"configured-model","citations":[{"title":"资料.md"}],"retrievalMode":"lexical"}
```

错误可能在开始前以JSON/非2xx返回，也可能在流中以 `{type:"error",error,code}` 返回。没有done的截断流不能当作完整回复。唐劲松（`tang-jinsong`）按已完成安全检查的中文分句持续发送多个 `delta`，不等待整个模型回复结束；遇到跨帧凭据前缀、私钥、未闭合认证字段或 URL 等片段会暂缓或遮蔽，仍保留字数上限与最终完整提醒。其他医生继续完整接收、限长并遮蔽模型文本后发送一个安全 `delta` 和 `done`。`retrievalMode` 为 `none/lexical/hybrid`；公开普通/流式聊天的 `citations` 仅返回 `{title}`，不向用户浏览器发送正文片段、文档 ID、片段序号或检索得分。引用仅来自该智能体已审核资料。未配置模型返回503 `AI_NOT_CONFIGURED`，危机安全响应不依赖远程服务。

ASR 的最终文本会经过同一凭据遮蔽。TTS 普通响应支持供应商成功体内的内联 `audio.data`，以及 DashScope 北京结果桶的精确可信 `audio.url`；后者即使由上游返回 `http://` 也只会升级为 HTTPS 后下载，禁止凭据、非标准端口、片段与重定向，且不会转发服务端 Authorization。普通音频限制为 20 MiB，并校验 WAV/MP3 特征、媒体类型和当前环境凭据的原始字节。流式 TTS 只接受 SSE 内联 PCM，累计仍受 20 MiB 限制；每帧先检查完整凭据，保留可能跨帧组成凭据的尾部，再将可安全输出的完整 16 位采样即时发送为 `audio` 事件，完成后发送 `done`。客户端断开会取消上游；流中发生异常时立即结束并发送安全错误，已经播放的正常片段不会从头重播。异常输出使用 `UNSAFE_AUDIO_OUTPUT` / `UNSAFE_AUDIO_SOURCE` / `INVALID_AUDIO_OUTPUT` 等错误码。

微信预留接口、H5 SDK 与后续真实身份接入见 [WECHAT_BRIDGE.md](WECHAT_BRIDGE.md)。这些接口本次仅落本地源码，未随小程序 ZIP 部署到线上。

## 智能体

基础字段：`slug,name,hospital,department,title,specialty,intro,portrait,accent,accentSoft,quickQuestions[],topics[],services[],articles[]`。slug为3—64位小写字母/数字/连字符，创建后不能修改。

`config`：`systemPrompt,welcomeMessage,responseStyle,language,model,temperature,topP,maxTokens,ragEnabled,ragTopK,ragThreshold,requireCitations,healthContextEnabled`。管理端返回另有 `status,version,createdAt,updatedAt,publishedAt,hasUnpublishedChanges`。智能体响应是固定字段投影，不透传历史记录中的任意额外字段；公开端不返回 `config`，只返回欢迎语。发给聊天、提示词优化和内容生成供应商的智能体资料也先经过同一固定投影与凭据格式遮蔽。

| 方法/路径 | 作用 |
| --- | --- |
| GET /api/admin/agents | 包含草稿/发布/归档的固定字段管理数组 |
| POST /api/admin/agents | 创建单个草稿，201 |
| GET /api/admin/agents/:slug | 读取管理配置 |
| PUT /api/admin/agents/:slug | 更新白名单字段，只保存草稿 |
| POST /api/admin/agents/:slug/publish | 发布新版本，快照/版本/审计同事务 |
| POST /api/admin/agents/:slug/archive | 归档并停止公开目录/聊天访问 |
| GET /api/admin/agents/:slug/versions | `{version,publishedAt,name,actor}[]` |
| POST /api/admin/agents/:slug/rollback | `{version}`，只恢复草稿 |
| POST /api/admin/agents/:slug/optimize | `{prompt?}` → `{systemPrompt,mode:"ai"}`，不自动保存 |
| POST /api/admin/agents/:slug/chat | `{message,history?}`，用草稿配置调试；管理端保留详细引用片段用于核验 |
| POST /api/admin/agents/generate | `{brief,count,mode:"ai"或"template"}` → `{drafts,mode,warnings}`；不入库 |
| POST /api/admin/agents/batch | `{agents:[已人工编辑的草稿]}` → `{agents}`，全成功或全回滚，1—20个 |

模板批量输入每行可采用 `名称|机构|科室|专业方向|简介`。没有调用AI时明确返回template。AI返回缺字段/非法结构会报错而不是直接发布；AI 成功响应中的当前环境凭据、认证赋值和私钥块也会在字段校验和返回浏览器之前遮蔽。

## 文档与检索

文档字段：`id,agentSlug,name,mimeType,size,source,sourceId,sourcePath,status,approved,chunkCount,embeddingMode,warning,error,revision,createdAt,updatedAt,indexedAt,approvedAt,approvedBy`。API不返回私有 blob 路径、NAS 密码、原始校验和或历史额外字段。文档、片段、下载文件名和引用均使用固定字段与长度边界；可识别的认证赋值、Basic/Bearer、URL userinfo、私钥块以及当前服务端配置的凭据值会在输出和模型上下文前遮蔽。

状态：`queued → processing → review/ready`，失败为error，移除为deleted。仅approved且ready可检索。

| 方法/路径 | 作用 |
| --- | --- |
| GET /api/admin/documents?agentSlug= | 文档数组（不含软删除）；筛选必须是一个合法slug |
| POST /api/admin/agents/:slug/documents | multipart：`file`、可选字符串`approved=true`；50 MB → `{document,job}` |
| POST /api/admin/agents/:slug/documents/text | `{name,text,approved?}` → `{document,job}` |
| GET /api/admin/documents/:id | `{document,chunks:[{id,index,text}]}` |
| GET /api/admin/documents/:id/download | 鉴权下载未删除文档原件；软删除后返回410 |
| POST /api/admin/documents/:id/approve | 新管理端传 `{agentSlug,revision}` 绑定当前智能体与查看版本；旧调用可省略整个绑定，提供任一字段时必须同时提供二者 |
| POST /api/admin/documents/batch-review | `{agentSlug,action:"approve",documents:[{id,revision}]}`；同一智能体内逐项审核生效，每批最多100份并返回逐项结果 |
| POST /api/admin/documents/:id/reindex | 新管理端同时传 `{agentSlug,revision,strategy}`；旧调用仍可仅传 `{}` 或 `strategy`，`full` 重新读取原件，`reuseExistingChunks` 仅重算向量 |
| DELETE /api/admin/documents/:id | 新管理端传可选的 `{agentSlug,revision}` 后软删除；旧调用可省略整个绑定，提供任一字段时必须同时提供二者 |
| POST /api/admin/knowledge/search | `{agentSlug,query}` → `{mode,citations,warning?}`，只读检索测试 |

批量审核请求的 `documents` 原始数组限 1—100 项；相同 `id+revision` 会去重，同一 ID 携带冲突版本则整次请求以400拒绝且不写入。响应为 `{action,agentSlug,requested,succeeded,failed,results:[{id,revision,ok,document?|error?}]}`。可预期的单项业务冲突采用 best-effort 语义并返回 HTTP 200，未知系统错误会回滚该 HTTP 批次内已完成的文档状态及审计记录。只有成功项会写入 `document.approve`，每个批次另写一条不含正文的 `document.batch_review` 汇总审计。

同步/导入是异步：201/202只代表已落库排队，不代表解析成功。须查看document状态和job结果。未审核资料不会因索引存在就参与回答。新管理端的单条审核、重建和删除始终提交 `agentSlug+revision`；服务端会同时校验归属和版本。为兼容既有运维调用，单条接口允许整体省略这对绑定字段，但不接受只提供其中之一。批量审核始终强制当前列表中的文档 revision 快照：勾选后发生更新的资料会逐项返回 `DOCUMENT_REVISION_CONFLICT`；跨智能体、未完成解析、来源失效及会使生效片段超过25,000的资料不会发布。一次用户操作超过100份时，前端按100份顺序拆批，可能部分成功；只有版本未变且仍可审核的失败项会保留选择，版本变化者必须重新预览后勾选。NAS 文档还必须持续属于当前 source 的精确、大小写敏感子路径，且 source 不含旧版连接/凭据字段或范围冲突；否则新增、索引、审核与检索均 fail-closed。每来源及每智能体的累计文档数量/字节配额在新建和替换时执行，超限返回413；默认值与环境变量见部署文档。

## NAS 与任务

Source字段：`id,name,agentSlug,transport:"webdav"|"local"|"s3",path,enabled,autoPublish,deleteMissing,intervalMinutes,revision,lastSyncAt,lastStatus,lastError,syncFailureCount,scopeIssue`。`scopeIssue` 为 `null` 或 `{code,message}`；旧版非法路径、持久化连接字段、同 transport 重叠范围会显示问题并禁止测试、同步和相关知识发布。`syncFailureCount`仅返回内部重试队列的数量，不返回可能很大的路径/签名清单；`lastStatus`可能为`partial`，表示本轮未完整处理并会续跑。输入别名`minio`会规范化为`s3`。地址、bucket、region、账号和凭据只在服务端环境配置，请求体携带这些字段会被拒绝；管理员重新编辑保存会生成不含旧字段的规范记录。

| 方法/路径 | 作用 |
| --- | --- |
| GET /api/admin/nas | `{configured:{webdav,local,s3},s3:{endpoint,bucket,region,prefix,forcePathStyle,credentialConfigured},sources,runs}`；S3摘要不含任何凭据值 |
| POST /api/admin/nas/sources | 创建映射；启用时立即排队同步 |
| PUT /api/admin/nas/sources/:id | 更新映射，agentSlug保持不变 |
| DELETE /api/admin/nas/sources/:id | 停止映射，已导入文档保留 |
| POST /api/admin/nas/sources/:id/test | `{ok,files,complete,sample,warning?}`，只读扫描 |
| POST /api/admin/nas/sources/:id/sync | 排队/复用相同未完成任务，202 |
| GET /api/admin/jobs | 最新100个任务的固定字段：id/type/status/progress/attempts/maxAttempts/result/error/时间；不返回payload |
| POST /api/admin/jobs/:id/retry | 仅失败任务，手动重试次数不限；不会变更NAS原件 |

Job类型为`document.ingest`、`document.reembed`、`nas.sync`，状态为`queued/running/completed/failed`。`reuseExistingChunks` 仅允许状态为 review/ready/error、`approved=false` 且已有 1—3000 个完整片段的文档；它不读取原文件、不改变片段 ID/正文/顺序或人工审核标记，原 `error` 文档成功后会恢复为 `review`。它固定使用生产配置的 DashScope Embedding 端点、模型与维度。该任务与文档导入、NAS 同步及其它向量重建全局互斥；条件或向量响应不满足预期时整项失败，不提交部分向量。Job/result、同步 Run/stats 与审计 details 都按已知类型/动作白名单投影，不返回 payload 或任意旧字段；面向界面的历史运行错误使用通用提示，原始诊断只留在受控服务端日志。同步Run结果包含created/updated/unchanged/deleted/failed/scanned/complete、预算截断信息和受限错误列表。S3来源执行完整分页，并以ETag、LastModified、Size做版本签名与条件读取；分页或元数据不完整时`complete=false`。成功扫描并不保证文档已索引；后续索引任务另有状态。

若当前平台实例失去 `DATA_DIR` 单实例租约，所有 `/api/*` 请求返回503与 `PLATFORM_INSTANCE_LEASE_LOST`，写入和后台任务停止；响应仍带 `Cache-Control: no-store` 与安全响应头。

## 内容、账号、运营

Content字段：`id,agentSlug,title,summary,body,type:"article"|"faq"|"notice"|"service",status:"draft"|"published",tags,createdAt,updatedAt,publishedAt`。内容、账号、用量日期和发布版本同样是固定字段投影；非法旧角色不会获得权限，非法旧时间戳返回 `null`。

| 方法/路径 | 作用 |
| --- | --- |
| GET/POST /api/admin/content | 筛选读取 / 新建内容 |
| PUT/DELETE /api/admin/content/:id | 修改 / 删除；撤回相关过期知识 |
| POST /api/admin/content/:id/index | 将当前内容导入知识；未发布内容不能直接成为公开知识 |
| POST /api/admin/content/generate | `{agentSlug,brief,type}` → `{draft,mode:"ai"}`，不自动保存 |
| GET /api/admin/overview | stats/recentJobs/recentAudit/dailyUsage，均真实聚合 |
| GET /api/admin/audit | 最近100条审计 |
| GET /api/admin/settings | 模型/NAS/语音配置是否存在、版本、存储；不返回密钥 |
| GET/POST /api/admin/users | admin读取 / 创建成员 `{username,name,role,password}` |
| PUT /api/admin/users/:id | admin修改`name,role,active,password?`并撤销该用户会话；至少保留一个启用admin |

典型错误：400字段无效、401未登录、403无权限/来源不符、404记录不存在/智能体未发布、409冲突或状态不允许、413超限、415格式不支持、429限流、502上游/文档服务失败、503缺少模型/NAS配置或超出单节点容量。
