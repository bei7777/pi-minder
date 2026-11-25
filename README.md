# Minder for Pi

本仓库发布三个独立的 Pi 扩展及其对应的 TypeScript 核心包。Node.js 22.19 或更高版本；应用数据默认保存到 `~/.minder`，可通过 `MINDER_HOME` 指定其他私有目录。

| 能力 | Pi 扩展 | 独立 API |
| --- | --- | --- |
| 写前备份、File Diff、Undo | [pi-minder-snapshot](packages/pi-minder-snapshot/README.md) | [@minder/core-snapshot](packages/core-snapshot/README.md) |
| Markdown 笔记、记忆审阅与回退 | [pi-minder-memory](packages/pi-minder-memory/README.md) | [@minder/core-memory](packages/core-memory/README.md) |
| 事件评分、静默时段、本地行动卡 | [pi-minder-firewall](packages/pi-minder-firewall/README.md) | [@minder/core-firewall](packages/core-firewall/README.md) |

开发机运行 `pnpm install --frozen-lockfile`、`pnpm build` 和 `pnpm test`。源码安装可以执行 `pi install ./packages/pi-minder-snapshot` 并重启 Pi。三个包分别声明 `pi-package` 和预编译扩展入口。公开 npm 包可用后，按 `pi install npm:pi-minder-snapshot`、`pi install npm:pi-minder-memory` 或 `pi install npm:pi-minder-firewall` 单独安装。

文件保护覆盖受管工具和普通文件。其他同进程插件具有操作系统授予当前用户的权限。部署时应使用受信任的扩展和本地数据目录。三仓打包与独立消费测试在发行版仓库执行。
