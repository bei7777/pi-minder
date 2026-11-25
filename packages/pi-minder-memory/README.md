# pi-minder-memory

Pi 扩展提供个人 Markdown 记忆、会话摘要候选、来源记录和逐项审核。面向安装了 Node.js 22.19 或以上版本的 Pi 用户。

```sh
pi install npm:pi-minder-memory
```

助手使用 `minder_memory_search` 查询已接受的笔记，通过 `minder_memory_propose` 提议事实。会话结束时，扩展会根据当天的用户与助手文本拟定摘要，文件变更和来源都能在 Memory Diff 中审阅。

| 用户命令 | 功能 |
| --- | --- |
| `/minder-memory diff` | 检查当前会话的候选 |
| `/minder-memory commit [key]` | 接受一项或全部候选 |
| `/minder-memory discard [key]` | 放弃一项或全部候选 |
| `/minder-memory history` | 查看已提交的修订编号 |
| `/minder-memory show <id>` | 阅读该修订保存的原文、修改后内容和来源 |
| `/minder-memory revert <id>` | 恢复修订涉及的文档 |
| `/minder-memory search <query>` | 检索个人记忆 |

默认资料目录是 `~/.minder/memory`，设置 `MINDER_HOME` 可更改位置。嵌入 Pi SDK 时可调用 `createMemoryExtension({vaultDir})` 指定资料目录。
