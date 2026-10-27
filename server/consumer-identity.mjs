import {timingSafeEqual} from "node:crypto";
import {ConsumerStore,consumerHash} from "./consumer-store.mjs";
import {PlatformError} from "./domain.mjs";
/** Consumer identity is deliberately independent from all administrator credentials. */
export async function requireConsumerSession(database,req,{csrf=false}={}){
 const token=String(req.headers?.cookie||"").split(";").map(part=>part.trim()).find(part=>part.startsWith("medtalent_consumer="))?.slice(19)||"";
 const session=await new ConsumerStore(database).session(token);
 if(!session?.user_id)throw new PlatformError("请先使用微信登录。",401,"CONSUMER_UNAUTHENTICATED");
 if(csrf){const supplied=String(req.get?.("x-csrf-token")||req.headers?.["x-csrf-token"]||""),expected=consumerHash("medtalent-consumer-csrf:"+token);if(!/^[a-f0-9]{64}$/.test(supplied)||!timingSafeEqual(Buffer.from(supplied),Buffer.from(expected)))throw new PlatformError("登录状态校验失败，请刷新后重试。",403,"INVALID_CSRF")}
 return {token,session,userId:session.user_id};
}
