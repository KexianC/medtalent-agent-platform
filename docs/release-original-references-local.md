# P07 发布版本原件引用本地修复（2026-10-23）

发布应用快照时，原件引用索引与版本描述符在同一数据库事务提交。索引保存在现有 builder.releases.<slug> 元数据中，机构命名空间沿用 t.<tenant>: 前缀，不新增业务表，也不复制供应商配置或患者报告。

每个版本新增 blobIndexVersion、blobReferences、blobReferencesSha256。引用仅包含 agentSlug、documentId、revision、storageKey、checksum、size。校验智能体归属、UUID.bin键、整数大小/版本及摘要绑定；知识替换或软删除后仍受已发布历史版本引用保护。

- GC 同时核查全平台当前文档与已发布版本引用。KnowledgeService 的 blobReferenceDatabase 注入原始数据库，仅用于内部清理；普通知识读写仍使用原有授权数据库。
- 旧快照缺索引时，先校验快照归属及canonical摘要，再幂等补入索引。随后逐次GC仅读数据库索引，不反复读取最大256MB的快照文件；迁移/索引异常时暂停删除。
- 发布失败会回滚描述符和索引，并删除未提交快照文件。
- 恢复草稿前及实际发布恢复时均验证原件存在、普通文件类型、大小和SHA-256。错误为 RELEASE_ORIGINAL_MISSING、RELEASE_ORIGINAL_REFERENCE_MISSING 或 RELEASE_ORIGINAL_INTEGRITY_FAILED，明确要求有效备份补齐，不把只有文本的恢复称作完整恢复。
- 继续保留每个智能体100个应用版本上限，没有引入自动归档或删除历史版本。

本地定向回归：server/release-blob-references.test.mjs、builder-lifecycle.test.mjs、knowledge-storage.test.mjs 共30项通过，包含真实原件替换、完整恢复后再次读取原件、GC仅删除孤儿、跨租户当前及历史原件保留、旧快照一次迁移、发布失败无残留、stage到publish之间丢文件的重新校验。备份模块已复用同一引用parser，并独立验证历史原件备份恢复。

仅本地修改与验收；未上传、部署或修改生产。
