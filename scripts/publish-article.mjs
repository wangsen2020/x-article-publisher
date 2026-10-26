#!/usr/bin/env node
/**
 * x-article-publisher
 * Automate publishing X (Twitter) Articles via CDP on port 9222.
 * Usage:
 *   node publish-article.mjs --title "..." --body "file.html" [--cover "5x2.png"] [--caption "..."] [--inline-image "diag.png"]
 */

import fs from 'fs';
import path from 'path';

function parseArgs() {
  const args = process.argv.slice(2);
  const params = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key.startsWith('--')) {
      const name = key.slice(2);
      const val = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true;
      params[name] = val;
    }
  }
  return params;
}

const params = parseArgs();
if (!params.title || (!params.body && !params.bodyFile)) {
  console.error(`Usage: node publish-article.mjs --title "..." --bodyFile "article.html" [--cover "header-5x2.png"] [--caption "..."] [--inlineImage "img.png"]`);
  process.exit(1);
}

let bodyHtml = params.body || '';
if (params.bodyFile) {
  bodyHtml = fs.readFileSync(path.resolve(params.bodyFile), 'utf-8');
}
let title = params.title.trim();
// X.com Articles title strict limit is 100 characters (safe recommendation: <= 80 chars)
if (title.length > 90) {
  console.warn(`[x-publisher] Warning: Title length (${title.length}) exceeds 90 chars! X Articles restricts title length <= 100.`);
  const truncated = title.slice(0, 88) + '...';
  console.warn(`[x-publisher] Automatically truncating title to safe length: "${truncated}"`);
  title = truncated;
}
let caption = params.caption ? params.caption.trim() : '';
// X.com Articles publish dialog caption strict limit is 256 characters!
if (caption.length > 250) {
  console.warn(`[x-publisher] Warning: Caption length (${caption.length}) exceeds 250 chars! X limits caption <= 256.`);
  const truncated = caption.slice(0, 245) + '...';
  console.warn(`[x-publisher] Automatically truncating caption to: "${truncated}"`);
  caption = truncated;
}
const coverPath = params.cover ? path.resolve(params.cover) : null;
const inlineImagePath = params.inlineImage ? path.resolve(params.inlineImage) : null;

// Connect to CDP Browser
const versionRes = await fetch("http://127.0.0.1:9222/json/version");
const versionData = await versionRes.json();
const browserWs = new WebSocket(versionData.webSocketDebuggerUrl);

let bMsgId = 1;
function sendBrowser(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = bMsgId++;
    const handler = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.id === id) {
        browserWs.removeEventListener('message', handler);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
    browserWs.addEventListener('message', handler);
    browserWs.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise(r => browserWs.onopen = r);

// Open target tab
const { targetId } = await sendBrowser("Target.createTarget", {
  url: "https://x.com/compose/articles",
  background: false
});

console.log(`[x-publisher] Created targetId: ${targetId}`);
await new Promise(r => setTimeout(r, 5000));

const listRes = await fetch("http://127.0.0.1:9222/json/list");
const targetList = await listRes.json();
const targetObj = targetList.find(t => t.id === targetId);

if (!targetObj || !targetObj.webSocketDebuggerUrl) {
  throw new Error(`Target not found in target list: ${targetId}`);
}

const pageWs = new WebSocket(targetObj.webSocketDebuggerUrl);
let pMsgId = 1;
function sendPage(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = pMsgId++;
    const handler = (evt) => {
      const data = JSON.parse(evt.data);
      if (data.id === id) {
        pageWs.removeEventListener('message', handler);
        if (data.error) reject(data.error);
        else resolve(data.result);
      }
    };
    pageWs.addEventListener('message', handler);
    pageWs.send(JSON.stringify({ id, method, params }));
  });
}

await new Promise(r => pageWs.onopen = r);
await sendPage("Runtime.enable");
pageWs.addEventListener('message', (evt) => {
  try {
    const d = JSON.parse(evt.data);
    if (d.method === 'Runtime.consoleAPICalled') {
      const text = d.params.args.map(a => a.value !== undefined ? a.value : JSON.stringify(a.preview || a)).join(' ');
      console.log(`[browser-console] ${text}`);
    }
  } catch {}
});

try {
  async function takeDebugScreenshot(filename = 'debug-snapshot.png') {
    try {
      const shot = await sendPage("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(filename, Buffer.from(shot.data, 'base64'));
      console.log(`[x-publisher] 📸 Auto-captured visual screenshot saved to ${filename}`);
    } catch {}
  }

  // Step 1: Reuse existing draft or click create
  const draftState = await sendPage("Runtime.evaluate", {
    expression: `(() => {
      if (document.querySelector('[data-testid="composer"].public-DraftEditor-content')) {
        return { action: 'already_in_editor' };
      }
      const firstDraft = document.querySelector('[data-testid="article_draft_row"]');
      if (firstDraft) {
        firstDraft.click();
        return { action: 'reused_existing_draft' };
      }
      const createBtn = document.querySelector('[aria-label="create"]') ||
        document.querySelector('[data-testid="empty_state_button_text"]');
      if (createBtn) {
        createBtn.click();
        return { action: 'created_new_draft' };
      }
      return { action: 'no_draft_or_create_found' };
    })()`,
    returnByValue: true
  });
  console.log(`[x-publisher] Draft strategy:`, draftState.result.value);
  await new Promise(r => setTimeout(r, 4000));

  async function clickElementCenter(selector) {
    const rectRes = await sendPage("Runtime.evaluate", {
      expression: `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) return null;
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      returnByValue: true
    });
    if (rectRes.result.value) {
      const { x, y } = rectRes.result.value;
      await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
      await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
      return true;
    }
    return false;
  }

  // Step 2: Upload 5:2 Cover Media if provided
  if (coverPath && fs.existsSync(coverPath)) {
    await sendPage("DOM.enable");
    const doc = await sendPage("DOM.getDocument");
    const fileNode = await sendPage("DOM.querySelector", {
      nodeId: doc.root.nodeId,
      selector: 'input[data-testid="fileInput"]'
    });
    if (fileNode?.nodeId) {
      await sendPage("DOM.setFileInputFiles", {
        nodeId: fileNode.nodeId,
        files: [coverPath]
      });
      console.log(`[x-publisher] Cover image file selected: ${coverPath}`);
      await new Promise(r => setTimeout(r, 3000));

      // Click applyButton if present via CDP mouse events
      for (let i = 0; i < 8; i++) {
        const clicked = await clickElementCenter('[data-testid="applyButton"]');
        if (clicked) {
          console.log('[x-publisher] Successfully clicked applyButton via CDP mouse dispatch');
          await new Promise(r => setTimeout(r, 2000));
          break;
        }
        await new Promise(r => setTimeout(r, 500));
      }
    }
  }

  // Step 3: Fill Title & Full Body HTML
  const inlineImgBase64 = inlineImagePath && fs.existsSync(inlineImagePath)
    ? fs.readFileSync(inlineImagePath).toString('base64')
    : null;

  const fillRes = await sendPage("Runtime.evaluate", {
    expression: `(async () => {
      // 1. Wait for textarea and editor to mount (handling post-upload loading spinner)
      let titleEl = null;
      let editorEl = null;
      for (let i = 0; i < 30; i++) {
        titleEl = document.querySelector('textarea[placeholder*="标题"], textarea[placeholder*="Title"]') ||
          document.querySelector('textarea');
        editorEl = document.querySelector('[data-testid="composer"].public-DraftEditor-content');
        if (titleEl && editorEl) break;
        await new Promise(r => setTimeout(r, 1000));
      }

      if (!titleEl || !editorEl) {
        return { error: 'elements_not_mounted', hasTitle: !!titleEl, hasEditor: !!editorEl };
      }

      // 2. Set Title reliably
      const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
      setter.call(titleEl, ${JSON.stringify(title)});
      titleEl.dispatchEvent(new Event('input', { bubbles: true }));
      titleEl.dispatchEvent(new Event('change', { bubbles: true }));

      // 3. Body HTML paste
      editorEl.focus();
      const dt = new DataTransfer();
      dt.setData('text/html', ${JSON.stringify(bodyHtml)});
      dt.setData('text/plain', ${JSON.stringify(bodyHtml.replace(/<[^>]+>/g, '\\n'))});
      editorEl.dispatchEvent(new ClipboardEvent('paste', {
        clipboardData: dt,
        bubbles: true,
        cancelable: true
      }));
      await new Promise(r => setTimeout(r, 2000));

      // 4. Inline Image if present (append to the end)
      const b64 = ${JSON.stringify(inlineImgBase64)};
      if (b64) {
        const sel = window.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editorEl);
        range.collapse(false);
        sel.removeAllRanges();
        sel.addRange(range);

        const bin = atob(b64);
        const arr = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
        const file = new File([arr], "inline-image.png", { type: "image/png" });
        const imgDt = new DataTransfer();
        imgDt.items.add(file);
        editorEl.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: imgDt,
          bubbles: true,
          cancelable: true
        }));
        await new Promise(r => setTimeout(r, 3500));
      }

      // 5. Trigger coverMedia upload via React props if pending
      const publishBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
        const t = (b.innerText || b.textContent || '').trim();
        return t === '发布' || t === 'Publish';
      });
      let fiber = publishBtn ? publishBtn[Object.keys(publishBtn).find(k => k.startsWith('__reactFiber'))] : null;
      let depth = 0;
      while (fiber && depth < 48) {
        fiber = fiber.return;
        depth++;
      }
      const p = fiber?.memoizedProps;
      if (p?.coverMedia && !p.coverMedia.uploadId && p.uploadMedia) {
        await p.uploadMedia(p.coverMedia);
      }

      return {
        titleLen: titleEl?.value?.length,
        editorLen: editorEl?.innerText?.length
      };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });

  console.log(`[x-publisher] Content filled:`, fillRes.result.value);

  // Step 4: Trigger trailing change to guarantee auto-save
  await sendPage("Runtime.evaluate", {
    expression: `(() => {
      const editorEl = document.querySelector('[data-testid="composer"].public-DraftEditor-content');
      if (editorEl) editorEl.focus();
    })()`,
    returnByValue: true
  });
  await sendPage("Input.insertText", { text: " " });

  // Step 5: Wait for Save and Enable Publish
  console.log(`[x-publisher] Waiting for auto-save and publish button state...`);
  const waitState = await sendPage("Runtime.evaluate", {
    expression: `(async () => {
      for (let i = 0; i < 30; i++) {
        const publishBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
          const t = (b.innerText || b.textContent || '').trim();
          return t === '发布' || t === 'Publish';
        });
        const isSaving = (document.body.innerText || '').includes('正在保存') || (document.body.innerText || '').includes('Saving');
        const disabled = !publishBtn || publishBtn.disabled || publishBtn.getAttribute('aria-disabled') === 'true';
        if (i % 5 === 0 || (!disabled && !isSaving)) {
          console.log('[poll] i=' + i, {
            btnFound: !!publishBtn,
            disabled,
            isSaving,
            ariaDisabled: publishBtn ? publishBtn.getAttribute('aria-disabled') : null,
            rawDisabled: publishBtn ? publishBtn.disabled : null
          });
        }
        if (publishBtn && !disabled && !isSaving) {
          return { ready: true, attempts: i };
        }
        await new Promise(r => setTimeout(r, 1000));
      }
      return { ready: false };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  console.log(`[x-publisher] Publish button ready state:`, waitState.result.value);
  if (!waitState.result.value?.ready) {
    await takeDebugScreenshot('error-save-timeout.png');
  }

  // Step 6: Click Initial "发布" / "Publish" via CDP physical mouse
  const pubBtnCoord = await sendPage("Runtime.evaluate", {
    expression: `(() => {
      const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
        const t = (b.innerText || b.textContent || '').trim();
        return t === '发布' || t === 'Publish';
      });
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
    returnByValue: true
  });
  if (pubBtnCoord.result.value) {
    const { x, y } = pubBtnCoord.result.value;
    await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    console.log("[x-publisher] Clicked initial publish button via CDP physical mouse");
  }
  await new Promise(r => setTimeout(r, 2500));

  // Step 7: Fill Caption in Dialog & Confirm Publish via CDP physical mouse
  await sendPage("Runtime.evaluate", {
    expression: `(async () => {
      let dialog = null;
      for (let i = 0; i < 15; i++) {
        dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(d => {
          const text = (d.innerText || d.textContent || '');
          return text.includes('发布文章') || text.includes('Publish article') || text.includes('Publish Article') || text.includes('说明文字');
        });
        if (dialog) break;
        await new Promise(r => setTimeout(r, 1000));
      }
      if (!dialog) return { error: 'no_dialog' };

      const captionEl = dialog.querySelector('textarea');
      if (captionEl && ${JSON.stringify(caption)}) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value").set;
        setter.call(captionEl, ${JSON.stringify(caption)});
        captionEl.dispatchEvent(new Event('input', { bubbles: true }));
        captionEl.dispatchEvent(new Event('change', { bubbles: true }));
      }
      return { ready: true };
    })()`,
    awaitPromise: true,
    returnByValue: true
  });
  await new Promise(r => setTimeout(r, 1500));

  // Physically click the final confirm button inside the dialog
  const confCoord = await sendPage("Runtime.evaluate", {
    expression: `(() => {
      const dialog = Array.from(document.querySelectorAll('[role="dialog"]')).find(d => {
        const text = (d.innerText || d.textContent || '');
        return text.includes('发布文章') || text.includes('Publish article') || text.includes('Publish Article') || text.includes('说明文字');
      });
      if (!dialog) return null;
      const btn = Array.from(dialog.querySelectorAll('button, [role="button"]')).find(b => {
        const t = (b.innerText || b.textContent || '').trim();
        return t === '发布' || t === 'Publish';
      });
      if (!btn) return null;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`,
    returnByValue: true
  });

  if (confCoord.result.value) {
    const { x, y } = confCoord.result.value;
    await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    console.log("[x-publisher] Clicked dialog confirm publish button via CDP physical mouse");
  }

  // Wait for publish completion
  await new Promise(r => setTimeout(r, 8000));

  const pubRes = await sendPage("Runtime.evaluate", {
    expression: `(() => {
      return {
        url: location.href,
        hasStatus: location.href.includes('/status/'),
        titleInPage: (document.body.innerText || '').includes(${JSON.stringify(title)})
      };
    })()`,
    returnByValue: true
  });

  console.log(`[x-publisher] Publish result:`, pubRes.result.value);

  if (pubRes.result.value?.success) {
    console.log(`\n🎉 SUCCESS! Published Article URL: ${pubRes.result.value.url}\n`);
  } else {
    console.error(`[x-publisher] Warning: status link not confirmed immediately. Current URL: ${pubRes.result.value?.url}`);
  }

} finally {
  pageWs.close();
  // Close the created target tab cleanly
  try {
    await sendBrowser("Target.closeTarget", { targetId });
  } catch {}
  browserWs.close();
}
