# pi-minder-firewall

扩展在 Pi 会话运行期间监视已登记的目录和 RSS/Atom 地址，将普通事件存入本地数据库。四分事件按周期产生摘要，五分事件产生行动卡，推送遵守冷却时间和免打扰规则。

```sh
pi install npm:pi-minder-firewall
```

使用 `/minder-firewall watch <目录>` 或 `/minder-firewall feed <URL>` 添加来源。`/minder-firewall settings` 查看当前规则和来源。目录的来源编号为 `dir:` 加真实绝对路径，订阅的来源编号为完整 URL。

使用 `/minder-firewall rule <来源编号> <1-5>` 设置优先级，使用 `/minder-firewall quiet 22:00 07:00 Asia/Shanghai` 设置免打扰时间。用 `/minder-firewall list` 查看可以处理的行动卡。`/minder-firewall accept <id>` 将相应草稿放入输入框，用户可以修改并发送。

默认状态目录是 `~/.minder/firewall`。在 Pi SDK 中调用 `createFirewallExtension({stateDir})` 可以指定存储位置。
