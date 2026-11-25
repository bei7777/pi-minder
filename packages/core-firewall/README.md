# @minder/core-firewall

此包将文件变更与 RSS/Atom 订阅转换为可审计的 SQLite 事件记录。使用 Node.js 22.19 或以上版本。调用方指定本机私有状态目录，使用后调用 close()。

```ts
import { Firewall, syncFeed } from "@minder/core-firewall";

const store = new Firewall("./minder-data/firewall");
try {
  const feed = process.env.MINDER_FEED_URL;
  if (!feed) throw new Error("Set MINDER_FEED_URL");
  store.configure({ rules: [{ sourceId: feed, score: 4 }] });
  await syncFeed(store, feed);
  store.dispatchDue();
  console.log(store.inbox());
} finally {
  store.close();
}
```

1–3 分只入日志，4 分按时间窗口汇总，5 分即时进入本地收件箱。规则优先于可选模型评分。quietStart 和 quietEnd 使用 HH:MM，timezone 使用 IANA 名称，同一时间表示全天允许投递。来源规则可单独设置 bypassQuiet。冷却按来源、事件标识和动作计算。事件修订、分数、规则原因和投递时间均保存在 state.sqlite。

accept(id, revision) 接受当前卡片草稿，保存文字和唯一回执。调用方可以将草稿放入编辑器。watchDirectory 返回异步关闭函数；syncFeed 支持条件 HTTP 请求；scoreWithOllama 只连接本机回环地址。主进程需要持续运行，才会实时监听与投递。目录监听保存文件名和变更元信息，订阅保存标题和摘要。
