/**
 * LinguaBridge · 译并发送（DSH 客户端插件）
 *
 * 输入框里是中文 → 点一次这个按钮 → 调用本机引擎译成英文 → 写回草稿 → 提交。
 * 会话里留下的就是英文，模型收到的也是英文。
 *
 * 设计要点（与扩展版一致）：
 *  - 代码块、行内代码、URL、路径、命令、环境变量、{{模板}} 不送进引擎，直接拼回，
 *    因此格式逐字保留；
 *  - 失败不发送：任何一段翻译失败都抛错，草稿保持原样，错误显示在按钮旁；
 *  - 引擎地址默认 http://127.0.0.1:5000，可用 localStorage 的
 *    `linguabridge.endpoint` 覆盖。
 */

window.__ModuleLoader__.load({
  id: '@local/linguabridge-send',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const DEFAULT_ENDPOINT = 'http://127.0.0.1:5000';
    const TIMEOUT_MS = 20000;

    // ---------------------------------------------------------------- 格式保护

    const PROTECT_RULES = [
      // 闭合围栏代码块
      /(?<=^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?<=\n)[ \t]*\1[ \t]*(?=\n|$)/g,
      // 未闭合围栏：保护到文末
      /(?<=^|\n)[ \t]*(`{3,}|~{3,})[^\n]*\n[\s\S]*$/g,
      // 行内代码
      /(`{1,2})([^`\n]+?)\1/g,
      // 邮箱先于 URL
      /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
      // http(s) / www
      /\b(?:https?:\/\/|www\.)[^\s<>"'`）)\]】，。；]+/gi,
      // Windows 路径
      /\b[A-Za-z]:\\[^\s<>"'`|?*，。；)]+/g,
      // POSIX 绝对路径
      /(?<=\s|^)\/(?:[\w.@+-]+\/)+[\w.@+-]*/g,
      // 相对文件路径
      /(?<![\w/])(?:[\w.-]+[\\/])+[\w.-]+\.[A-Za-z][\w]{0,7}\b/g,
      // 常见命令 + ASCII 参数
      /(?<![\w`])(?:npm|pnpm|yarn|npx|bun|deno|git|gh|docker|kubectl|helm|terraform|gcloud|az|cargo|rustc|go|python|py|pip|node|dotnet|msbuild|nuget|cmake|make|curl|wget|pwsh|powershell|choco|winget|ffmpeg|ssh|scp|rsync|tar|zip|unzip|java|javac|mvn|gradle|tsc|vite|vitest|jest|eslint|prettier|pytest|uv|uvx)(?:\s+(?=[^\s]*[A-Za-z0-9._/\\:@=+~$%{}[\]()"'<>*|&;^-])[^\s，。；：！？、（）]+)+/g,
      // 环境变量
      /\$env:[A-Za-z_][\w]*/g,
      /\$\{[A-Za-z_][\w]*\}/g,
      /%[A-Za-z_][\w]*%/g,
      // {{模板}}
      /\{\{[^{}\n]+\}\}/g,
    ];

    /** 收集所有受保护区间并按位置合并，返回 [start, end) 列表。 */
    function protectSpans(text) {
      const spans = [];
      for (const rule of PROTECT_RULES) {
        rule.lastIndex = 0;
        let match;
        while ((match = rule.exec(text)) !== null) {
          if (match[0].length === 0) {
            rule.lastIndex += 1;
            continue;
          }
          spans.push([match.index, match.index + match[0].length]);
        }
      }
      spans.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
      const merged = [];
      for (const span of spans) {
        const last = merged[merged.length - 1];
        if (last !== undefined && span[0] < last[1]) {
          last[1] = Math.max(last[1], span[1]);
          continue;
        }
        merged.push([span[0], span[1]]);
      }
      return merged;
    }

    /** 切成「要翻译的自然语言」与「原样保留的受保护片段」交替序列。 */
    function segmentize(text) {
      const spans = protectSpans(text);
      const segments = [];
      let cursor = 0;
      for (const [start, end] of spans) {
        if (start > cursor) segments.push({ keep: false, value: text.slice(cursor, start) });
        segments.push({ keep: true, value: text.slice(start, end) });
        cursor = end;
      }
      if (cursor < text.length) segments.push({ keep: false, value: text.slice(cursor) });
      return segments;
    }

    // ---------------------------------------------------------------- 拼接润色

    const CJK_PUNCTUATION = [
      [/，/g, ','], [/。/g, '.'], [/；/g, ';'], [/：/g, ':'], [/！/g, '!'], [/？/g, '?'],
      [/（/g, '('], [/）/g, ')'], [/、/g, ','], [/[“”]/g, '"'], [/[‘’]/g, "'"], [/…/g, '...'],
    ];
    const LATIN_TAIL = /[A-Za-z0-9)\]"'`]$/;
    const LATIN_HEAD = /^[A-Za-z0-9($"'`[]/;

    function normalizePunctuation(text) {
      let out = text;
      for (const [pattern, replacement] of CJK_PUNCTUATION) out = out.replace(pattern, replacement);
      return out;
    }

    function joinPieces(pieces) {
      let out = '';
      for (const piece of pieces) {
        if (piece === '') continue;
        if (out !== '') {
          const tail = out[out.length - 1];
          const head = piece[0];
          if (LATIN_TAIL.test(tail) && LATIN_HEAD.test(head)) out += ' ';
        }
        out += piece;
      }
      return out;
    }

    // ---------------------------------------------------------------- 引擎调用

    function endpoint() {
      try {
        const stored = window.localStorage.getItem('linguabridge.endpoint');
        if (typeof stored === 'string' && stored.trim() !== '') return stored.trim().replace(/\/+$/, '');
      } catch (error) {
        /* localStorage 不可用时退回默认值 */
      }
      return DEFAULT_ENDPOINT;
    }

    async function translateSegment(text, base) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const response = await fetch(`${base}/translate`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ q: text, source: 'auto', target: 'en', format: 'text' }),
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`本地引擎返回 HTTP ${response.status}`);
        const data = await response.json();
        const translated = typeof data.translatedText === 'string' ? data.translatedText.trim() : '';
        if (translated === '') throw new Error('本地引擎返回空译文');
        return translated;
      } catch (error) {
        if (error !== null && typeof error === 'object' && error.name === 'AbortError') {
          throw new Error('本地引擎超时，未发送');
        }
        if (error instanceof TypeError) {
          throw new Error(`连不上本地引擎 ${base}，未发送`);
        }
        throw error;
      } finally {
        clearTimeout(timer);
      }
    }

    const HAS_TRANSLATABLE = /[A-Za-z\u3400-\u4dbf\u4e00-\u9fff]/;

    /** 整段翻译：逐段送引擎，受保护片段原样拼回。 */
    async function translateDraft(text) {
      const base = endpoint();
      const pieces = [];
      for (const segment of segmentize(text)) {
        if (segment.keep) {
          pieces.push(segment.value);
          continue;
        }
        const core = segment.value.trim();
        if (core === '' || !HAS_TRANSLATABLE.test(core)) {
          pieces.push(segment.value);
          continue;
        }
        const lead = segment.value.match(/^\s*/)[0];
        const trail = segment.value.match(/\s*$/)[0];
        const body = segment.value.slice(lead.length, segment.value.length - trail.length);
        const translated = await translateSegment(body, base);
        pieces.push(lead + normalizePunctuation(translated) + trail);
      }
      return joinPieces(pieces);
    }

    // ---------------------------------------------------------------- 草稿读取

    /**
     * InputState 是编辑器投影 + 提交面状态。字段名跨版本可能变化，
     * 因此按可信度依次探测；全都读不到时返回空串，由调用方拒绝发送。
     */
    function readDraft(state) {
      if (state === null || typeof state !== 'object') return '';
      const candidates = [state.clipboardText, state.text, state.value];
      if (state.projection !== null && typeof state.projection === 'object') {
        candidates.push(state.projection.clipboardText, state.projection.text);
      }
      for (const candidate of candidates) {
        if (typeof candidate === 'string' && candidate !== '') return candidate;
      }
      return '';
    }

    // ---------------------------------------------------------------- UI

    const BUTTON_STYLE = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      height: '24px',
      minWidth: '26px',
      padding: '0 7px',
      borderRadius: '6px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(255,255,255,0.18))',
      background: 'transparent',
      color: 'var(--dsw-alias-label-secondary, #9aa4b2)',
      fontSize: '12px',
      lineHeight: '1',
      cursor: 'pointer',
    };

    function TranslateSend(props) {
      const input = props.useInput((state) => state);
      const actions = props.inputActions;
      const [status, setStatus] = React.useState({ busy: false, error: null, done: false });

      const onClick = React.useCallback(() => {
        if (status.busy) return;
        const draft = readDraft(input);
        if (draft.trim() === '') {
          setStatus({ busy: false, error: '输入框是空的', done: false });
          return;
        }
        setStatus({ busy: true, error: null, done: false });
        translateDraft(draft)
          .then((english) => {
            if (english.trim() === '') throw new Error('译文为空，未发送');
            actions.setDraft(english);
            if (typeof actions.persistDraft === 'function') actions.persistDraft();
            // Lexical 的投影在下一帧才发布，等一拍再提交，避免发出旧草稿。
            return new Promise((resolve) => setTimeout(resolve, 120)).then(() => {
              actions.submit();
              setStatus({ busy: false, error: null, done: true });
              setTimeout(() => setStatus({ busy: false, error: null, done: false }), 1600);
            });
          })
          .catch((error) => {
            setStatus({
              busy: false,
              error: (error !== null && typeof error === 'object' && error.message) || String(error),
              done: false,
            });
          });
      }, [actions, input, status.busy]);

      const label = status.busy ? '译…' : status.done ? '已发送' : '译';

      return h(
        'span',
        { style: { display: 'inline-flex', alignItems: 'center', gap: '6px', minWidth: 0 } },
        h(
          'button',
          {
            type: 'button',
            title: '把输入框里的中文译成英文并发送（本机引擎）',
            'aria-label': '翻译并发送',
            disabled: status.busy,
            onClick,
            style: Object.assign({}, BUTTON_STYLE, status.busy ? { opacity: 0.6, cursor: 'default' } : {}),
          },
          label,
        ),
        status.error === null
          ? null
          : h(
              'span',
              {
                title: status.error,
                style: {
                  fontSize: '11px',
                  color: 'var(--dsw-alias-label-error, #f87171)',
                  maxWidth: '240px',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                },
              },
              status.error,
            ),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.right', () =>
          ctx.slots.register(
            { name: 'conversation.input.right', id: 'linguabridge-send', order: 20 },
            TranslateSend,
          ),
        );
      },
    };
  },
});
