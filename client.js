/**
 * dsh-obsidian-notes — browser half.
 *
 * Adds a「笔记设置 / Notes」page to DSH Settings (the `settings.section` slot)
 * where the notes folder — the Obsidian vault root — can be picked with the
 * native folder dialog or typed in, then saved through the Host's settings
 * service (via the plugin's own loopback route, see index.js).
 *
 * Loaded lazily by the DSH web client as
 * `window.__ModuleLoader__.load({ id: <package name>, factory })`.
 */
window.__ModuleLoader__.load({
  id: 'dsh-obsidian-notes',
  factory: (require) => {
    const react = require('react');
    const h = react.createElement;

    const NS = 'obsidian-notes';
    const CONFIG_ROUTE = '/obsidian-notes/api/config';

    const zh = {
      nav: '笔记',
      desc: '选择你的 Obsidian 笔记库文件夹。任何对话里的笔记工具都从这个位置读取和写入。',
      vaultLabel: '笔记库文件夹',
      connected: '● 已连接',
      invalid: '● 路径不可用',
      unconfigured: '● 尚未选择',
      none: '还没有选择文件夹',
      noteCountSuffix: ' 篇 Markdown 笔记',
      placeholder: '例如 D:\\Notes\\my-vault',
      choose: '选择文件夹…',
      save: '保存',
      saving: '保存中…',
      saved: '已保存，立即生效。',
      hint: '选一个包含 Markdown 笔记的文件夹（Obsidian 库的根目录）。保存后会写入插件配置，所有 obsidian_* 工具立刻使用新位置。',
      loading: '正在读取配置…',
      retry: '重试',
      empty: '请先选择或输入一个文件夹。',
      noPicker: '当前环境不支持文件夹选择，请直接输入路径。',
      loadFailed: '读取配置失败：',
      close: '完成',
    };

    const en = {
      nav: 'Notes',
      desc: 'Choose the folder that holds your Obsidian vault. Every note tool in every conversation reads and writes here.',
      vaultLabel: 'Vault folder',
      connected: '● Connected',
      invalid: '● Path unavailable',
      unconfigured: '● Not selected',
      none: 'No folder selected yet',
      noteCountSuffix: ' Markdown notes',
      placeholder: 'e.g. D:\\Notes\\my-vault',
      choose: 'Choose folder…',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved. Takes effect immediately.',
      hint: 'Pick the folder that contains your Markdown notes (the Obsidian vault root). Saving writes it to the plugin config; every obsidian_* tool uses the new location right away.',
      loading: 'Loading settings…',
      retry: 'Retry',
      empty: 'Choose or type a folder first.',
      noPicker: 'Folder picking is unavailable here; type the path instead.',
      loadFailed: 'Could not load settings: ',
      close: 'Done',
    };

    /* ---------------------------------------------------------------- */
    /* host bridge helpers                                               */
    /* ---------------------------------------------------------------- */

    // Anchored on document.baseURI so the route also resolves when the UI is
    // mounted under a reverse-proxy path prefix (same approach as dshmarket).
    function apiPath(pathname) {
      const relative = String(pathname).replace(/^\/+/, '');
      if (typeof document === 'undefined') return '/' + relative;
      return new URL(relative, document.baseURI).pathname;
    }

    async function requestJson(pathname, init) {
      const response = await fetch(apiPath(pathname), init);
      let body = null;
      try {
        body = await response.json();
      } catch {
        body = null;
      }
      if (!response.ok) {
        const detail = body && body.error && body.error.message;
        throw new Error(detail || 'HTTP ' + response.status);
      }
      return body || {};
    }

    function messageOf(error) {
      return error instanceof Error ? error.message : String(error);
    }

    /* ---------------------------------------------------------------- */
    /* theme                                                             */
    /* ---------------------------------------------------------------- */

    const palette = {
      text: 'var(--dsw-alias-label-primary)',
      muted: 'var(--dsw-alias-label-secondary)',
      border: 'var(--dsw-alias-border-l1)',
      strongBorder: 'var(--dsw-alias-border-l2)',
      card: 'var(--dsw-alias-bg-layer-1)',
      field: 'var(--dsw-alias-bg-base)',
      brand: 'var(--dsw-alias-brand-primary)',
      error: 'var(--dsw-alias-state-error-primary)',
      success: 'var(--dsw-alias-state-success-primary)',
    };

    const mono = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const buttonBase = {
      padding: '8px 14px',
      fontSize: 13,
      lineHeight: '18px',
      borderRadius: 8,
      border: '1px solid ' + palette.strongBorder,
      background: 'transparent',
      color: palette.text,
      cursor: 'pointer',
      fontFamily: 'inherit',
      whiteSpace: 'nowrap',
    };
    const primaryButton = {
      ...buttonBase,
      background: palette.brand,
      borderColor: palette.brand,
      // The brand swatch is the inverted foreground in dark themes (near-white),
      // so the label must come from the base surface instead of a fixed white.
      color: 'var(--dsw-alias-bg-base)',
      fontWeight: 600,
    };

    /* ---------------------------------------------------------------- */
    /* the settings page                                                 */
    /* ---------------------------------------------------------------- */

    function NotesSettingsPage(props) {
      const t = props.t;
      const workspace = props.workspace;

      const [snapshot, setSnapshot] = react.useState({
        status: 'loading',
        config: null,
        resolved: null,
        error: null,
      });
      const [draft, setDraft] = react.useState('');
      const [busy, setBusy] = react.useState(false);
      const [notice, setNotice] = react.useState(null);

      const applySnapshot = react.useCallback((body) => {
        const config = body && body.config && typeof body.config === 'object' ? body.config : {};
        setSnapshot({
          status: 'ready',
          config,
          resolved: (body && body.resolved) || null,
          error: null,
        });
        setDraft(typeof config.vault === 'string' ? config.vault : '');
      }, []);

      const load = react.useCallback(() => {
        setSnapshot((previous) => ({ ...previous, status: 'loading', error: null }));
        requestJson(CONFIG_ROUTE, { cache: 'no-store' })
          .then(applySnapshot)
          .catch((error) =>
            setSnapshot({ status: 'error', config: null, resolved: null, error: messageOf(error) })
          );
      }, [applySnapshot]);

      react.useEffect(() => {
        let alive = true;
        requestJson(CONFIG_ROUTE, { cache: 'no-store' })
          .then((body) => {
            if (alive) applySnapshot(body);
          })
          .catch((error) => {
            if (alive) {
              setSnapshot({ status: 'error', config: null, resolved: null, error: messageOf(error) });
            }
          });
        return () => {
          alive = false;
        };
      }, [applySnapshot]);

      async function chooseFolder() {
        if (!workspace || typeof workspace.pickDirectory !== 'function') {
          setNotice({ kind: 'error', text: t('noPicker') });
          return;
        }
        try {
          const picked = await workspace.pickDirectory();
          if (picked) {
            setDraft(picked);
            setNotice(null);
          }
        } catch (error) {
          setNotice({ kind: 'error', text: messageOf(error) });
        }
      }

      async function save() {
        const target = String(draft || '').trim();
        if (!target) {
          setNotice({ kind: 'error', text: t('empty') });
          return;
        }
        setBusy(true);
        setNotice(null);
        try {
          const body = await requestJson(CONFIG_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ vault: target }),
          });
          applySnapshot(body);
          setNotice({ kind: 'ok', text: t('saved') });
        } catch (error) {
          setNotice({ kind: 'error', text: messageOf(error) });
        } finally {
          setBusy(false);
        }
      }

      if (snapshot.status === 'loading') {
        return h(
          'div',
          { style: { padding: '22px 26px', color: palette.muted, fontSize: 13 } },
          t('loading')
        );
      }

      if (snapshot.status === 'error') {
        return h(
          'div',
          { style: { padding: '22px 26px', display: 'grid', gap: 12 } },
          h('div', { style: { color: palette.error, fontSize: 13 } }, t('loadFailed') + snapshot.error),
          h(
            'div',
            null,
            h('button', { type: 'button', style: buttonBase, onClick: load }, t('retry'))
          )
        );
      }

      const resolved = snapshot.resolved;
      const connected = !!(resolved && resolved.configured && !resolved.error);
      const currentVault = connected
        ? resolved.vault
        : snapshot.config && snapshot.config.vault
          ? snapshot.config.vault
          : '';

      const statusText = connected
        ? t('connected')
        : currentVault
          ? t('invalid')
          : t('unconfigured');

      const rows = [];

      rows.push(
        h(
          'p',
          { key: 'desc', style: { margin: 0, color: palette.muted, fontSize: 13, lineHeight: 1.75 } },
          t('desc')
        )
      );

      const statusChildren = [
        h(
          'div',
          { key: 'head', style: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'baseline' } },
          h('span', { style: { fontSize: 12, color: palette.muted } }, t('vaultLabel')),
          h('span', { style: { fontSize: 12, color: connected ? palette.success : palette.muted } }, statusText)
        ),
        h(
          'div',
          { key: 'path', style: { fontFamily: mono, fontSize: 13, color: palette.text, wordBreak: 'break-all' } },
          currentVault || t('none')
        ),
      ];
      if (resolved && typeof resolved.noteCount === 'number') {
        statusChildren.push(
          h(
            'div',
            { key: 'count', style: { fontSize: 12, color: palette.muted } },
            String(resolved.noteCount) + t('noteCountSuffix')
          )
        );
      }
      if (resolved && resolved.error) {
        statusChildren.push(
          h('div', { key: 'error', style: { fontSize: 12, color: palette.error } }, resolved.error)
        );
      }

      rows.push(
        h(
          'div',
          {
            key: 'status',
            style: {
              display: 'grid',
              gap: 8,
              background: palette.card,
              border: '1px solid ' + palette.border,
              borderRadius: 12,
              padding: '14px 16px',
            },
          },
          statusChildren
        )
      );

      rows.push(
        h(
          'div',
          { key: 'picker', style: { display: 'flex', gap: 8, marginTop: 2 } },
          h('input', {
            type: 'text',
            value: draft,
            spellCheck: false,
            autoComplete: 'off',
            placeholder: t('placeholder'),
            onChange: (event) => {
              setDraft(event.target.value);
              setNotice(null);
            },
            onKeyDown: (event) => {
              if (event.key === 'Enter' && !busy) save();
            },
            style: {
              flex: 1,
              minWidth: 0,
              padding: '8px 10px',
              fontSize: 13,
              lineHeight: '18px',
              color: palette.text,
              background: palette.field,
              border: '1px solid ' + palette.strongBorder,
              borderRadius: 8,
              outline: 'none',
              fontFamily: mono,
            },
          }),
          h('button', { type: 'button', style: buttonBase, onClick: chooseFolder, disabled: busy }, t('choose'))
        )
      );

      const actions = [
        h(
          'button',
          {
            key: 'save',
            type: 'button',
            style: busy ? { ...primaryButton, opacity: 0.6, cursor: 'default' } : primaryButton,
            onClick: save,
            disabled: busy,
          },
          busy ? t('saving') : t('save')
        ),
      ];
      if (notice) {
        actions.push(
          h(
            'span',
            {
              key: 'notice',
              style: {
                fontSize: 12.5,
                alignSelf: 'center',
                color: notice.kind === 'ok' ? palette.success : palette.error,
              },
            },
            notice.text
          )
        );
      }
      rows.push(h('div', { key: 'actions', style: { display: 'flex', gap: 10 } }, actions));

      rows.push(
        h(
          'p',
          { key: 'hint', style: { margin: 0, color: palette.muted, fontSize: 12, lineHeight: 1.7 } },
          t('hint')
        )
      );

      return h(
        'div',
        {
          style: {
            padding: '22px 26px',
            maxWidth: 760,
            display: 'grid',
            gap: 14,
            color: palette.text,
            fontSize: 14,
            fontFamily: 'inherit',
          },
        },
        rows
      );
    }

    /* ---------------------------------------------------------------- */
    /* registration                                                      */
    /* ---------------------------------------------------------------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-obsidian-notes: dictionaries');
        const t = ctx.locale.bind(NS);
        const workspace = ctx.get('uiWorkspace');

        const buildPage = () => h(NotesSettingsPage, { t, workspace });

        ctx.slots.inject('settings.section', () => {
          const off = ctx.slots.register(
            {
              name: 'settings.section',
              id: 'obsidian',
              order: 30,
              label: () => t('nav'),
              locale: NS,
              inject: () => ({ t }),
            },
            buildPage
          );
          return typeof off === 'function' ? off : () => {};
        });
      },
    };
  },
});
