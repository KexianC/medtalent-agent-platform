# 喻雯心理自评与趣味探索来源

核对日期：2026-09-08。

## 临床筛查工具

本版提供 GAD-7 焦虑自评，以及 PHQ-2 情绪简筛，面向 18 岁及以上成人。只呈现用户主动完成问卷后的筛查参考与同量表历史分数变化，不输出诊断、治疗方案或用药建议，不发送提醒或异常预警，也不自动向医生上传结果。

### 题干与简体中文

[INfORM / IADR 官方中文工具下载页](https://inform-iadr.com/index.php/tmd-assessmentdiagnosis/dc-tmd-translations/)提供中文译本，由 Kai-Yuan Fu、Adrian Yap 领衔翻译。

本实现核对的是该页面直接链接的[中文评价工具 PDF（2017-11-18 修订）](https://inform-iadr.com/wp-content/uploads/2024/03/DC-TMD-Chinese-Assessment-Instruments_revised-2017_11_18.pdf)，第 50 页 PHQ-9 的前两题和第 52 页 GAD-7 的全部七题及回答选项。题干照录该简体中文版本，不声称本软件已经完成新的临床效度验证。GAD-7 补充生活影响题在网页中调整了纸面作答指引，注明无相关问题时的选项，不参与总分。

译本署名：Fu KY, Yap AU, Lei J, Liu MQ, Fan XF，Peking University / Alexandra Hospital, Ng Teng Fong Hospital General and Jurong Medical Centre, Jurong Health Services, Singapore。原文件第 50、52 页直接注明可复制、翻译、展示、分发，无需许可。

参考文献：Ohrbach R, editor. Diagnostic Criteria for Temporomandibular Disorders: Assessment Instruments. Version 15May2016. [Chinese Version 25May2016]. Fu KY, Yap AU, Lei J, Liu MQ, Fan XF, Chai J, Trans. Accessed 2026-09-08.

### 许可与计分

[Pfizer / PHQ Screeners 官方手册](https://www.phqscreeners.com/images/sites/g/files/g10016261/f/201412/instructions.pdf)：

- 第 3 页定义 PHQ-2 为 PHQ-9 前两题；第 7 页允许通过选取相关题目从已有译本得到简版。
- 第 6 页：GAD-7 七题各 0–3 分，总分 0–21。5、10、15 分分别是轻、中、重度症状范围分界；10 分是进一步评估的参考分值。
- 第 6 页：PHQ-2 两题各 0–3 分，总分 0–6；3 分是进一步完整问卷及临床访谈的参考分值。实现不为 PHQ-2 自创严重程度分级。
- 第 2 页：生活影响补充题不参与分数或诊断计算。
- 第 8 页明确 PHQ 家族、简版与 GAD-7 均属于 public domain，复制、翻译、展示与分发无需许可。

[Pfizer 官方免费开放公告](https://www.pfizer.com/news/press-release/press-release-detail/pfizer_to_offer_free_public_access_to_mental_health_assessment_tools_to_improve_diagnosis_and_patient_care)也确认 PHQ、GAD-7 无版权限制、免费开放。

原量表作者：Robert L. Spitzer、Janet B.W. Williams、Kurt Kroenke 等，获 Pfizer Inc. 教育资助。

所有问题默认未选；缺答、非整数、越界或未知量表不能计分。GAD-7 补充题可记录 0–3 的生活影响选择，但明确不计入总分。低分不用于排除疾病，高分不用于确认疾病；同量表比较仅呈现数值差。

## MBTI 风格趣味探索

20 道题目与 16 型描述均为本项目自编，不复制正式 MBTI 试题，不声称得到 MBTI 官方认可，不属于正式 MBTI 测评，也未经心理测量验证。页面在开始前与结果处均明确说明。

按 E/I、S/N、T/F、J/P 四组生活偏好，每组 5 道二选一题；部分题目的左右选项调换。按对应偏好的票数统计，3 票以上选择该侧字母。因每组 5 题，不存在人为处理的平票。百分比仅表示本次选项占比，不能解释为人格强度、置信度或常模。所有 16 种组合都有对应描述。

## 趣味抽卡

保留用户提供 `YW.rar` 中八张卡的名称：愚者、魔术师、女祭司、皇后、皇帝、力量、隐士、命运之轮。替换为本项目编写的日常反思与鼓励文本，不作运势、未来、健康预测，不强化超自然解释或妄想内容，不加入付费或概率权益。

每次在 8 张卡中等概率独立抽取，页面明确可能重复。历史记录仅保存卡片标识与时间。
