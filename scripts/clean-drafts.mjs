#!/usr/bin/env node
/**
 * x-draft-cleaner (clean-drafts.mjs)
 * Automatically cleans up unused or test drafts in X (Twitter) Articles via CDP (port 9222).
 * Usage:
 *   node clean-drafts.mjs [--max 30] [--keep 0]
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
const maxDeletions = parseInt(params.max, 10) || 30;
const keepCount = parseInt(params.keep, 10) || 0;

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

console.log(`[x-cleaner] Created target tab: ${targetId}`);
await new Promise(r => setTimeout(r, 4500));

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

let deletedCount = 0;
try {
  console.log(`[x-cleaner] Starting draft cleanup (keepCount: ${keepCount}, maxDeletions: ${maxDeletions})...`);

  for (let i = 0; i < maxDeletions; i++) {
    // 1. Find the target more button in draft list
    const moreBtnCoord = await sendPage("Runtime.evaluate", {
      expression: `(() => {
        const btns = Array.from(document.querySelectorAll('button[aria-label="更多"], button[aria-label="More"]'));
        const draftBtns = btns.map(b => {
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, r };
        }).filter(b => b.x > 800 && b.x < 1000 && b.y > 80 && b.y < 800);
        
        if (draftBtns.length <= ${keepCount}) return null;
        return draftBtns[${keepCount}];
      })()`,
      returnByValue: true
    });

    if (!moreBtnCoord.result.value) {
      console.log(`[x-cleaner] No more removable drafts found.`);
      break;
    }

    const { x, y } = moreBtnCoord.result.value;
    // Click more button
    await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
    await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 800));

    // 2. Click "删除文章" / "Delete article" in menu
    const delMenuCoord = await sendPage("Runtime.evaluate", {
      expression: `(() => {
        const items = Array.from(document.querySelectorAll('[role="menuitem"]'));
        const del = items.find(m => {
          const t = (m.innerText || '').trim();
          return t.includes('删除文章') || t.includes('Delete article') || t.includes('删除') || t.includes('Delete');
        });
        if (!del) return null;
        const r = del.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      returnByValue: true
    });

    if (!delMenuCoord.result.value) {
      console.log("[x-cleaner] Delete menu item not found, sending Escape");
      await sendPage("Input.dispatchKeyEvent", { type: "rawKeyDown", windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" });
      await sendPage("Input.dispatchKeyEvent", { type: "keyUp", windowsVirtualKeyCode: 27, code: "Escape", key: "Escape" });
      break;
    }

    const dx = delMenuCoord.result.value.x;
    const dy = delMenuCoord.result.value.y;
    await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", x, dx, y: dy });
    await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", x: dx, y: dy, button: "left", clickCount: 1 });
    await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", x: dx, y: dy, button: "left", clickCount: 1 });
    await new Promise(r => setTimeout(r, 800));

    // 3. Click red "是的，删除" button in confirm dialog
    const confirmCoord = await sendPage("Runtime.evaluate", {
      expression: `(() => {
        const btn = Array.from(document.querySelectorAll('button, [role="button"]')).find(b => {
          const t = (b.innerText || b.textContent || '').trim();
          return t.includes('是的，删除') || t.includes('Yes, delete') || t.includes('Delete');
        });
        if (!btn) return null;
        const r = btn.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
      })()`,
      returnByValue: true
    });

    if (confirmCoord.result.value) {
      const cx = confirmCoord.result.value.x;
      const cy = confirmCoord.result.value.y;
      await sendPage("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
      await sendPage("Input.dispatchMouseEvent", { type: "mousePressed", x: cx, y: cy, button: "left", clickCount: 1 });
      await sendPage("Input.dispatchMouseEvent", { type: "mouseReleased", x: cx, y: cy, button: "left", clickCount: 1 });
      deletedCount++;
      console.log(`[x-cleaner] Deleted draft #${deletedCount}`);
      await new Promise(r => setTimeout(r, 1500));
    } else {
      console.log("[x-cleaner] Confirm dialog delete button not found");
      break;
    }
  }

  console.log(`\n🎉 SUCCESS! Total deleted: ${deletedCount} draft(s).\n`);

} finally {
  pageWs.close();
  try {
    await sendBrowser("Target.closeTarget", { targetId });
  } catch {}
  browserWs.close();
}
