# @minder/core-memory

使用 `new MemoryStore(vaultDir)` 打开 Markdown 记忆目录。受审阅的记忆保存在 `core/`、`active/` 和按 UTC 日期分组的 `episodic/`。每份文档的 YAML front matter 保存稳定键、来源与分类，短期记忆还需要带时区的 `expiresAt`。文件可以在 Obsidian 中直接编辑。

调用 `begin(sessionId)` 和 `propose(sessionId, input)` 产生候选。用 `diff(sessionId)` 审阅原文和修改后的内容。`commit(sessionId, [key])` 接受指定事实，省略键列表时接受全部；`discard(sessionId, key)` 放弃指定候选。`history()` 列出修订，`revert(id)` 生成反向修订。候选产生后修改原文件会触发冲突，此时可以放弃旧候选并重新提出。

`proposeEpisode(sessionId, turns)` 从 UTC 当天的用户与助手文字中提取最近十二条摘录，保留消息引用供审阅。`expire()` 将过期的 Active Context 移入 `archive/`。`search(query)` 检索已接受的现行文档；索引支持中文片段和英文短语，短于三个字符的查询使用子串匹配。

`.minder/memory.sqlite` 保存候选、审核历史和恢复日志，应随 Markdown 文档一起备份。`.minder/index.sqlite` 是可重建的全文索引。关闭全部连接后可删除索引文件，再次打开即可重建。结束使用时调用 `close()`。
