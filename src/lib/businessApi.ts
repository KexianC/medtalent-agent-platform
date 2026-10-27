export type BusinessCapabilities = { payment: 'configured' | 'not_configured'; subscription: 'configured' | 'not_configured'; subscriptionTemplateId: string | null; externalAppointment: 'configured' | 'not_configured'; appointments?: 'internal' | 'external' | 'not_configured' };
export type BusinessSettings = { enabled: boolean; appointmentMode: 'internal' | 'external'; priceCents: number; currency: string };
export type BusinessSlot = { id: string; label: string; startAt: string; endAt: string; capacity: number; enabled: boolean; priceCents?: number; remaining?: number };
export type BusinessAppointment = { id: string; label: string; slotId: string; startAt: string; endAt: string; status: string; priceCents: number; currency: string; note?: string; receiptId?: string; userAlias?: string; createdAt: string };
export type HandoffMessage = { id: string; role: 'consumer' | 'staff'; text: string; createdAt: string };
export type BusinessHandoff = { id: string; status: string; assignedTo: string | null; messages: HandoffMessage[]; userAlias?: string; healthShared?: boolean; createdAt: string; updatedAt: string };
export type BusinessOrder = { id: string; number: string; title: string; appointmentId: string; amountCents: number; status: string; createdAt: string; paidAt?: string; userAlias?: string };
export type BusinessSubscription = { id: string; templateId: string; appointmentId: string | null; status: string; receiptId?: string; createdAt: string; userAlias?: string };
export type BusinessProposal = { id: string; tool: 'read_health_summary' | 'prepare_appointment' | 'create_handoff'; arguments: {slotId?: string; note?: string; message?: string}; status: string; expiresAt: string; error?: string; result?: unknown };
export type BusinessOverview = { settings?: BusinessSettings; consent?: {handoff: boolean; shareHealth: boolean}; slots: BusinessSlot[]; appointments: BusinessAppointment[]; handoffs: BusinessHandoff[]; orders: BusinessOrder[]; subscriptions: BusinessSubscription[]; proposals?: BusinessProposal[]; capabilities: BusinessCapabilities };
export type BusinessInvoice = {id:string;tenantId:string;period:string;amountCents:number;status:string;paymentStatus:string;issuedAt:string;lines:Array<{title:string;quantity:number;unitPriceCents:number;totalCents:number}>};
export const businessStatusLabel = (status: string) => ({requested:'待处理',confirmed:'已确认',cancelled:'已取消',rejected:'未受理',submitting:'提交中',unknown:'结果待核对',active:'人工接管中',closed:'已结束',revoked:'授权已撤回',creating:'创建中',pending:'待支付',paid:'已支付',failed:'失败',accepted:'已受理',proposed:'待本人确认',executing:'执行中',completed:'已执行',open:'待结算',settled:'已结算',not_required:'无需付款',not_configured:'尚未配置'}[status] || status);
export const businessMoney = (cents: number) => '¥' + (cents / 100).toFixed(2);
export const businessDate = (value: string) => Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', {hour12:false}) : value;
export const businessIdempotencyKey = () => 'business-' + crypto.randomUUID();
export async function consumerBusinessRequest<T>(slug: string, suffix: string, {method = 'GET', body, identity, signal, fetchImpl = fetch}: {method?: 'GET' | 'POST' | 'PUT' | 'DELETE'; body?: unknown; identity: {userId:string;csrfToken:string}; signal?: AbortSignal; fetchImpl?: typeof fetch}): Promise<T> {
 if (!/^[a-z0-9-]{3,64}$/.test(slug) || !/^([/][A-Za-z0-9_-]+)*$/.test(suffix)) throw new Error('业务请求路径无效。');
 if (!identity.userId || method !== 'GET' && !identity.csrfToken) throw new Error('登录状态已失效，请重新确认账户。');
 const response = await fetchImpl('/api/user/business/' + encodeURIComponent(slug) + suffix, {method,credentials:'include',cache:'no-store',signal,headers:{...(method==='GET'?{}:{'Content-Type':'application/json','X-CSRF-Token':identity.csrfToken})},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const payload: unknown = await response.json().catch(()=>null);
 if(!response.ok) throw new Error(payload && typeof payload==='object' && 'error' in payload && typeof payload.error==='string' ? payload.error : '业务操作未完成，请刷新同一记录核对。');
 return payload as T;
}
