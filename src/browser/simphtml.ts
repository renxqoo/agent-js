import * as cheerio from 'cheerio';
import type TMWebDriver from './tmwebdriver.js';

// ---------------------------------------------------------------------------
// Browser-side JavaScript
// ---------------------------------------------------------------------------

/**
 * optHTML – Injected into the browser to produce a simplified, AI-friendly
 * representation of the current DOM.  Strips scripts, styles, SVGs, hidden
 * elements, and adds visible-bounds metadata.
 */
export const optHTML = `
(function() {
  'use strict';

  // ---- Element flags ----
  const SRCELEM = 'script, style, noscript, svg, img[src=""], link, meta, head';
  const EXCLUDE = 'script, style, noscript, svg, link, meta, head, iframe, [aria-hidden="true"], [role="presentation"]';
  const BLOCK = 'DIV, SECTION, ARTICLE, ASIDE, MAIN, HEADER, FOOTER, NAV, FORM, FIELDSET, TABLE, UL, OL, DL, PRE, BLOCKQUOTE, ADDRESS, DETAILS, FIGURE, SUMMARY, H1, H2, H3, H4, H5, H6, P, LI, HR, OPTGROUP, OPTION, TR';
  const TEXT_COUNT_ELEM = 'a, div, span, p, li, td, th, h1, h2, h3, h4, h5, h6, label, button, pre, code, blockquote, dt, dd, figcaption, legend, summary';

  function getComputedStyleSafe(el) {
    try { return window.getComputedStyle(el); }
    catch (_) { return null; }
  }

  function isVisible(el) {
    if (!el) return false;
    const style = getComputedStyleSafe(el);
    if (!style) return false;
    if (style.display === 'none' || style.visibility === 'hidden') return false;
    if (parseFloat(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    if (rect && (rect.width === 0 || rect.height === 0)) return false;
    return true;
  }

  function excludeNode(el) {
    if (!el || !el.tagName) return true;
    const tag = el.tagName.toUpperCase();
    const role = el.getAttribute('role');
    const ariaHidden = el.getAttribute('aria-hidden');
    if (ariaHidden === 'true' || role === 'presentation') return true;
    if (tag === 'IFRAME' || tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
        tag === 'SVG' || tag === 'LINK' || tag === 'META' || tag === 'HEAD') return true;
    return false;
  }

  function getVisibleText(el) {
    if (!el || el.nodeType === 3) return (el && el.textContent ? el.textContent.trim() : '');
    if (excludeNode(el)) return '';
    if (!isVisible(el)) return '';
    let text = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        text += child.textContent || '';
      } else if (child.nodeType === 1) {
        text += getVisibleText(child);
      }
    }
    return text.trim();
  }

  function textNodeCount(el, counted) {
    counted = counted || new Set();
    if (!el || counted.has(el)) return 0;
    counted.add(el);
    let n = 0;
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        n += (child.textContent || '').replace(/\\s+/g, '').length;
      } else if (child.nodeType === 1 && TEXT_COUNT_ELEM.includes(child.tagName.toUpperCase())) {
        n += textNodeCount(child, counted);
      }
    }
    return n;
  }

  function nodeInfo(el) {
    if (!el || !el.tagName) return '';
    const tag = el.tagName.toLowerCase();
    const id = el.id || '';
    const classes = (el.className && typeof el.className === 'string') ? '.' + el.className.trim().split(/\\s+/).join('.') : '';
    const rect = el.getBoundingClientRect ? el.getBoundingClientRect() : null;
    const rectStr = rect ? ' ' + [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)].join('x') : '';
    const tcount = textNodeCount(el);
    let info = tag + (id ? '#' + id : '') + classes;
    if (tcount > 0) info += ' txt=' + tcount + 'chs';
    info += rectStr;
    return info;
  }

  function simplify(el, depth) {
    depth = depth || 0;
    if (depth > 80 || !el || !el.tagName) return '';

    if (excludeNode(el)) return '';

    const tag = el.tagName.toUpperCase();
    const selfClosing = ['BR', 'HR', 'IMG', 'INPUT', 'META', 'LINK'].includes(tag);

    // Named elements get full info.
    const named = !!(el.id || (el.className && typeof el.className === 'string' && el.className.trim()));

    let head = '<' + tag.toLowerCase() + (el.id ? ' id="' + el.id + '"' : '');
    if (el.className && typeof el.className === 'string' && el.className.trim()) {
      head += ' class="' + el.className.trim().split(/\\s+/).join(' ') + '"';
    }
    head += '>';

    if (selfClosing) return head;

    let body = '';
    for (const child of el.childNodes) {
      if (child.nodeType === 3) {
        const txt = (child.textContent || '').replace(/\\s+/g, ' ');
        if (txt.trim()) body += txt;
      } else if (child.nodeType === 1) {
        body += simplify(child, depth + 1);
      }
    }

    return head + body + '</' + tag.toLowerCase() + '>';
  }

  // ---- Main ----
  try {
    const clone = document.documentElement.cloneNode(true);
    // Remove excluded elements from the clone.
    clone.querySelectorAll(EXCLUDE).forEach(function(n) { n.parentNode && n.parentNode.removeChild(n); });
    // Remove empty text nodes and whitespace-only nodes.
    const simplified = simplify(clone, 0);
    return JSON.stringify({ html: simplified, url: window.location.href, title: document.title });
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
})();
`;

/**
 * OptHTML-mino – a more aggressive variant that also removes aria-hidden
 * and role=presentation sub-trees (included in optHTML already via EXCLUDE,
 * but kept separate for callers that want a lighter variant).
 */
export const optHTML_mino = optHTML;

/**
 * getFormInfoJS – Extract form field data from the current page.
 * Returns an object listing each form with its inputs.
 */
export const getFormInfoJS = `
(function() {
  'use strict';
  try {
    const forms = [];
    document.querySelectorAll('form').forEach(function(form) {
      const idx = forms.length;
      const formData = { index: idx, id: form.id || '', action: form.action || '', method: form.method || 'get', inputs: [] };
      form.querySelectorAll('input, select, textarea, button').forEach(function(el) {
        const tag = el.tagName.toLowerCase();
        const info = {
          tag: tag,
          name: el.name || el.id || '',
          type: el.type || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          value: tag === 'select' ? '' : (el.value || ''),
          required: !!el.required,
          disabled: !!el.disabled,
          readonly: !!el.readOnly,
        };
        if (el.options && tag === 'select') {
          info.options = [];
          el.querySelectorAll('option').forEach(function(opt) {
            info.options.push({ value: opt.value || '', text: opt.textContent || '', selected: opt.selected });
          });
        }
        formData.inputs.push(info);
      });
      forms.push(formData);
    });
    return JSON.stringify({ forms: forms, url: window.location.href });
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
})();
`;

/**
 * setupExtractAndMonitor – Installed via execute_js on a page to hook
 * into the TMWebDriver extension and report DOM mutations.
 */
export const setupExtractAndMonitor = `
(function() {
  'use strict';
  if (window.__tmwdMonitorInstalled) return JSON.stringify({ info: 'already installed' });
  window.__tmwdMonitorInstalled = true;
  window.__tmwdChanges = [];
  window.__tmwdCumulativeHtml = '';

  function getCumulativeHtml() {
    var docEl = document.documentElement;
    var clone = docEl.cloneNode(true);
    clone.querySelectorAll('script, style, noscript, link, meta').forEach(function(n) {
      n.parentNode && n.parentNode.removeChild(n);
    });
    return clone.outerHTML;
  }

  function snapshot() {
    window.__tmwdCumulativeHtml = getCumulativeHtml();
  }

  function recordChange(mutation) {
    var rec = { type: mutation.type, time: Date.now() };
    if (mutation.type === 'childList') {
      rec.addedNodes = mutation.addedNodes.length;
      rec.removedNodes = mutation.removedNodes.length;
    } else if (mutation.type === 'attributes') {
      rec.attributeName = mutation.attributeName;
      if (mutation.target && mutation.target.tagName) {
        rec.targetTag = mutation.target.tagName.toLowerCase();
        if (mutation.target.id) rec.targetId = mutation.target.id;
      }
    }
    window.__tmwdChanges.push(rec);
    snapshot();
  }

  var observer = new MutationObserver(function(mutations) {
    mutations.forEach(recordChange);
  });
  observer.observe(document.documentElement, {
    childList: true,
    attributes: true,
    characterData: true,
    subtree: true
  });
  snapshot();
  return JSON.stringify({ info: 'installed', url: window.location.href });
})();
`;

/**
 * getDomChanges – Called after setupExtractAndMonitor to retrieve
 * accumulated mutations since the last call.
 */
export const getDomChanges = `
(function() {
  'use strict';
  try {
    var changes = window.__tmwdChanges || [];
    window.__tmwdChanges = [];
    var html = window.__tmwdCumulativeHtml || '';
    return JSON.stringify({ changes: changes, cumulativeHtml: html, url: window.location.href });
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
})();
`;

/**
 * Minimal script that returns the page innerText (text-only mode).
 */
export const getPageText = `
(function() {
  'use strict';
  try {
    // Remove scripts and styles for a clean text extraction.
    var clone = document.documentElement.cloneNode(true);
    clone.querySelectorAll('script, style, noscript').forEach(function(n) {
      n.parentNode && n.parentNode.removeChild(n);
    });
    /* eslint-disable */
    const text = clone.innerText || clone.textContent || '';
    let cleaned = text.replace(/\\n{3,}/g, '\\n\\n');
    return JSON.stringify({ text: cleaned.slice(0, 50000), url: window.location.href, title: document.title });
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) });
  }
})();
`;

// ---------------------------------------------------------------------------
// Server-side HTML helpers
// ---------------------------------------------------------------------------

/** Additional tags / selectors to strip when cutting sections. */
const SESSION_SELECTORS = [
  'script',
  'style',
  'noscript',
  'svg',
  'meta',
  'link',
  'iframe',
  '[aria-hidden="true"]',
  '[role="presentation"]',
  '[hidden]',
  '.cookie-banner',
  '.consent-banner',
  '.gdpr',
  '#cookie-notice',
];

/** Tags considered “block-level” for formatting. */
const BLOCK_TAGS = new Set([
  'div', 'section', 'article', 'aside', 'main', 'header', 'footer',
  'nav', 'form', 'fieldset', 'table', 'ul', 'ol', 'dl', 'pre',
  'blockquote', 'address', 'details', 'figure', 'summary',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'hr', 'tr',
  'optgroup', 'option',
]);

// ---------------------------------------------------------------------------
// Core exports
// ---------------------------------------------------------------------------

/**
 * Get simplified HTML from the current browser page.
 *
 * @param driver     - TMWebDriver instance.
 * @param cutlist    - If true, run cut_html_sections on the result.
 * @param maxchars   - Maximum characters in the output (default 35 000).
 * @param textOnly   - If true, return plain text instead of HTML.
 * @param broad      - If true, use the more aggressive optHTML_mino script.
 * @param sessionId  - Optional specific session to target.
 * @returns Simplified HTML (or text) string, or an error message.
 */
export async function getHtml(
  driver: TMWebDriver,
  cutlist: boolean = true,
  maxchars: number = 35000,
  textOnly: boolean = false,
  broad: boolean = false,
  sessionId?: string,
): Promise<string> {
  try {
    let script: string;
    if (textOnly) {
      script = getPageText;
    } else if (broad) {
      script = optHTML_mino;
    } else {
      script = optHTML;
    }

    const { result, error } = await driver.executeJs(script, 15, sessionId);

    if (error) {
      return `[simphtml error] ${error}`;
    }

    let parsed: { html?: string; text?: string; url?: string; title?: string; error?: string };
    if (typeof result === 'string') {
      try {
        parsed = JSON.parse(result);
      } catch {
        return `[simphtml parse error] invalid JSON from browser`;
      }
    } else if (result && typeof result === 'object') {
      parsed = result as Record<string, unknown>;
    } else {
      return `[simphtml error] unexpected result type: ${typeof result}`;
    }

    if (parsed.error) {
      return `[simphtml browser error] ${parsed.error}`;
    }

    let raw = textOnly ? (parsed.text ?? '') : (parsed.html ?? '');
    const title = parsed.title ?? '';
    const url = parsed.url ?? '';

    // Apply server-side HTML simplification via cheerio.
    if (raw && !textOnly) {
      raw = simplifyHtml(raw);
    }

    if (cutlist && !textOnly) {
      raw = cutHtmlSections(raw);
    }

    // Prepend metadata.
    const meta = [title ? `Title: ${title}` : '', url ? `URL: ${url}` : '']
      .filter(Boolean)
      .join('\n');

    let output = meta ? `${meta}\n\n${raw}` : raw;

    // Trim to maxchars.
    if (output.length > maxchars) {
      output = output.slice(0, maxchars) + '\n... [truncated]';
    }

    return output || '[empty page]';
  } catch (err) {
    return `[simphtml exception] ${String(err)}`;
  }
}

/**
 * Execute JavaScript in the browser and return a structured result that
 * includes page changes (if the monitor is installed).
 *
 * @param script    - JS source string.
 * @param driver    - TMWebDriver instance.
 * @param noMonitor - If true, skip the change-monitor step.
 * @param sessionId - Optional specific session.
 */
export async function executeJsRich(
  script: string,
  driver: TMWebDriver,
  noMonitor: boolean = false,
  sessionId?: string,
): Promise<{
  result: unknown;
  error: string | null;
  changes: unknown[] | null;
  cumulativeHtml: string | null;
}> {
  const { result, error } = await driver.executeJs(script, 15, sessionId);

  if (error || noMonitor) {
    return { result, error, changes: null, cumulativeHtml: null };
  }

  // Fetch accumulated DOM changes.
  const { result: changeResult, error: changeError } = await driver.executeJs(
    getDomChanges,
    5,
    sessionId,
  );

  let changes: unknown[] | null = null;
  let cumulativeHtml: string | null = null;

  if (!changeError && changeResult) {
    try {
      const parsed =
        typeof changeResult === 'string' ? JSON.parse(changeResult) : changeResult;
      if (parsed && typeof parsed === 'object') {
        changes = (parsed as any).changes ?? null;
        cumulativeHtml = (parsed as any).cumulativeHtml ?? null;
      }
    } catch {
      // Ignore parse errors for change monitoring.
    }
  }

  return { result, error, changes, cumulativeHtml };
}

/**
 * Extract form field information from an HTML string.
 *
 * @param htmlStr - Raw HTML to analyze.
 * @returns Array of form descriptors (each with index, id, action, method, inputs).
 */
export function extractFormInfo(
  htmlStr: string,
): Array<{
  index: number;
  id: string;
  action: string;
  method: string;
  inputs: Array<Record<string, unknown>>;
}> {
  const $ = cheerio.load(htmlStr);
  const forms: ReturnType<typeof extractFormInfo> = [];

  $('form').each((idx, el) => {
    const $form = $(el);
    const formData = {
      index: idx,
      id: ($form.attr('id') ?? '').trim(),
      action: ($form.attr('action') ?? '').trim(),
      method: ($form.attr('method') ?? 'get').toLowerCase(),
      inputs: [] as Array<Record<string, unknown>>,
    };

    $form.find('input, select, textarea, button').each((_, inputEl) => {
      const $input = $(inputEl);
      const tag = (inputEl.tagName ?? '').toLowerCase();
      const inputData: Record<string, unknown> = {
        tag,
        name: ($input.attr('name') ?? $input.attr('id') ?? '').trim(),
        type: ($input.attr('type') ?? '').toLowerCase(),
        id: ($input.attr('id') ?? '').trim(),
        placeholder: ($input.attr('placeholder') ?? '').trim(),
        value: tag === 'select' ? '' : ($input.attr('value') ?? ''),
        required: $input.attr('required') !== undefined,
        disabled: $input.attr('disabled') !== undefined,
        readonly: $input.attr('readonly') !== undefined,
      };

      // Select options.
      if (tag === 'select') {
        const options: Array<{ value: string; text: string; selected: boolean }> = [];
        $input.find('option').each((_, optEl) => {
          const $opt = $(optEl);
          options.push({
            value: ($opt.attr('value') ?? '').trim(),
            text: ($opt.text() ?? '').trim(),
            selected: $opt.attr('selected') !== undefined,
          });
        });
        inputData.options = options;
      }

      // Label text (associated via for= or wrapping).
      const inputId = ($input.attr('id') ?? '').trim();
      if (inputId) {
        const $label = $(`label[for="${inputId}"]`);
        if ($label.length > 0) {
          inputData.label = $label.text().trim();
        }
      }
      // Check for wrapping label.
      const $parent = $(inputEl).parent();
      const parentTag = $parent.length ? ($parent[0] as any).tagName?.toLowerCase() : '';
      if (!inputData.label && parentTag === 'label') {
        const parentText = $parent
          .clone()
          .children()
          .remove()
          .end()
          .text()
          .trim();
        if (parentText) inputData.label = parentText;
      }

      formData.inputs.push(inputData);
    });

    if (formData.inputs.length > 0) {
      forms.push(formData);
    }
  });

  return forms;
}

/**
 * Remove session-specific content sections from HTML.
 *
 * @param htmlStr                 - Raw HTML.
 * @param removeSessionSpecific   - If true, strip commonly-variable sections.
 * @returns Cleaned HTML string.
 */
export function cutHtmlSections(
  htmlStr: string,
  removeSessionSpecific: boolean = true,
): string {
  const $ = cheerio.load(htmlStr);

  // Remove session-variable elements.
  if (removeSessionSpecific) {
    for (const sel of SESSION_SELECTORS) {
      $(sel).remove();
    }

    // Remove elements whose textContent looks session-specific (timestamps,
    // CSRF tokens, nonce attributes, etc.).
    $('*').each((_, el) => {
      const $el = $(el);
      // Remove CSRF tokens.
      const name = ($el.attr('name') ?? '').toLowerCase();
      if (
        name.includes('csrf') ||
        name.includes('authenticity_token') ||
        name.includes('nonce')
      ) {
        $el.remove();
        return;
      }
      // Remove nonce attributes.
      if ($el.attr('nonce')) {
        $el.removeAttr('nonce');
      }
      // Remove elements whose content is a pure timestamp or UUID.
      const text = $el.text().trim();
      if (
        text &&
        /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/.test(text) &&
        $el.children().length === 0
      ) {
        $el.remove();
        return;
      }
      if (
        text &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
          text
        ) &&
        $el.children().length === 0
      ) {
        $el.remove();
        return;
      }
    });
  }

  return $.html() ?? '';
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Server-side HTML simplification using cheerio.
 * Strips scripts, styles, metadata, comments, and collapses whitespace.
 */
function simplifyHtml(htmlStr: string): string {
  const $ = cheerio.load(htmlStr);

  // Remove excludable elements.
  const toRemove = [
    'script',
    'style',
    'noscript',
    'svg',
    'meta',
    'link',
    'iframe',
    'head',
  ];
  toRemove.forEach(tag => $(tag).remove());

  // Remove all comments.
  $('*')
    .contents()
    .each(function () {
      if (this.type === 'comment') {
        $(this).remove();
      }
    });

  // Collapse whitespace in text nodes.
  $('body')
    .find('*')
    .contents()
    .each(function () {
      if (this.type === 'text') {
        const raw = this.data ?? '';
        const collapsed = raw.replace(/\s+/g, ' ').trim();
        if (raw !== collapsed) {
          $(this).replaceWith(collapsed);
        }
      }
    });

  let output = $.html() ?? '';

  // Collapse blank lines.
  output = output.replace(/\n\s*\n\s*\n/g, '\n\n');

  return output;
}

// ---------------------------------------------------------------------------
// Convenience re-exports of the JS strings
// ---------------------------------------------------------------------------

export const JS_SCRIPTS = {
  optHTML,
  optHTML_mino,
  getFormInfoJS,
  setupExtractAndMonitor,
  getDomChanges,
  getPageText,
};
