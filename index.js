/**
 * dsh-obsidian-notes — an Obsidian vault bridge for DeepSeek Harness.
 *
 * Registers `obsidian_*` tools that read and write a local Obsidian vault
 * (Markdown files) directly from the Host process, so any DSH conversation —
 * desktop, web or WeChat — can append to today's daily note, drop a line into
 * a project note, search the vault or tick an item off, without the session
 * working directory or file sandbox getting in the way.
 *
 * The tool names follow the vault's Chinese note conventions by default
 * (日记 / 早上·下午·晚上 / `~~done~~` / `==important==`), and every convention is
 * configurable through the plugin's Config schema.
 *
 * @module dsh-obsidian-notes
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import z from '@deepseek-ai/schemastery';

const MAX_TEXT = 4000;
const MAX_READ_LINES = 2000;
const DEFAULT_SECTIONS = ['早上', '下午', '晚上'];
const SKIP_DIRS = new Set(['.obsidian', '.trash', '.git', 'assets', 'node_modules', '.github']);

export const name = 'obsidian-notes';
export const inject = ['tools'];

export const Config = z.object({
  vault: z
    .string()
    .description('Obsidian 笔记库根目录的绝对路径，例如 D:\\Notes\\my-vault。也可用环境变量 OBSIDIAN_VAULT 提供。')
    .default(''),
  dailyFolder: z
    .string()
    .description('日记所在的子目录（相对笔记库根目录），例如 日记。留空表示笔记库根目录。')
    .default('日记'),
  sections: z
    .array(z.string())
    .description('日记里的分段时间标题，按出现顺序排列，例如 ["早上","下午","晚上"]。')
    .default(DEFAULT_SECTIONS),
  dateHeading: z
    .boolean()
    .description('向普通笔记追加内容时，自动使用 `#### YY/MM/DD` 日期小标题（Obsidian 项目笔记常见写法）。')
    .default(true),
  readOnly: z.boolean().description('只注册读取类工具，禁止写入笔记库。').default(false),
});

/* ------------------------------------------------------------------ */
/* small helpers                                                       */
/* ------------------------------------------------------------------ */

function pad2(n) {
  return String(n).padStart(2, '0');
}
function fmtDate(d) {
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}
function fmtShort(d) {
  return String(d.getFullYear()).slice(-2) + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate());
}
function fmtTime(ms) {
  const d = new Date(ms);
  return fmtDate(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}
function startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
function toPosix(p) {
  return String(p).replace(/\\/g, '/');
}

function parseDateArg(v) {
  const now = new Date();
  const s = String(v == null ? '' : v).trim().toLowerCase();
  if (s === '' || s === 'today' || s === '今天') return startOfDay(now);
  if (s === 'tomorrow' || s === '明天') {
    const d = startOfDay(now);
    d.setDate(d.getDate() + 1);
    return d;
  }
  if (s === 'yesterday' || s === '昨天') {
    const d = startOfDay(now);
    d.setDate(d.getDate() - 1);
    return d;
  }
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})$/);
  if (m) return new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]));
  throw new Error(`无法识别的日期 "${v}"，请用 YYYY-MM-DD（也支持 today/tomorrow/yesterday/今天/明天/昨天）`);
}

function stripMarkers(t) {
  let prev;
  let s = String(t == null ? '' : t);
  do {
    prev = s;
    s = s.replace(/^~~([\s\S]*)~~$/, '$1').replace(/^==([\s\S]*)==$/, '$1');
    s = s.replace(/^~~/, '').replace(/~~$/, '').replace(/^==/, '').replace(/==$/, '');
  } while (s !== prev);
  return s;
}

function decorate(text, done, important) {
  let t = stripMarkers(String(text == null ? '' : text).trim());
  if (!t) throw new Error('内容不能为空');
  if (t.length > MAX_TEXT) throw new Error(`内容太长（超过 ${MAX_TEXT} 字），请拆分后再写`);
  if (important) t = `==${t}==`;
  if (done) t = `~~${t}~~`;
  return t;
}

function guessSection(sections) {
  const list = Array.isArray(sections) && sections.length ? sections : DEFAULT_SECTIONS;
  const h = new Date().getHours();
  if (list.length >= 3) return h < 12 ? list[0] : h < 18 ? list[1] : list[2];
  return list[list.length - 1];
}

function normalizeHeading(heading) {
  const s = String(heading == null ? '' : heading).trim();
  if (!s) return null;
  return /^#{1,6}\s/.test(s) ? s : '#### ' + s;
}

/**
 * Insert `bullet` as the last line of the block that starts with `heading`.
 * Creates the heading (and its block) at the end of the file when missing.
 */
function insertUnderHeading(content, heading, bullet) {
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((l) => l.trim() === heading.trim());
  if (start === -1) {
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    lines.push('', heading, bullet);
    return lines.join('\n') + '\n';
  }
  let end = start + 1;
  while (end < lines.length && !/^#{1,6}\s/.test(lines[end])) end++;
  let at = start + 1;
  for (let i = start + 1; i < end; i++) if (lines[i].trim() !== '') at = i + 1;
  lines.splice(at, 0, bullet);
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* vault operations                                                    */
/* ------------------------------------------------------------------ */

function resolveVault(config) {
  const raw = String((config && config.vault) || process.env.OBSIDIAN_VAULT || '').trim();
  if (!raw) {
    throw new Error(
      '还没有配置 Obsidian 笔记库。请打开 设置 → 插件 →「Obsidian 笔记」→ 配置，把 vault 填成笔记库根目录的绝对路径' +
        '（也可以设置环境变量 OBSIDIAN_VAULT）。'
    );
  }
  const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
  const p = path.resolve(expanded);
  let st;
  try {
    st = fs.statSync(p);
  } catch {
    throw new Error(`找不到笔记库目录：${p}`);
  }
  if (!st.isDirectory()) throw new Error(`vault 不是目录：${p}`);
  return p;
}

function createOps(root, config) {
  const sections = Array.isArray(config.sections) && config.sections.length ? config.sections : DEFAULT_SECTIONS;

  function inside(p) {
    const rel = path.relative(root, p);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
  }

  function walk(dir) {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) out.push(...walk(full));
      } else if (e.isFile() && /\.md$/i.test(e.name)) out.push(full);
    }
    return out;
  }

  function rel(p) {
    return toPosix(path.relative(root, p));
  }

  function dailyPath(d) {
    const folder = String(config.dailyFolder || '').trim();
    const base = folder ? path.resolve(root, folder) : root;
    if (!inside(base)) throw new Error(`dailyFolder 不在笔记库内：${config.dailyFolder}`);
    return path.join(base, fmtDate(d) + '.md');
  }

  function dailyTemplate() {
    return sections.map((s) => '### ' + s).join('\n\n') + '\n';
  }

  function resolveNote(input) {
    const raw = String(input == null ? '' : input).trim().replace(/\\/g, '/');
    if (!raw) throw new Error('缺少笔记路径（path）');
    if (path.isAbsolute(raw)) {
      const p = path.resolve(raw);
      if (!inside(p)) throw new Error(`路径不在笔记库内：${raw}`);
      if (fs.existsSync(p)) return p;
      throw new Error(`找不到笔记 "${raw}"，可用 obsidian_list 查看全部笔记。`);
    }
    const candidates = /\.md$/i.test(raw) ? [raw] : [raw + '.md', raw];
    for (const c of candidates) {
      const p = path.resolve(root, c);
      if (inside(p) && fs.existsSync(p)) return p;
    }
    const base = path.basename(raw, '.md');
    const hits = walk(root).filter((f) => path.basename(f, '.md') === base);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) {
      throw new Error(
        `笔记名 "${base}" 不唯一，请给更完整的路径：\n` + hits.map((h) => '  - ' + rel(h)).join('\n')
      );
    }
    throw new Error(`找不到笔记 "${raw}"，可用 obsidian_list 查看全部笔记。`);
  }

  function resolveOrCreateNote(input) {
    const raw = String(input == null ? '' : input).trim().replace(/\\/g, '/');
    if (!raw) throw new Error('缺少笔记路径（path）');
    if (path.isAbsolute(raw)) {
      const p = path.resolve(raw);
      if (!inside(p)) throw new Error(`路径不在笔记库内：${raw}`);
      if (fs.existsSync(p)) return { file: p, created: false };
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '# ' + path.basename(p, '.md') + '\n', 'utf8');
      return { file: p, created: true };
    }
    const candidates = /\.md$/i.test(raw) ? [raw] : [raw + '.md', raw];
    for (const c of candidates) {
      const p = path.resolve(root, c);
      if (inside(p) && fs.existsSync(p)) return { file: p, created: false };
    }
    const p = path.resolve(root, candidates[0]);
    if (!inside(p)) throw new Error(`路径不在笔记库内：${raw}`);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '# ' + path.basename(p, '.md') + '\n', 'utf8');
    return { file: p, created: true };
  }

  function append(args) {
    if (config.readOnly) throw new Error('插件当前是只读模式（readOnly=true），未写入。');
    const d = parseDateArg(args.date);
    const bullet = '- ' + decorate(args.text, args.done === true, args.important === true);

    if (args.path) {
      const { file, created } = resolveOrCreateNote(args.path);
      const content = fs.readFileSync(file, 'utf8');
      const heading = normalizeHeading(args.heading) || (config.dateHeading ? '#### ' + fmtShort(d) : null);
      const next = heading
        ? insertUnderHeading(content, heading, bullet)
        : (content.replace(/\s*$/, '') + '\n' + bullet + '\n');
      fs.writeFileSync(file, next, 'utf8');
      return (
        (created ? `已新建笔记 ${rel(file)}\n` : `已写入 ${rel(file)}`) +
        (heading ? ` 的「${heading}」小节：\n` : '：\n') +
        bullet
      );
    }

    const p = dailyPath(d);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : dailyTemplate();
    const section = String(args.section || '').trim() || guessSection(sections);
    const heading = normalizeHeading(args.heading) || '### ' + section;
    fs.writeFileSync(p, insertUnderHeading(content, heading, bullet), 'utf8');
    return `已写入 ${rel(p)} 的「${heading.replace(/^#+\s*/, '')}」段：\n` + bullet;
  }

  function read(args) {
    let p;
    if (args.path) {
      p = resolveNote(args.path);
    } else {
      const d = parseDateArg(args.date);
      p = dailyPath(d);
      if (!fs.existsSync(p)) throw new Error(`还没有 ${fmtDate(d)} 的日记：${rel(p)}`);
    }
    const text = fs.readFileSync(p, 'utf8');
    const all = text.split(/\r?\n/);
    const offset = Math.max(1, Number(args.offset) || 1);
    const maxLines = Math.max(1, Math.min(MAX_READ_LINES, Number(args.maxLines) || 400));
    const slice = all.slice(offset - 1, offset - 1 + maxLines);
    const header = `### ${rel(p)}${offset > 1 || all.length > offset - 1 + maxLines ? `（第 ${offset}-${offset - 1 + slice.length} 行，共 ${all.length} 行）` : ''}`;
    return header + '\n\n' + slice.join('\n') + (offset - 1 + slice.length < all.length ? '\n\n…（已截断，可用 offset 继续读）' : '');
  }

  function search(args) {
    const q = String(args.query || '').trim();
    if (!q) throw new Error('query 不能为空');
    let dir = root;
    if (args.folder) {
      dir = path.resolve(root, String(args.folder));
      if (!inside(dir)) throw new Error('folder 不在笔记库内');
    }
    const limit = Math.max(1, Math.min(200, Number(args.limit) || 30));
    const needle = q.toLowerCase();
    const hits = [];
    for (const f of walk(dir)) {
      let text;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ file: f, line: i + 1, text: lines[i].trim(), mtime: fs.statSync(f).mtimeMs });
        }
      }
    }
    if (!hits.length) return `没有找到包含「${q}」的内容。可先用 obsidian_list 看看有哪些笔记。`;
    hits.sort((a, b) => b.mtime - a.mtime);
    const shown = hits.slice(0, limit);
    return (
      `找到 ${hits.length} 处` +
      (hits.length > limit ? `（显示前 ${limit} 处）` : '') +
      '：\n' +
      shown.map((h) => `- ${rel(h.file)}:${h.line}: ${h.text}`).join('\n')
    );
  }

  function list(args) {
    let dir = root;
    if (args.folder) {
      dir = path.resolve(root, String(args.folder));
      if (!inside(dir)) throw new Error('folder 不在笔记库内');
    }
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 50));
    const files = walk(dir)
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!files.length) return '这个范围内还没有 Markdown 笔记。';
    return (
      `共 ${files.length} 篇笔记` +
      (files.length > limit ? `（按修改时间倒序显示 ${limit} 篇）` : '') +
      '：\n' +
      files.slice(0, limit).map((x) => `- ${rel(x.f)} (${fmtTime(x.m)})`).join('\n')
    );
  }

  function markDone(args) {
    if (config.readOnly) throw new Error('插件当前是只读模式（readOnly=true），未写入。');
    const q = String(args.text || '').trim();
    if (!q) throw new Error('text 不能为空（要标记完成的条目文字）');
    let p;
    if (args.path) p = resolveNote(args.path);
    else {
      p = dailyPath(parseDateArg(args.date));
      if (!fs.existsSync(p)) throw new Error(`笔记不存在：${rel(p)}`);
    }
    const source = rel(p);
    const lines = fs.readFileSync(p, 'utf8').split(/\r?\n/);
    const bulletHits = [];
    for (let i = 0; i < lines.length; i++) if (/^\s*-\s/.test(lines[i]) && lines[i].includes(q)) bulletHits.push(i);
    if (!bulletHits.length) {
      const any = [];
      for (let i = 0; i < lines.length; i++) if (lines[i].includes(q)) any.push(i);
      if (any.length) {
        throw new Error(
          `在 ${source} 里找到「${q}」但不是列表项，无法自动标记：\n` +
            any.map((i) => `- 第${i + 1}行：${lines[i].trim()}`).join('\n')
        );
      }
      throw new Error(`在 ${source} 里没找到「${q}」。`);
    }
    if (bulletHits.length > 1) {
      throw new Error(
        `「${q}」匹配到多条，请给更精确的文字：\n` +
          bulletHits.map((i) => `- 第${i + 1}行：${lines[i].trim()}`).join('\n')
      );
    }
    const idx = bulletHits[0];
    const body = stripMarkers(lines[idx].replace(/^\s*-\s+/, '').trim());
    const done = args.done !== false;
    const next = done ? '- ~~' + body + '~~' : '- ' + body;
    if (lines[idx].trim() === next) {
      return `「${body}」${done ? '已经是完成状态' : '本来就不是完成状态'}，没有改动。`;
    }
    lines[idx] = next;
    fs.writeFileSync(p, lines.join('\n'), 'utf8');
    return `${done ? '已标记完成' : '已取消完成'}（${source} 第${idx + 1}行）：\n${next}`;
  }

  function info() {
    const files = walk(root);
    const folders = (() => {
      try {
        return fs
          .readdirSync(root, { withFileTypes: true })
          .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
          .map((e) => e.name);
      } catch {
        return [];
      }
    })();
    const today = parseDateArg('today');
    const dp = dailyPath(today);
    const todayState = fs.existsSync(dp)
      ? `${rel(dp)}（${fs.readFileSync(dp, 'utf8').split(/\r?\n/).length} 行）`
      : `${rel(dp)} 还不存在，第一次写入时会创建`;
    return [
      `笔记库：${root}`,
      `笔记数：${files.length} 篇 Markdown；顶层目录：${folders.length ? folders.join('、') : '（无）'}`,
      `今天的日记：${todayState}`,
      `配置：dailyFolder=${config.dailyFolder || '（根目录）'}；sections=${sections.join('/')}；dateHeading=${config.dateHeading ? 'on' : 'off'}；readOnly=${config.readOnly ? 'on' : 'off'}`,
    ].join('\n');
  }

  return { append, read, search, list, markDone, info };
}

/* ------------------------------------------------------------------ */
/* plugin activation                                                   */
/* ------------------------------------------------------------------ */

const textResult = (value) => [{ type: 'text', text: String(value.summary) }];
const OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: { summary: { type: 'string' } },
  required: ['summary'],
};

function defineTool(def) {
  return {
    name: def.name,
    description: def.description,
    parameters: def.parameters,
    output: { schema: OUTPUT_SCHEMA, render: (_args, value) => textResult(value) },
    presentCall: def.presentCall,
    async execute(args) {
      return { summary: await def.run(args || {}) };
    },
  };
}

/* ------------------------------------------------------------------ */
/* settings bridge (settings page ↔ Host config)                       */
/* ------------------------------------------------------------------ */

const PACKAGE_NAME = 'dsh-obsidian-notes';
const BRIDGE_PREFIX = '/obsidian-notes/api';

/**
 * The Loader row that owns this activation. `ctx.fiber.entry` is authoritative;
 * the config-editor directory is only a fallback for unusual mount paths.
 */
function ownEntry(ctx, editor) {
  const direct = ctx && ctx.fiber && ctx.fiber.entry;
  if (direct && direct.options && typeof direct.options === 'object') return direct;
  try {
    const rows = editor && typeof editor.entries === 'function' ? editor.entries() : [];
    return rows.find((row) => row && row.options && row.options.name === PACKAGE_NAME);
  } catch {
    return undefined;
  }
}

function countMarkdownNotes(root) {
  let total = 0;
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
      } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
        total += 1;
      }
    }
  }
  return total;
}

/** Read-only view of the effective vault, for the settings page. */
function describeVault(config) {
  const cfg = config || {};
  const raw = String(cfg.vault || process.env.OBSIDIAN_VAULT || '').trim();
  if (!raw) return { configured: false, vault: '', noteCount: null, error: null };
  try {
    const root = resolveVault(cfg);
    return { configured: true, vault: toPosix(root), noteCount: countMarkdownNotes(root), error: null };
  } catch (error) {
    return {
      configured: true,
      vault: toPosix(path.resolve(raw.replace(/^~(?=$|[\\/])/, os.homedir()))),
      noteCount: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const badRequest = (message) => {
      const error = new Error(message);
      error.code = 'bad-request';
      return error;
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(badRequest('请求内容过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(badRequest('请求内容不是合法的 JSON'));
      }
    });
    req.on('error', (error) => reject(error));
  });
}

function writeJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Register the Obsidian tools on `ctx.tools`.
 * @param ctx - registrant context carrying the tool registry.
 * @param config - validated plugin configuration.
 */
export function apply(ctx, config) {
  const cfg = config || {};

  // The vault is resolved lazily, on the first tool call, so installing the
  // plugin never fails just because it has not been configured yet.
  let opsCache = null;
  const ops = () => {
    if (!opsCache) opsCache = createOps(resolveVault(cfg), cfg);
    return opsCache;
  };

  const tools = [
    defineTool({
      name: 'obsidian_append',
      description:
        'Append one bullet to an Obsidian vault. Without `path` it writes to today\'s daily note under a time-of-day section (早上/下午/晚上, auto-picked by the clock). With `path` it writes to that note, under a `#### YY/MM/DD` date heading when dateHeading is enabled; the note and its folders are created when missing. `done` wraps the text in ~~delete~~, `important` in ==highlight==. 中文：向 Obsidian 笔记库追加一条记录；不传 path 写今天的日记（按时间自动选早上/下午/晚上），传 path 写指定笔记并自动归到当天日期小节。',
      parameters: {
        text: { type: 'string', required: true, description: 'The line to append, without a leading "- ". 要写入的内容（单行，不要带 "- "）' },
        path: { type: 'string', description: 'Note path or name, e.g. "项目/读书笔记". Omit to write the daily note. 目标笔记；省略写日记' },
        date: { type: 'string', description: 'YYYY-MM-DD or today/tomorrow/yesterday. 默认 today' },
        section: { type: 'string', description: 'Daily-note section heading (e.g. 早上/下午/晚上). Omit to pick by the current time. 日记小节' },
        heading: { type: 'string', description: 'Explicit heading to append under, e.g. "#### 26/11/10". 显式指定要追加到哪个标题下' },
        done: { type: 'boolean', description: 'Mark the new line as done: wraps it in ~~ ~~. 已完成' },
        important: { type: 'boolean', description: 'Mark the new line as important: wraps it in == ==. 重点/待办' },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args && args.path ? `Append to ${args.path}` : 'Append to daily note',
        kind: 'edit',
        rawInput: { text: args && args.text, date: args && args.date, done: !!(args && args.done) },
      }),
      run: (args) => ops().append(args),
    }),
    defineTool({
      name: 'obsidian_read',
      description:
        'Read a note from the Obsidian vault: pass `date` for a daily note (default today) or `path` for any note. 中文：读取笔记；传 date 读当天日记（默认今天），传 path 读任意笔记。',
      parameters: {
        path: { type: 'string', description: 'Note path or name, e.g. "项目/SSVEP-MI手功能康复系统". 笔记路径或名称' },
        date: { type: 'string', description: 'Daily-note date, YYYY-MM-DD or today/tomorrow/yesterday. 日记日期' },
        offset: { type: 'integer', description: '1-based first line to return. 起始行号' },
        maxLines: { type: 'integer', description: 'Maximum lines to return (default 400). 最多返回行数' },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args && args.path ? `Read ${args.path}` : 'Read daily note',
        kind: 'read',
        rawInput: { path: args && args.path, date: args && args.date },
      }),
      run: (args) => ops().read(args),
    }),
    defineTool({
      name: 'obsidian_search',
      description:
        'Case-insensitive full-text search across the Obsidian vault; returns `path:line: text` hits. 中文：在笔记库里全文搜索（不区分大小写），返回「文件:行号: 内容」。',
      parameters: {
        query: { type: 'string', required: true, description: 'Text to search for. 要搜索的文字' },
        folder: { type: 'string', description: 'Limit the search to one folder, e.g. "项目". 限定目录' },
        limit: { type: 'integer', description: 'Maximum hits to return (default 30). 最多返回条数' },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: `Search notes: ${(args && args.query) || ''}`,
        kind: 'search',
        rawInput: { query: args && args.query, folder: args && args.folder },
      }),
      run: (args) => ops().search(args),
    }),
    defineTool({
      name: 'obsidian_list',
      description:
        'List Markdown notes in the Obsidian vault by modification time (newest first); optionally inside one folder. 中文：列出笔记文件（按修改时间倒序），可限定目录。',
      parameters: {
        folder: { type: 'string', description: 'Limit to one folder, e.g. "项目"; omit for the whole vault. 限定目录' },
        limit: { type: 'integer', description: 'Maximum notes to list (default 50). 最多条数' },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args && args.folder ? `List notes in ${args.folder}` : 'List notes',
        kind: 'read',
        rawInput: { folder: args && args.folder },
      }),
      run: (args) => ops().list(args),
    }),
    defineTool({
      name: 'obsidian_mark_done',
      description:
        'Tick off (or untick with `done=false`) one existing bullet in a note by matching its text, wrapping it in ~~delete~~. Defaults to today\'s daily note. 中文：把笔记里已写下的某条标记为完成（加 ~~删除线~~），默认在今天的日记里找。',
      parameters: {
        text: { type: 'string', required: true, description: 'Text contained in the bullet to update. 条目里包含的文字' },
        path: { type: 'string', description: 'Note to search instead of the daily note. 改在指定笔记里找' },
        date: { type: 'string', description: 'Daily-note date, default today. 日记日期' },
        done: { type: 'boolean', description: 'false unticks the bullet; default true. 传 false 表示取消完成' },
      },
      presentCall: (args) => ({
        card: 'generic',
        title: args && args.done === false ? 'Untick note item' : 'Tick off note item',
        kind: 'edit',
        rawInput: { text: args && args.text, path: args && args.path },
      }),
      run: (args) => ops().markDone(args),
    }),
    defineTool({
      name: 'obsidian_info',
      description:
        'Report the configured Obsidian vault: root path, note count, top-level folders, today\'s daily-note state and active conventions. 中文：查看笔记库概况（路径、笔记数、顶层目录、今天的日记状态与配置），排查配置问题。',
      parameters: {},
      presentCall: () => ({ card: 'generic', title: 'Obsidian vault info', kind: 'read' }),
      run: () => ops().info(),
    }),
  ];

  ctx.effect(() => {
    const disposers = tools.map((tool) => ctx.tools.register(tool));
    const target = cfg.vault || process.env.OBSIDIAN_VAULT || '(not configured yet)';
    console.log(`[obsidian-notes] registered ${tools.length} tools; vault: ${target}`);
    return () => {
      for (const dispose of disposers) dispose();
    };
  });

  /* ---------------------------------------------------------------- */
  /* settings bridge: the「笔记设置」page edits this plugin's config      */
  /* ---------------------------------------------------------------- */

  const webServer = ctx.get('webServer');
  const connection = ctx.get('connection');
  const configEditor = ctx.get('configEditor');
  const configDefaults = {
    vault: '',
    dailyFolder: '日记',
    sections: ['早上', '下午', '晚上'],
    dateHeading: true,
    readOnly: false,
  };
  /** Effective config of this row, merged over the built-in defaults. */
  const effectiveConfig = () => {
    const entry = ownEntry(ctx, configEditor);
    const raw = entry && entry.options && entry.options.config;
    const base = raw && typeof raw === 'object' ? raw : {};
    return { ...configDefaults, ...base };
  };

  if (webServer && connection) {
    ctx.effect(() => {
      let dispose;
      try {
        dispose = webServer.register({
          kind: 'prefix',
          path: BRIDGE_PREFIX,
          handler: async (req, res) => {
            try {
              const rejected = connection.requestRejection(req);
              if (rejected !== undefined) {
                writeJson(res, 403, {
                  ok: false,
                  error: { code: 'forbidden', message: '请求未通过本机连接校验。' },
                });
                return;
              }

              const url = new URL(req.url || '/', 'http://localhost');
              const action = url.pathname
                .slice(BRIDGE_PREFIX.length)
                .replace(/^\/+|\/+$/g, '');
              const method = String(req.method || 'GET').toUpperCase();

              if (action === 'config' && method === 'GET') {
                const effective = effectiveConfig();
                writeJson(res, 200, {
                  ok: true,
                  canSave: !!(configEditor && ownEntry(ctx, configEditor)),
                  config: {
                    vault: typeof effective.vault === 'string' ? effective.vault : '',
                    dailyFolder: effective.dailyFolder,
                    sections: effective.sections,
                    dateHeading: effective.dateHeading,
                    readOnly: effective.readOnly,
                  },
                  resolved: describeVault(effective),
                });
                return;
              }

              if (action === 'config' && method === 'POST') {
                const entry = ownEntry(ctx, configEditor);
                if (!configEditor || !entry) {
                  writeJson(res, 503, {
                    ok: false,
                    error: { code: 'unavailable', message: '配置服务暂不可用，请稍后重试。' },
                  });
                  return;
                }
                const body = await readJsonBody(req);
                const raw = String((body && body.vault) || '').trim();
                if (!raw) {
                  writeJson(res, 400, {
                    ok: false,
                    error: { code: 'invalid', message: '请先选择或输入一个文件夹。' },
                  });
                  return;
                }
                const expanded = raw.replace(/^~(?=$|[\\/])/, os.homedir());
                const target = path.resolve(expanded);
                let stat;
                try {
                  stat = fs.statSync(target);
                } catch {
                  writeJson(res, 400, {
                    ok: false,
                    error: { code: 'not-found', message: `找不到这个文件夹：${toPosix(target)}` },
                  });
                  return;
                }
                if (!stat.isDirectory()) {
                  writeJson(res, 400, {
                    ok: false,
                    error: { code: 'not-directory', message: `这不是文件夹：${toPosix(target)}` },
                  });
                  return;
                }
                const vault = toPosix(target);
                await configEditor.edit(entry, (current) => ({
                  ...(current && typeof current === 'object' ? current : {}),
                  vault,
                }));
                const nextConfig = { ...effectiveConfig(), vault };
                writeJson(res, 200, {
                  ok: true,
                  canSave: true,
                  config: {
                    vault,
                    dailyFolder: nextConfig.dailyFolder,
                    sections: nextConfig.sections,
                    dateHeading: nextConfig.dateHeading,
                    readOnly: nextConfig.readOnly,
                  },
                  resolved: describeVault(nextConfig),
                });
                return;
              }

              writeJson(res, 404, {
                ok: false,
                error: { code: 'not-found', message: `未知接口：${action || '(root)'}` },
              });
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              const conflict = !!error && /conflict/i.test(String(error.name || ''));
              const badRequest = !!error && error.code === 'bad-request';
              writeJson(res, conflict ? 409 : badRequest ? 400 : 500, {
                ok: false,
                error: {
                  code: conflict ? 'conflict' : badRequest ? 'invalid' : 'internal',
                  message: conflict ? '设置已在别处修改，请刷新页面后重试。' : message,
                },
              });
            }
          },
        });
      } catch (error) {
        console.warn('[obsidian-notes] settings route not registered:', error);
        return () => {};
      }
      return () => {
        try {
          dispose();
        } catch {
          /* the route is already gone */
        }
      };
    }, '[obsidian-notes] settings bridge route');
  }
}
