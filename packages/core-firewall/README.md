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

`dispatchDue()`、`list("ready")` 与 `inbox()` 返回相同格式的行动卡片。每张卡片包含两句话与一个草拟选项。文件提醒说明变更类型，订阅提醒使用 `Intl.Segmenter` 提取前两个有效句子，只有一句时补充审计记录的位置。标题、两句摘要、选项名称和草稿预览分别最多占用 80、159、32、160 个 UTF-16 代码单元。截断保留完整字素，省略号计入长度。

用户确认后，`accept(id, revision)` 保存该版本的草稿与唯一回执。订阅的默认草稿请求整理待办事项，目录事件的默认草稿请求核对具体文件的变更。来源提供的显式草稿逐字保留，卡片上的 `draftPreviewOnly` 表示显示内容已经缩短或整理为单行。宿主可以使用 `get(id)` 或 `explain(id)` 在确认前查看完整草稿和入库原文。重复确认返回同一回执，已有数据库中的待处理记录在读取时生成卡片。

`watchDirectory` 返回异步关闭函数。`syncFeed` 支持条件 HTTP 请求。`scoreWithOllama` 只连接本机回环地址。主进程需要持续运行，才会实时监听与投递。目录监听保存文件名和变更元信息，订阅保存进入防火墙的标题与最多 4096 个 UTF-16 代码单元的原摘要。
