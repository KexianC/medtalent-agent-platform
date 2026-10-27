# 业务集成复用来源与本地边界

日期：2026-10-23。依照用户“自行在其他项目找一下有无可以复用的”的要求，本轮只读检查已有项目后复用了下列算法或协议语义。没有修改这些参考项目，也未复制其商户密钥、账号、短信模板或生产配置。

## 微信支付算法移植

来源：D:/项目/健康科普专委会小程序/apps/api/src/domains/commerce/wechat-pay.ts，第14—21行的WeChatPay核心实现。原文件SHA-256：35c73fab23757b7b5ae783d5051eb2c5d40f7adc72705e3d97ca49e49b9f9edf。

本项目server/business-providers.mjs移植改造了RSA请求签名、响应及通知验签、JSAPI预支付签名、订单查询、AES-GCM通知解密，去掉Nest依赖并增加本项目的显式开关、商户/订单/金额匹配校验。复用范围是协议算法，不代表原商城或原商户已经为本项目开通。

未取得或核验可用于本项目的BUSINESS_WECHAT商户证书、平台公钥、APIv3密钥等完整配置；真实支付默认关闭，没有向真实商户创建订单、支付、退款或发送通知。

## 随访提醒协议借鉴

来源：D:/项目/减重管理平台重建/apps/api/src/sms-delivery.ts，第47—121行的isFollowUpConfigured、followUpParameters、sendFollowUpReminder。原文件SHA-256：3852f719550eac0e072c76d8cf3bbabfdcf55b79e784fdd4acdd48062997acfc。

仅借鉴配置完整性检查、明确accepted及具名回执、UNKNOWN不盲目重试的语义。本项目采用business-providers.mjs中的webhook适配与platform-business.mjs中的订阅授权、幂等及状态流程；没有照搬原短信SDK、原模板编号或服务账号，不能称为接入了旧项目短信服务。

目前没有已确认可直接用于本项目的外部预约webhook授权、订阅webhook和模板绑定；真实通知默认关闭。本地人工unknown回执与提供商实际受理分开记录。

## 本项目新增与内部沿用

预约排班、容量、申请和后台确认、授权人工接管及消息、套餐账单和invoice由本项目新实现；没有找到并确认能直接复用的其他项目预约或完整计费平台。内部沿用现有ConsumerStore、微信登录桥接、会话与CSRF规则。免费开通和机构隔离已本地验收；收费套餐在线激活、续费、升级、欠费、对账及实际发票开具仍待接通。

## 已有验证

server/platform-business.test.mjs覆盖合成RSA/AES支付通知、金额/商户/订单匹配、具名回执与未知状态；最终完整自动化为1039项、1037通过、2跳过、0失败。consumer-browser-receipt.json覆盖本地预约、授权人工接管、双向消息与撤销访问。上述均不能替代真实商户与外部业务验收。

Redis/Qdrant复用调查与限制见distributed-runtime-local.md。完整需求状态见BUILDER_P1P2_REASSESSMENT_20261023.md；本地验收与回滚见BUILDER_P1P2_LOCAL_ACCEPTANCE_20261023.md。