# Obsidian notes for DeepSeek Harness

[中文](./README.md) | **English**

Let **any** DeepSeek Harness conversation read and write your [Obsidian](https://obsidian.md) vault —
desktop, Web UI or WeChat — without moving the session's working directory and without the file
sandbox getting in the way.

The plugin registers six `obsidian_*` tools that read and write plain Markdown files directly in the
Host process, so your notes stay yours: no sync service, no database, no network calls.

## Features

- **Daily notes** — append a line to today's note; the time-of-day section (早上 / 下午 / 晚上) is
  picked from the clock, and the note is created from your section template when missing.
- **Project notes** — append under a `#### YY/MM/DD` date heading, creating the note (and its folders)
  when it does not exist yet.
- **Your conventions** — `done: true` writes `- ~~finished~~`, `important: true` writes
  `- ==highlighted==`, exactly like hand-written Obsidian notes.
- **Read & search** — read a note or a daily note by date, full-text search the vault (case-insensitive)
  or list notes by modification time.
- **Tick items off** — mark an existing bullet as done (`~~…~~`) or undo it, by matching its text.
- **Safe by construction** — every path is confined to the vault root; `.obsidian`, `.git`, `.trash`,
  `assets` and `node_modules` are skipped; a `readOnly` switch registers nothing that writes.
- **Configurable** — vault path, daily folder, section names, date headings, read-only mode.
- **Settings page** — pick the notes folder from **Settings → 笔记** with the native folder dialog (or
  type it in) and save; every tool switches to the new vault immediately.

## Install

### From the plugin market

Search for **Obsidian notes** in the DSH plugin market and install it.

### From source

```bash
git clone https://github.com/SuzukaWu/dsh-obsidian-notes.git
cd dsh-obsidian-notes
dsh plugin --profile desktop add .
```

Install the local directory with the plugin manager (`plugin_manager` → *install bundle*), pointing at
the cloned folder. A new install activates through hot reload; restart the app if it does not.

## Configure

The easiest way: open **Settings → 笔记 (Notes)**, press **Choose folder…**, pick the folder that
holds your notes and **Save** — the plugin reloads its tools against the new vault right away.

Every other field lives in **Settings → Plugins → Obsidian notes → Configure**:

| Field | Default | Meaning |
| --- | --- | --- |
| `vault` | *(empty)* | Absolute path to the Obsidian vault, e.g. `D:\Notes\my-vault`. Falls back to the `OBSIDIAN_VAULT` environment variable. |
| `dailyFolder` | `日记` | Sub-folder of daily notes, relative to the vault root. Leave empty for the vault root. |
| `sections` | `["早上","下午","晚上"]` | Section headings in the daily note, in order. The section is picked by the current hour. |
| `dateHeading` | `true` | Append `#### YY/MM/DD` headings when writing to ordinary notes. |
| `readOnly` | `false` | Only register read tools; never write. |

## Tools

| Tool | What it does |
| --- | --- |
| `obsidian_append` | Append one bullet: to today's daily note, or to a note by `path`. Supports `done`, `important`, `date`, `section`, `heading`. |
| `obsidian_read` | Read a note by `path`, or a daily note by `date` (default today). `offset` / `maxLines` paginate. |
| `obsidian_search` | Case-insensitive full-text search over the vault; returns `path:line: text`. |
| `obsidian_list` | List notes by modification time (newest first), optionally inside one folder. |
| `obsidian_mark_done` | Tick off / untick an existing bullet by matching its text, in the daily note or a given note. |
| `obsidian_info` | Report vault path, note count, top-level folders, today's daily-note state and active conventions. |

### Example prompts

- “帮我把「读完《设计心理学》第 3 章」记到今天的日记里，标成完成”
- “在 项目/读书笔记 里记一条：周四整理第三章”
- “搜一下笔记里所有提到「番茄钟」的地方”
- “把今天日记里「清理收件箱」划掉”

## Notes on conventions

The defaults follow Chinese personal-wiki habits, and every one of them is a config field — change the
section names or turn date headings off to match your own vault.

## Development

The plugin is a Host-only bundle plus an optional browser half: no dependencies, no build step
(`index.js` + `client.js` + `cordis.patch.yml`). `@deepseek-ai/schemastery` is provided by DeepSeek
Harness at runtime.

`client.js` is a plain `window.__ModuleLoader__` factory that registers the 笔记 / Notes page in the
`settings.section` slot; it reads and saves the vault through the plugin's own loopback route
(`/obsidian-notes/api/config`), which is registered on the Host's `webServer` and guarded by
`connection.requestRejection()`, then persisted through the Host `configEditor` service — the plugin is
reloaded, so the tools follow the new vault.

```bash
node --check index.js
node --check client.js
```

## License

MIT © 2026 SuzukaWu
