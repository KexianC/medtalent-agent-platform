import type { KnowledgeDiagnostics } from '../../lib/knowledgeDiagnostics';
import { knowledgeCoverage } from '../../lib/knowledgeDiagnostics';
export function KnowledgeCoverage({data}: {data: KnowledgeDiagnostics}) {
 const coverage=knowledgeCoverage(data),s=data.summary;
 return <div aria-label="知识可检索覆盖"><div className={'platform-alert '+(coverage.warning?'is-warning':'is-success')} role={coverage.warning?'alert':'status'}><div><b>{coverage.title}</b><p>{coverage.detail}</p></div></div>
 {data.agentReasons&&data.agentReasons.length>0&&<ul>{data.agentReasons.map(reason=><li key={reason.code}>{reason.message}</li>)}</ul>}
 <div className="platform-detail-grid"><span>实际可检索资料<b>{s.searchableDocuments} / {s.documents}</b></span><span>实际可检索片段<b>{s.searchableChunks}</b></span><span>待人工审核<b>{s.reviewDocuments}</b></span><span>处理失败<b>{s.errorDocuments}</b></span><span>当前排除检索<b>{s.blockedDocuments}</b></span><span>排队／处理中<b>{s.queuedDocuments} / {s.processingDocuments}</b></span></div>
 <p className="platform-note">已解析片段共{s.totalChunks}个；审核通过{s.approvedDocuments}份。两者均不能替代当前可检索覆盖。</p>
 {data.capacity&&!data.capacity.allReviewFits&&<div className="platform-alert is-warning" role="alert">当前审核容量剩余{data.capacity.remaining}片段，待审核资料共{data.capacity.reviewChunks}片段；请按实际容量分批审核，未审核资料不会自动放行。</div>}
 {!!data.errorGroups.length&&<details><summary>失败分类与恢复建议</summary><ul>{data.errorGroups.map(group=><li key={group.code}><b>{group.label} · {group.count}份</b><p>{group.suggestion}</p></li>)}</ul></details>}
 </div>;
}
