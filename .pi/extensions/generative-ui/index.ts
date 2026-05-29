import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { Text } from "@mariozechner/pi-tui";
import { join, dirname } from "node:path";
import { writeFile } from "node:fs/promises";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { getGuidelines, AVAILABLE_MODULES } from "./guidelines.js";
import { SVG_STYLES } from "./svg-styles.js";


const __dirname = dirname(fileURLToPath(import.meta.url));
const GLIMPSE_PATH = join(__dirname, "../../../node_modules/glimpseui/src/glimpse.mjs");
const execFileAsync = promisify(execFile);

function safeSvgFilename(name: string): string {
  const base = name.replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || "diagram.svg";
  return base.toLowerCase().endsWith(".svg") ? base : `${base}.svg`;
}

async function chooseSvgSavePath(filename: string): Promise<string | null> {
  const script = [
    `set defaultName to ${JSON.stringify(filename)}`,
    'try',
    '  set chosenFile to choose file name with prompt "Save SVG as:" default name defaultName',
    '  return POSIX path of chosenFile',
    'on error number -128',
    '  return ""',
    'end try',
  ].join("\n");
  const { stdout } = await execFileAsync("osascript", ["-e", script]);
  const path = stdout.trim();
  return path ? path : null;
}

async function copyTextToClipboard(text: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const proc = spawn("pbcopy");
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error(`pbcopy exited with ${code}`)));
    proc.stdin.end(text);
  });
}

// Shell HTML with a root container — used for streaming.
// Content is injected via win.send() JS eval, not setHTML(), to avoid full-page flashes.
function shellHTML(): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>
*{box-sizing:border-box}
body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0;}
@keyframes _fadeIn{from{opacity:0;transform:translateY(4px);}to{opacity:1;transform:none;}}
${SVG_STYLES}
</style>
</head><body><div id="root"></div>
<script>
  window._morphReady = false;
  window._pending = null;
  window._setContent = function(html) {
    if (!window._morphReady) { window._pending = html; return; }
    var root = document.getElementById('root');
    var target = document.createElement('div');
    target.id = 'root';
    target.innerHTML = html;
    morphdom(root, target, {
      onBeforeElUpdated: function(from, to) {
        if (from.isEqualNode(to)) return false;
        return true;
      },
      onNodeAdded: function(node) {
        if (node.nodeType === 1 && node.tagName !== 'STYLE' && node.tagName !== 'SCRIPT') {
          node.style.animation = '_fadeIn 0.3s ease both';
        }
        return node;
      }
    });
  };
  window._runScripts = function() {
    document.querySelectorAll('#root script').forEach(function(old) {
      var s = document.createElement('script');
      if (old.src) { s.src = old.src; } else { s.textContent = old.textContent; }
      old.parentNode.replaceChild(s, old);
    });
  };
</script>
<script src="https://cdn.jsdelivr.net/npm/morphdom@2.7.4/dist/morphdom-umd.min.js"
  onload="window._morphReady=true;if(window._pending){window._setContent(window._pending);window._pending=null;}"></script>
</body></html>`;
}

// Wrap HTML fragment into a full document for Glimpse (non-streaming fallback)
function wrapHTML(code: string, isSVG = false): string {
  if (isSVG) {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${SVG_STYLES}</style></head>
<body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#1a1a1a;color:#e0e0e0;">
${code}</body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<style>*{box-sizing:border-box}body{margin:0;padding:1rem;font-family:system-ui,-apple-system,sans-serif;background:#1a1a1a;color:#e0e0e0}${SVG_STYLES}</style>
</head><body>${code}</body></html>`;
}

// Escape a string for safe injection into a JS string literal
function escapeJS(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/<\/script>/gi, '<\\/script>');
}

function svgSaverInstallJS(): string {
  return `(() => {
    if (window.__glimpseSvgSaverInstalled) return;
    window.__glimpseSvgSaverInstalled = true;

    let activeSvg = null;
    let hideTimer = null;
    let pending = false;
    let readyToExport = false;

    const host = document.createElement('div');
    host.style.cssText = 'position:fixed;z-index:2147483647;display:none;font-family:system-ui,-apple-system,sans-serif;color:#d8d5cf;';

    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.innerHTML = '<span></span><span></span><span></span>';
    trigger.setAttribute('aria-label', 'SVG actions');
    trigger.style.cssText = 'width:28px;height:28px;border:0;border-radius:7px;background:#262624;display:flex;align-items:center;justify-content:center;gap:3px;cursor:default;padding:0;transition:background .16s ease;';
    Array.from(trigger.children).forEach(dot => { dot.style.cssText = 'width:3.5px;height:3.5px;border-radius:50%;background:#c8c5bd;display:block;'; });

    const menu = document.createElement('div');
    menu.style.cssText = 'position:absolute;right:0;top:34px;width:198px;padding:6px 0;border-radius:12px;background:#262624;border:1px solid rgba(255,255,255,.14);box-shadow:0 12px 28px rgba(0,0,0,.36);display:none;overflow:hidden;';

    function menuItem(icon, text) {
      const item = document.createElement('button');
      item.type = 'button';
      item.style.cssText = 'width:100%;height:38px;margin:0;border:0;border-radius:0;background:transparent;color:#d8d5cf;display:flex;align-items:center;gap:12px;padding:0 14px;font:400 15px/1 system-ui,-apple-system,sans-serif;text-align:left;cursor:default;white-space:nowrap;transition:background .16s ease;';
      const iconBox = document.createElement('span');
      iconBox.innerHTML = icon;
      iconBox.style.cssText = 'width:20px;height:20px;color:#d8d5cf;flex:0 0 20px;display:flex;align-items:center;justify-content:center;';
      const label = document.createElement('span');
      label.textContent = text;
      item.append(iconBox, label);
      item.addEventListener('mouseenter', () => { if (!item.disabled) item.style.background = '#141413'; });
      item.addEventListener('mouseleave', () => { item.style.background = 'transparent'; });
      return { item, label };
    }

    const copy = menuItem('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="8" y="8" width="12" height="12" rx="2"/><rect x="4" y="4" width="12" height="12" rx="2"/></svg>', 'Copy to clipboard');
    const download = menuItem('<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>', 'Download file');
    menu.append(copy.item, download.item);
    host.append(trigger, menu);
    document.body.appendChild(host);

    function filenameFor(svg) {
      const title = (document.title || 'diagram').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const titleNode = svg.querySelector('title');
      const labelled = svg.getAttribute('aria-label') || (titleNode && titleNode.textContent) || title || 'diagram';
      return labelled.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') + '.svg';
    }

    function collectStyles() {
      return Array.from(document.styleSheets).map(sheet => {
        try { return Array.from(sheet.cssRules || []).map(rule => rule.cssText).join('\\n'); }
        catch (_) { return ''; }
      }).filter(Boolean).join('\\n');
    }

    function serialize(svg) {
      const clone = svg.cloneNode(true);
      if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      if (!clone.getAttribute('xmlns:xlink')) clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
      const css = collectStyles();
      if (css) {
        const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
        style.textContent = css;
        clone.insertBefore(style, clone.firstChild);
      }
      return '<?xml version="1.0" encoding="UTF-8"?>\\n' + new XMLSerializer().serializeToString(clone);
    }

    function setExportReady(ready) {
      readyToExport = ready;
      copy.item.disabled = !ready;
      download.item.disabled = !ready;
      [copy.item, download.item].forEach(item => {
        item.style.opacity = ready ? '1' : '.45';
        item.style.cursor = ready ? 'default' : 'not-allowed';
        if (!ready) item.style.background = 'transparent';
      });
    }
    setExportReady(false);

    function send(action) {
      if (!readyToExport || pending || !window.glimpse || typeof window.glimpse.send !== 'function') return;
      const svg = activeSvg || document.querySelector('svg');
      if (!svg) return;
      activeSvg = svg;
      pending = true;
      const label = action === 'copy' ? copy.label : download.label;
      label.textContent = action === 'copy' ? 'Copying…' : 'Choosing file…';
      window.glimpse.send({ __glimpse_svg_action: action, filename: filenameFor(svg), svg: serialize(svg) });
    }

    window.__glimpseSvgSaverExport = function(action) {
      send(action);
      return true;
    };
    window.__glimpseSvgSaverSetReady = setExportReady;

    function showMenu() { clearTimeout(hideTimer); menu.style.display = 'block'; trigger.style.background = '#141413'; trigger.style.outline = '4px solid #8fc5ff'; }
    function hideMenu() { menu.style.display = 'none'; trigger.style.background = '#262624'; trigger.style.outline = 'none'; }
    function scheduleHide() { clearTimeout(hideTimer); hideTimer = setTimeout(() => { hideMenu(); host.style.display = 'none'; activeSvg = null; }, 450); }

    function showFor(svg) {
      activeSvg = svg;
      clearTimeout(hideTimer);
      const rect = svg.getBoundingClientRect();
      host.style.display = 'block';
      host.style.left = Math.max(8, Math.min(window.innerWidth - 28 - 8, rect.right - 28 - 8)) + 'px';
      host.style.top = Math.max(8, rect.top + 8) + 'px';
    }

    document.addEventListener('mouseover', (event) => {
      const svg = event.target && event.target.closest && event.target.closest('svg');
      if (svg) showFor(svg);
    });
    document.addEventListener('mouseout', (event) => {
      const svg = event.target && event.target.closest && event.target.closest('svg');
      if (svg && !svg.contains(event.relatedTarget) && !host.contains(event.relatedTarget)) scheduleHide();
    });
    host.addEventListener('mouseenter', showMenu);
    host.addEventListener('mouseleave', scheduleHide);
    copy.item.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); send('copy'); });
    download.item.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); send('download'); });
    window.addEventListener('glimpse-svg-action-result', (event) => {
      pending = false;
      copy.label.textContent = 'Copy to clipboard';
      download.label.textContent = 'Download file';
      if (event.detail && event.detail.ok) {
        const label = event.detail.action === 'copy' ? copy.label : download.label;
        label.textContent = event.detail.action === 'copy' ? 'Copied' : 'Saved';
        setTimeout(() => { copy.label.textContent = 'Copy to clipboard'; download.label.textContent = 'Download file'; }, 1200);
      }
    });
    window.addEventListener('scroll', () => { if (activeSvg) showFor(activeSvg); }, true);
    window.addEventListener('resize', () => { if (activeSvg) showFor(activeSvg); });
  })();`;
}

function installSvgSaver(win: any) {
  try { win.send(svgSaverInstallJS()); } catch {}
}

function setSvgSaverReady(win: any, ready: boolean) {
  try { win.send(`window.__glimpseSvgSaverSetReady && window.__glimpseSvgSaverSetReady(${ready ? "true" : "false"});`); } catch {}
}

function dispatchSvgActionResult(win: any, detail: any) {
  try { win.send(`window.dispatchEvent(new CustomEvent('glimpse-svg-action-result', { detail: ${JSON.stringify(detail)} }));`); } catch {}
}

export default function (pi: ExtensionAPI) {
  let hasSeenReadMe = false;
  let activeWindows: any[] = [];
  let glimpseModule: any = null;
  const svgActionHandlers = new WeakSet<object>();

  // Lazy-load glimpse module
  async function getGlimpse() {
    if (!glimpseModule) {
      glimpseModule = await import(GLIMPSE_PATH);
    }
    return glimpseModule;
  }

  async function handleSvgAction(win: any, data: any, fallbackTitle: string) {
    const action = data.__glimpse_svg_action;
    try {
      if (action === "copy") {
        await copyTextToClipboard(data.svg);
      } else if (action === "download") {
        const filename = safeSvgFilename(String(data.filename ?? fallbackTitle ?? "diagram.svg"));
        const filePath = await chooseSvgSavePath(filename);
        if (!filePath) {
          dispatchSvgActionResult(win, { ok: false, action, cancelled: true });
          return;
        }
        await writeFile(filePath, data.svg, "utf8");
      } else {
        throw new Error(`Unknown SVG action: ${action}`);
      }
      dispatchSvgActionResult(win, { ok: true, action });
    } catch (err: any) {
      dispatchSvgActionResult(win, { ok: false, action, error: err?.message ?? String(err) });
    }
  }

  function attachSvgActionHandler(win: any, fallbackTitle: string) {
    if (svgActionHandlers.has(win)) return;
    svgActionHandlers.add(win);
    win.on("message", async (data: any) => {
      if (data?.__glimpse_svg_action && typeof data.svg === "string") {
        await handleSvgAction(win, data, fallbackTitle);
      }
    });
  }

  // ── Streaming state ─────────────────────────────────────────────────────

  // Tracks in-flight show_widget tool calls being streamed
  interface StreamingWidget {
    contentIndex: number;
    window: any | null;
    lastHTML: string;
    updateTimer: any;
    ready: boolean;
  }

  let streaming: StreamingWidget | null = null;

  // ── message_update: intercept streaming tool calls ────────────────────

  pi.on("message_update", async (event) => {
    const raw: any = event.assistantMessageEvent;
    if (!raw) return;

    // Tool call starts streaming
    if (raw.type === "toolcall_start") {
      const partial: any = raw.partial;
      const block = partial?.content?.[raw.contentIndex];
      if (block?.type === "toolCall" && block?.name === "show_widget") {
        streaming = {
          contentIndex: raw.contentIndex,
          window: null,
          lastHTML: "",
          updateTimer: null,
          ready: false,
        };
      }
      return;
    }

    // Tool call input JSON delta — arguments already parsed by pi-ai
    if (raw.type === "toolcall_delta" && streaming && raw.contentIndex === streaming.contentIndex) {
      const partial: any = raw.partial;
      const block = partial?.content?.[raw.contentIndex];
      const html = block?.arguments?.widget_code;
      if (!html || html.length < 20 || html === streaming.lastHTML) return;

      streaming.lastHTML = html;

      // Debounce updates to ~150ms for smooth rendering
      if (streaming.updateTimer) return;
      streaming.updateTimer = setTimeout(async () => {
        if (!streaming) return;
        streaming.updateTimer = null;

        try {
          if (!streaming.window) {
            // Open window with empty shell — content will be injected via JS eval
            const args = block?.arguments ?? {};
            const title = (args.title ?? "Widget").replace(/_/g, " ");
            const width = args.width ?? 800;
            const height = args.height ?? 600;

            const { open } = await getGlimpse();
            streaming.window = open(shellHTML(), { width, height, title });
            activeWindows.push(streaming.window);
            attachSvgActionHandler(streaming.window, title);

            streaming.window.on("ready", () => {
              if (!streaming) return;
              streaming.ready = true;
              installSvgSaver(streaming.window);
              setSvgSaverReady(streaming.window, false);
              // Inject the content we've accumulated so far
              const escaped = escapeJS(streaming.lastHTML);
              streaming.window.send(`window._setContent('${escaped}')`);
            });
          } else if (streaming.ready) {
            // Update content via JS — no full page replace
            const escaped = escapeJS(streaming.lastHTML);
            streaming.window.send(`window._setContent('${escaped}')`);
          }
        } catch {}
      }, 150);
      return;
    }

    // Tool call complete — final update with complete HTML + execute scripts
    if (raw.type === "toolcall_end" && streaming && raw.contentIndex === streaming.contentIndex) {
      if (streaming.updateTimer) {
        clearTimeout(streaming.updateTimer);
        streaming.updateTimer = null;
      }

      const toolCall = raw.toolCall;
      if (toolCall?.arguments?.widget_code && streaming.window && streaming.ready) {
        const escaped = escapeJS(toolCall.arguments.widget_code);
        streaming.window.send(`window._setContent('${escaped}'); window._runScripts();`);
        setSvgSaverReady(streaming.window, true);
      }
      // Don't clear streaming — execute() will pick up the window
      return;
    }
  });

  // ── read_me tool ──────────────────────────────────────────────────────────

  pi.registerTool({
    name: "visualize_read_me",
    label: "Read Guidelines",
    description:
      "Returns design guidelines for show_widget (CSS patterns, colors, typography, layout rules, examples). " +
      "Call once before your first show_widget call. Do NOT mention this call to the user — it is an internal setup step.",
    promptSnippet: "Load design guidelines before creating widgets. Call silently before first show_widget use.",
    promptGuidelines: [
      "Call visualize_read_me once before your first show_widget call to load design guidelines.",
      "Do NOT mention the read_me call to the user — call it silently, then proceed directly to building the widget.",
      "Pick the modules that match your use case: interactive, chart, mockup, art, diagram.",
    ],
    parameters: Type.Object({
      modules: Type.Array(
        StringEnum(AVAILABLE_MODULES as readonly string[]),
        { description: "Which module(s) to load. Pick all that fit." }
      ),
    }),

    async execute(_toolCallId, params) {
      hasSeenReadMe = true;
      const content = getGuidelines(params.modules);
      return {
        content: [{ type: "text" as const, text: content }],
        details: { modules: params.modules },
      };
    },

    renderCall(args: any, theme: any) {
      const mods = (args.modules ?? []).join(", ");
      return new Text(
        theme.fg("toolTitle", theme.bold("read_me ")) + theme.fg("muted", mods),
        0, 0
      );
    },

    renderResult(_result: any, { isPartial }: any, theme: any) {
      if (isPartial) return new Text(theme.fg("warning", "Loading guidelines..."), 0, 0);
      return new Text(theme.fg("dim", "Guidelines loaded"), 0, 0);
    },
  });

  // ── show_widget tool ──────────────────────────────────────────────────────

  pi.registerTool({
    name: "show_widget",
    label: "Show Widget",
    description:
      "Show visual content — SVG graphics, diagrams, charts, or interactive HTML widgets — in a native macOS window. " +
      "Use for flowcharts, dashboards, forms, calculators, data tables, games, illustrations, or any visual content. " +
      "The HTML is rendered in a native WKWebView with full CSS/JS support including Canvas and CDN libraries. " +
      "The page gets a window.glimpse.send(data) bridge to send JSON data back to the agent. " +
      "IMPORTANT: Call visualize_read_me once before your first show_widget call.",
    promptSnippet: "Render interactive HTML/SVG widgets in a native macOS window (WKWebView). Supports full CSS, JS, Canvas, Chart.js.",
    promptGuidelines: [
      "Use show_widget when the user asks for visual content: charts, diagrams, interactive explainers, UI mockups, art.",
      "Always call visualize_read_me first to load design guidelines, then set i_have_seen_read_me: true.",
      "The widget opens in a native macOS window — it has full browser capabilities (Canvas, JS, CDN libraries).",
      "Structure HTML as fragments: no DOCTYPE/<html>/<head>/<body>. Style first, then HTML, then scripts.",
      "The page has window.glimpse.send(data) to send data back. Use it for user choices and interactions.",
      "Keep widgets focused and appropriately sized. Default is 800x600 but adjust to fit content.",
      "For interactive explainers: sliders, live calculations, Chart.js charts.",
      "For SVG: start code with <svg> tag, it will be auto-detected.",
      "Be concise in your responses",
    ],
    parameters: Type.Object({
      i_have_seen_read_me: Type.Boolean({
        description: "Confirm you have already called visualize_read_me in this conversation.",
      }),
      title: Type.String({
        description: "Short snake_case identifier for this widget (used as window title).",
      }),
      widget_code: Type.String({
        description:
          "HTML or SVG code to render. For SVG: raw SVG starting with <svg>. " +
          "For HTML: raw content fragment, no DOCTYPE/<html>/<head>/<body>.",
      }),
      width: Type.Optional(Type.Number({ description: "Window width in pixels. Default: 800." })),
      height: Type.Optional(Type.Number({ description: "Window height in pixels. Default: 600." })),
      floating: Type.Optional(Type.Boolean({ description: "Keep window always on top. Default: false." })),
    }),

    async execute(_toolCallId, params, signal) {
      if (!params.i_have_seen_read_me) {
        throw new Error("You must call visualize_read_me before show_widget. Set i_have_seen_read_me: true after doing so.");
      }

      const code = params.widget_code;
      const isSVG = code.trimStart().startsWith("<svg");
      const title = params.title.replace(/_/g, " ");
      const width = params.width ?? 800;
      const height = params.height ?? 600;

      // Check if we already have a streaming window from message_update
      let win: any = null;
      let shouldInstallSvgSaverNow = false;

      if (streaming?.window) {
        win = streaming.window;
        shouldInstallSvgSaverNow = streaming.ready;
        // Send final complete HTML + run scripts via JS eval (no full page replace)
        if (streaming.ready) {
          const escaped = escapeJS(code);
          win.send(`window._setContent('${escaped}'); window._runScripts();`);
        }
        streaming = null;
      } else {
        // No streaming window — open fresh (fallback for non-streaming providers)
        const { open } = await getGlimpse();
        win = open(wrapHTML(code, isSVG), {
          width,
          height,
          title,
          floating: params.floating ?? false,
        });
        activeWindows.push(win);
      }

      return new Promise<any>((resolve) => {
        let messageData: any = null;
        let resolved = false;

        const finish = (reason: string) => {
          if (resolved) return;
          resolved = true;
          activeWindows = activeWindows.filter((w) => w !== win);
          resolve({
            content: [
              {
                type: "text" as const,
                text: messageData
                  ? `Widget rendered. User interaction data: ${JSON.stringify(messageData)}`
                  : `Widget "${title}" rendered and shown to the user (${width}×${height}). ${reason}`,
              },
            ],
            details: {
              title: params.title,
              width,
              height,
              isSVG,
              messageData,
              closedReason: reason,
            },
          });
        };

        attachSvgActionHandler(win, params.title);
        win.on("message", async (data: any) => {
          if (data?.__glimpse_svg_action) return;
          messageData = data;
          finish("User sent data from widget.");
        });

        win.on("ready", () => { installSvgSaver(win); setSvgSaverReady(win, true); });
        if (shouldInstallSvgSaverNow || win.info) { installSvgSaver(win); setSvgSaverReady(win, true); }

        win.on("closed", () => {
          finish("Window closed by user.");
        });

        win.on("error", (err: Error) => {
          finish(`Error: ${err.message}`);
        });

        if (signal) {
          signal.addEventListener("abort", () => {
            try { win.close(); } catch {}
            finish("Aborted.");
          }, { once: true });
        }

        // Auto-resolve after 120s if no interaction
        setTimeout(() => {
          finish("Widget still open (timed out waiting for interaction).");
        }, 120_000);
      });
    },

    renderCall(args: any, theme: any) {
      const title = (args.title ?? "widget").replace(/_/g, " ");
      const size = args.width && args.height ? ` ${args.width}×${args.height}` : "";
      let text = theme.fg("toolTitle", theme.bold("show_widget "));
      text += theme.fg("accent", title);
      if (size) text += theme.fg("dim", size);
      return new Text(text, 0, 0);
    },

    renderResult(result: any, { isPartial, expanded }: any, theme: any) {
      if (isPartial) {
        return new Text(theme.fg("warning", "⟳ Widget rendering..."), 0, 0);
      }

      const details = result.details ?? {};
      const title = (details.title ?? "widget").replace(/_/g, " ");
      let text = theme.fg("success", "✓ ") + theme.fg("accent", title);
      text += theme.fg("dim", ` ${details.width ?? 800}×${details.height ?? 600}`);
      if (details.isSVG) text += theme.fg("dim", " (SVG)");

      if (details.closedReason) {
        text += "\n" + theme.fg("muted", `  ${details.closedReason}`);
      }

      if (expanded && details.messageData) {
        text += "\n" + theme.fg("dim", `  Data: ${JSON.stringify(details.messageData, null, 2)}`);
      }

      return new Text(text, 0, 0);
    },
  });

  // ── cleanup on shutdown ───────────────────────────────────────────────────

  pi.on("session_shutdown", async () => {
    if (streaming?.updateTimer) clearTimeout(streaming.updateTimer);
    streaming = null;
    for (const win of activeWindows) {
      try { win.close(); } catch {}
    }
    activeWindows = [];
  });
}
