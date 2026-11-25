# pi-minder-snapshot

此扩展将 Pi 的文件读取、写入、编辑以及 Minder 的移动和删除工具接入事务。默认写入范围是会话工作目录，支持已有父目录中的普通文件。Pi 受管工具在同一任务中读取暂存内容，任务完成后发布 File Diff。异常结束会放弃写入。

```sh
pi install npm:pi-minder-snapshot
```

使用 `/minder-files` 列出事务，用 `/minder-files <id>` 查看修改。使用 `/minder-undo` 撤销最近一次已提交的事务，也可以提供准确编号。Undo 检查文件内容和权限，遇到用户后续编辑会提示冲突。

超过单文件快照上限的写入、删除需在交互界面单独确认。确认只执行该项操作并记录元信息。此类操作无法恢复原文件。受管配置只允许事务工具和 Minder 的查询及记忆提议工具；会话内的 Shell 被禁止。安装的第三方 Node.js 扩展仍以当前用户权限运行。

默认状态目录是 `~/.minder/snapshot`。嵌入 Pi SDK 时可调用 `createSnapshotExtension({stateDir,roots})`。多个文件的发布按文件逐次替换，外部程序可能在切换期间观察到部分结果。
