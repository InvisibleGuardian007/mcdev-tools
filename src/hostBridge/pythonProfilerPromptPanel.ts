import * as vscode from 'vscode';
import { copyToClipboard } from '../utils/clipboard';
import { PythonProfilerTarget } from './pythonProfiler';
import { PythonProfilerClassesMode } from './pythonProfilerReport';

/**
 * 「复制给 Agent」之前要看的那份正文。
 * 放在独立面板里（编辑器标签页），不再挤在侧边栏的小弹层里。
 */
export interface PythonProfilerPromptContent {
    prompt: string;
    /** 报告文件路径，只用于展示 */
    reportPath: string;
    /** 单 MOD 收窄时带上 mod 名 */
    mod?: string;
    /** 每段保留条数，0 表示全部 */
    copyLimit: number;
    /** 「Hot Classes / Modules」形态：不生成 / 汇总+函数表 / 仅汇总 */
    classes?: PythonProfilerClassesMode;
    target: PythonProfilerTarget;
}

export interface PythonProfilerPromptPanelOptions {
    content: PythonProfilerPromptContent;
    /** 用户点「重新生成」：返回新正文；返回 undefined 表示这一轮没有新内容 */
    onRegenerate?: () => Promise<PythonProfilerPromptContent | undefined>;
    /** 真的写进剪贴板之后回调（用于让侧边栏同步提示） */
    onCopied?: (text: string) => void;
}

const VIEW_TYPE = 'mcdev-tools.pythonProfilerPrompt';
const PANEL_TITLE = 'MC Dev Tools · 复制给 Agent';

/**
 * 独立的大面板：整块编辑器宽度装正文，可直接改，确认后写剪贴板。
 * 同一个面板复用：再次触发「复制给 Agent」只是把新正文刷进去并聚焦。
 */
export class PythonProfilerPromptPanel implements vscode.Disposable {
    private static current: PythonProfilerPromptPanel | undefined;

    private content: PythonProfilerPromptContent;
    private regenerate?: () => Promise<PythonProfilerPromptContent | undefined>;
    private copied?: (text: string) => void;

    private constructor(
        private readonly panel: vscode.WebviewPanel,
        options: PythonProfilerPromptPanelOptions
    ) {
        this.content = options.content;
        this.regenerate = options.onRegenerate;
        this.copied = options.onCopied;
        this.panel.webview.html = buildPromptHtml(this.panel.webview);
        this.panel.webview.onDidReceiveMessage(message => {
            void this.handleMessage(message);
        });
        this.panel.onDidDispose(() => {
            if (PythonProfilerPromptPanel.current === this) {
                PythonProfilerPromptPanel.current = undefined;
            }
        });
    }

    public static show(options: PythonProfilerPromptPanelOptions): PythonProfilerPromptPanel {
        const current = PythonProfilerPromptPanel.current;
        if (current) {
            current.update(options);
            current.panel.reveal(vscode.ViewColumn.Beside, false);
            return current;
        }
        const panel = vscode.window.createWebviewPanel(
            VIEW_TYPE,
            PANEL_TITLE,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false },
            {
                enableScripts: true,
                enableFindWidget: true,
                retainContextWhenHidden: true
            }
        );
        const instance = new PythonProfilerPromptPanel(panel, options);
        PythonProfilerPromptPanel.current = instance;
        return instance;
    }

    public dispose(): void {
        this.panel.dispose();
    }

    private update(options: PythonProfilerPromptPanelOptions): void {
        this.content = options.content;
        this.regenerate = options.onRegenerate;
        this.copied = options.onCopied;
        void this.postContent();
    }

    private async postContent(): Promise<void> {
        await this.panel.webview.postMessage({
            type: 'setPrompt',
            prompt: this.content.prompt,
            reportPath: this.content.reportPath,
            mod: this.content.mod ?? '',
            copyLimit: this.content.copyLimit,
            classes: this.content.classes ?? 'both'
        });
    }

    private async handleMessage(message: any): Promise<void> {
        if (!message || typeof message.type !== 'string') {
            return;
        }
        if (message.type === 'ready') {
            await this.postContent();
            return;
        }
        if (message.type === 'copy') {
            const text = typeof message.text === 'string' ? message.text : '';
            if (!text.trim()) {
                await this.panel.webview.postMessage({
                    type: 'copyResult',
                    ok: false,
                    message: '正文是空的，没法复制'
                });
                return;
            }
            const ok = await copyToClipboard(text);
            await this.panel.webview.postMessage({
                type: 'copyResult',
                ok,
                message: ok
                    ? '已复制 ' + formatCount(text.length) + ' 个字符，粘给 Agent 即可'
                    : '写剪贴板失败，手动全选复制吧'
            });
            if (ok) {
                this.copied?.(text);
            }
            return;
        }
        if (message.type === 'regenerate') {
            const regenerate = this.regenerate;
            if (!regenerate) {
                return;
            }
            await this.panel.webview.postMessage({ type: 'busy', value: true });
            try {
                const next = await regenerate();
                if (next) {
                    this.content = next;
                    await this.postContent();
                }
            } catch (error) {
                await this.panel.webview.postMessage({
                    type: 'copyResult',
                    ok: false,
                    message: error instanceof Error ? error.message : String(error)
                });
            } finally {
                await this.panel.webview.postMessage({ type: 'busy', value: false });
            }
        }
    }
}

/** 面板里也用 k / M 计数，正文动辄几十万字 */
export function formatCount(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
        return '0';
    }
    if (value < 1000) {
        return String(Math.round(value));
    }
    if (value < 1000000) {
        const kilo = value / 1000;
        const text = kilo >= 100 ? String(Math.round(kilo)) : kilo.toFixed(1).replace('.0', '');
        return text + 'k';
    }
    const mega = value / 1000000;
    const text = mega >= 100 ? String(Math.round(mega)) : mega.toFixed(1).replace('.0', '');
    return text + 'M';
}

function createNonce(): string {
    const charset = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let index = 0; index < 32; index += 1) {
        text += charset.charAt(Math.floor(Math.random() * charset.length));
    }
    return text;
}

function buildPromptHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const csp = "default-src 'none'; style-src " + webview.cspSource + " 'unsafe-inline'; script-src 'nonce-" + nonce + "';";
    return [
        '<!DOCTYPE html>',
        '<html lang="zh-CN">',
        '<head>',
        '<meta charset="utf-8" />',
        '<meta http-equiv="Content-Security-Policy" content="' + csp + '" />',
        '<title>复制给 Agent</title>',
        '<style>',
        '  html, body { height: 100%; margin: 0; }',
        '  body {',
        '    box-sizing: border-box;',
        '    display: flex;',
        '    flex-direction: column;',
        '    gap: 8px;',
        '    padding: 10px 12px;',
        '    font-family: var(--vscode-font-family);',
        '    font-size: var(--vscode-font-size, 13px);',
        '    color: var(--vscode-foreground);',
        '    background: var(--vscode-editor-background);',
        '  }',
        '  .bar { display: flex; align-items: center; gap: 10px; }',
        '  .title { font-weight: 600; white-space: nowrap; }',
        '  /* 统计 / MOD / 每段条数 / 报告路径：换行铺满，一个字都不省 */',
        '  .sub { display: flex; flex-wrap: wrap; align-items: baseline; gap: 2px 14px; }',
        '  .stats, .meta, .wrap-toggle { font-size: 11px; color: var(--vscode-descriptionForeground); }',
        '  .meta { white-space: normal; overflow-wrap: anywhere; }',
        '  .grow { flex: 1; }',
        '  .wrap-toggle { display: inline-flex; align-items: center; gap: 4px; white-space: nowrap; cursor: pointer; }',
        '  .wrap-toggle input { margin: 0; }',
        '  .actions { display: flex; gap: 6px; margin-left: auto; flex-shrink: 0; }',
        '  button {',
        '    padding: 3px 10px;',
        '    font-family: inherit;',
        '    font-size: 12px;',
        '    border-radius: 2px;',
        '    border: 1px solid transparent;',
        '    cursor: pointer;',
        '  }',
        '  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }',
        '  button.primary:hover { background: var(--vscode-button-hoverBackground); }',
        '  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }',
        '  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }',
        '  button:disabled { opacity: 0.5; cursor: default; }',
        '  textarea {',
        '    flex: 1;',
        '    min-height: 0;',
        '    padding: 8px;',
        '    font-family: var(--vscode-editor-font-family, monospace);',
        '    font-size: var(--vscode-editor-font-size, 12px);',
        '    line-height: 1.45;',
        '    white-space: pre-wrap;',
        '    overflow-wrap: anywhere;',
        '    overflow: auto;',
        '    resize: none;',
        '    color: var(--vscode-input-foreground);',
        '    background: var(--vscode-input-background);',
        '    border: 1px solid var(--vscode-input-border, transparent);',
        '    border-radius: 2px;',
        '  }',
        '  textarea:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }',
        '  textarea.no-wrap { white-space: pre; overflow-wrap: normal; }',
        '  .banner { font-size: 11px; color: var(--vscode-descriptionForeground); min-height: 14px; }',
        '  .banner.ok { color: var(--vscode-charts-green, #89d185); }',
        '  .banner.err { color: var(--vscode-errorForeground); }',
        '</style>',
        '</head>',
        '<body>',
        '  <div class="bar">',
        '    <span class="title">复制给 Agent 前检查</span>',
        '    <div class="actions">',
        '      <button type="button" class="secondary" id="regen">重新生成</button>',
        '      <button type="button" class="primary" id="copy">复制到剪贴板</button>',
        '    </div>',
        '  </div>',
        '  <div class="sub">',
        '    <span class="stats" id="stats"></span>',
        '    <span class="meta" id="meta"></span>',
        '    <label class="wrap-toggle"><input type="checkbox" id="wrap" checked /> 自动换行</label>',
        '  </div>',
        '  <textarea id="text" spellcheck="false"></textarea>',
        '  <div class="banner" id="banner">下面是即将复制的全文，可以直接改；改了只影响复制，落盘的 .md 报告不变。</div>',
        '  <script nonce="' + nonce + '">',
        '    (function () {',
        '      var vscode = acquireVsCodeApi();',
        '      var textEl = document.getElementById("text");',
        '      var statsEl = document.getElementById("stats");',
        '      var metaEl = document.getElementById("meta");',
        '      var bannerEl = document.getElementById("banner");',
        '      var copyBtn = document.getElementById("copy");',
        '      var regenBtn = document.getElementById("regen");',
        '      var wrapEl = document.getElementById("wrap");',
        '      var busy = false;',
        '',
        '      function formatCount(value) {',
        '        if (!isFinite(value) || value <= 0) { return "0"; }',
        '        if (value < 1000) { return String(Math.round(value)); }',
        '        if (value < 1000000) {',
        '          var kilo = value / 1000;',
        '          return (kilo >= 100 ? String(Math.round(kilo)) : kilo.toFixed(1).replace(".0", "")) + "k";',
        '        }',
        '        var mega = value / 1000000;',
        '        return (mega >= 100 ? String(Math.round(mega)) : mega.toFixed(1).replace(".0", "")) + "M";',
        '      }',
        '',
        '      function updateStats() {',
        '        var text = textEl.value || "";',
        '        var lines = text ? text.split(String.fromCharCode(10)).length : 0;',
        '        statsEl.textContent = formatCount(text.length) + " 字 · " + formatCount(lines) + " 行";',
        '        copyBtn.disabled = busy || !text.trim();',
        '        regenBtn.disabled = busy;',
        '      }',
        '',
        '      function setBanner(text, kind) {',
        '        bannerEl.textContent = text;',
        '        bannerEl.className = "banner" + (kind ? " " + kind : "");',
        '      }',
        '',
        '      copyBtn.addEventListener("click", function () {',
        '        vscode.postMessage({ type: "copy", text: textEl.value });',
        '      });',
        '      regenBtn.addEventListener("click", function () {',
        '        vscode.postMessage({ type: "regenerate" });',
        '      });',
        '      textEl.addEventListener("input", updateStats);',
        '      wrapEl.addEventListener("change", function () {',
        '        textEl.className = wrapEl.checked ? "" : "no-wrap";',
        '      });',
        '',
        '      window.addEventListener("message", function (event) {',
        '        var message = event.data || {};',
        '        if (message.type === "setPrompt") {',
        '          textEl.value = typeof message.prompt === "string" ? message.prompt : "";',
        '          var parts = [];',
        '          if (typeof message.mod === "string" && message.mod) { parts.push(message.mod); }',
        '          if (typeof message.copyLimit === "number" && message.copyLimit > 0) {',
        '            parts.push("每段前 " + message.copyLimit);',
        '          } else {',
        '            parts.push("全部");',
        '          }',
        '          if (message.classes === "only") {',
        '            parts.push("仅类/模块汇总");',
        '          } else if (message.classes === "none") {',
        '            parts.push("无类/模块汇总");',
        '          }',
        '          if (typeof message.reportPath === "string" && message.reportPath) {',
        '            parts.push(message.reportPath);',
        '            metaEl.title = message.reportPath;',
        '          }',
        '          metaEl.textContent = parts.join(" · ");',
        '          setBanner("下面是即将复制的全文，可以直接改；改了只影响复制，落盘的 .md 报告不变。", "");',
        '          updateStats();',
        '        } else if (message.type === "copyResult") {',
        '          setBanner(message.message || (message.ok ? "已复制" : "复制失败"), message.ok ? "ok" : "err");',
        '        } else if (message.type === "busy") {',
        '          busy = Boolean(message.value);',
        '          setBanner(busy ? "正在重新生成…" : "", "");',
        '          updateStats();',
        '        }',
        '      });',
        '',
        '      updateStats();',
        '      vscode.postMessage({ type: "ready" });',
        '    })();',
        '  </script>',
        '</body>',
        '</html>'
    ].join('\n');
}
