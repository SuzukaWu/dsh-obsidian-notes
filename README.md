# Obsidian 笔记 · DeepSeek Harness 插件

**中文** | [English](./README.en.md)

让**任意一个** DeepSeek Harness 对话直接读写你的 [Obsidian](https://obsidian.md) 笔记库 ——
桌面端、网页端、微信端都行，不用把会话工作目录切到笔记库，也不会被文件沙箱挡住。

插件在 Host 进程里直接读写 Markdown 文件，注册六个 `obsidian_*` 工具。笔记还是你的笔记：
没有同步服务、没有数据库、不联网。

## 功能

- **日记**：往今天的日记追加一条；根据当前时间自动选「早上 / 下午 / 晚上」段，日记不存在时按你配置的分段模板自动创建。
- **项目笔记**：自动追加到 `#### 年/月/日` 日期小标题下；笔记或目录不存在时自动创建。
- **保留你的写法**：`done: true` 写 `- ~~已完成~~`，`important: true` 写 `- ==重点==`，和手写笔记一致。
- **读取与搜索**：按路径读笔记、按日期读日记，整库全文搜索（不区分大小写），按修改时间列出笔记。
- **划掉条目**：按文字匹配已有列表项，标记完成或取消完成。
- **安全边界**：所有路径限制在笔记库内；跳过 `.obsidian`、`.git`、`.trash`、`assets`、`node_modules`；`readOnly` 打开后不注册任何写入工具。
- **可配置**：笔记库路径、日记目录、分段名称、日期小标题、只读模式。
- **设置页**：在 **设置 → 笔记** 里用系统文件夹选择框（或直接输入路径）选定笔记文件夹，保存后所有工具立刻切换过去。

## 安装

### 从插件市场安装

在 DSH 插件市场搜索 **Obsidian 笔记** 安装。

### 从源码安装

```bash
git clone https://github.com/SuzukaWu/dsh-obsidian-notes.git
cd dsh-obsidian-notes
dsh plugin --profile desktop add .
```

或用插件管理器的「安装 bundle」，目标填克隆下来的目录绝对路径。新安装可热加载生效；
如果没有生效，重启一次应用。

## 配置

最省事的方式：打开 **设置 → 笔记**，点「选择文件夹…」，选中放笔记的文件夹，再点「保存」——
插件会立刻用新路径重新加载工具。

其余字段在 **设置 → 插件 → Obsidian 笔记 → 配置** 里：

| 字段 | 默认值 | 含义 |
| --- | --- | --- |
| `vault` | *（空）* | 笔记库根目录绝对路径，例如 `D:\Notes\my-vault`；未填时读环境变量 `OBSIDIAN_VAULT`。 |
| `dailyFolder` | `日记` | 日记子目录（相对笔记库根目录），留空表示根目录。 |
| `sections` | `["早上","下午","晚上"]` | 日记里的分段时间标题，按顺序排列；按当前小时选择。 |
| `dateHeading` | `true` | 往普通笔记追加时自动加 `#### 年/月/日` 小标题。 |
| `readOnly` | `false` | 只注册读取类工具，永不写入。 |

## 工具

| 工具 | 作用 |
| --- | --- |
| `obsidian_append` | 追加一条记录：写今天的日记，或用 `path` 写指定笔记；支持 `done`、`important`、`date`、`section`、`heading`。 |
| `obsidian_read` | 按 `path` 读笔记，或按 `date` 读日记（默认今天）；`offset` / `maxLines` 分页。 |
| `obsidian_search` | 整库全文搜索（不区分大小写），返回「文件:行号: 内容」。 |
| `obsidian_list` | 按修改时间倒序列出笔记，可限定目录。 |
| `obsidian_mark_done` | 按文字匹配把已有条目划掉 / 取消划掉，默认在今天的日记里找。 |
| `obsidian_info` | 查看笔记库路径、笔记数、顶层目录、今天日记状态与当前配置。 |

### 示例

- 「帮我把「读完《设计心理学》第 3 章」记到今天的日记里，标成完成」
- 「在 项目/读书笔记 里记一条：周四整理第三章」
- 「搜一下笔记里所有提到「番茄钟」的地方」
- 「把今天日记里「清理收件箱」划掉」

## 约定说明

默认值按中文个人笔记习惯设置，且全部可配 —— 改成你自己的分段名，或关掉日期小标题即可适配别的笔记库。

## 开发

由 Host 半部和一个可选的浏览器半部组成：无依赖、无构建步骤（`index.js` + `client.js` + `cordis.patch.yml`），
`@deepseek-ai/schemastery` 由 DeepSeek Harness 运行时提供。

`client.js` 是一个普通的 `window.__ModuleLoader__` 工厂，在 `settings.section` 插槽里注册「笔记」页；
它通过插件自己的本机路由（`/obsidian-notes/api/config`）读写配置——路由注册在 Host 的 `webServer` 上，
由 `connection.requestRejection()` 做连接校验，再经 Host 的 `configEditor` 服务写回本插件的 profile 配置
（改完插件会重新加载，工具随之切到新笔记库）。

```bash
node --check index.js
node --check client.js
```

## 许可证

MIT © 2026 SuzukaWu
