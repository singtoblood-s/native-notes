import { chromium, webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Disposable accounts and local storage; never connects to a real sync server.
const port = "4191";
const url = process.env.QA_URL || `http://127.0.0.1:${port}/native-notes/`;
if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error("QA_URL must be a local test server.");
const server = process.env.QA_URL ? null : spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], { windowsHide: true, stdio: "ignore" });
try {
  for (let attempt = 0; attempt < 60; attempt++) {
    if (await fetch(url).then(response => response.ok).catch(() => false)) break;
    if (attempt === 59) throw new Error("Local server did not start");
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  for (const engine of [chromium, webkit]) {
    const browser = await engine.launch({ headless: true });
    try {
      const context = await browser.newContext({ ...devices["iPad (gen 7)"] });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => {
        localStorage.setItem("notepad.endpoint", "https://qa.invalid");
        sessionStorage.setItem("notepad.session", JSON.stringify({ endpoint: "https://qa.invalid", user: { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", identifier: "QA" }, sessionToken: "qa-only", expiresAt: "2099-01-01T00:00:00Z" }));
      });
      await page.route("https://qa.invalid/**", route => route.fulfill({ status: 503, body: "Offline QA" }));
      await page.goto(url);
      await page.locator("#library-new").waitFor();
      const webScale = () => page.evaluate(() => window.visualViewport?.scale ?? 1);
      const assertZoomBlocked = async (selector) => {
        const result = await page.locator(selector).evaluate(element => {
          const events = [
            new WheelEvent("wheel", { ctrlKey: true, deltaY: -100, bubbles: true, cancelable: true }),
            new WheelEvent("wheel", { metaKey: true, deltaY: -100, bubbles: true, cancelable: true }),
            new Event("gesturestart", { bubbles: true, cancelable: true }),
            new Event("gesturechange", { bubbles: true, cancelable: true }),
          ];
          return events.map(event => { element.dispatchEvent(event); return event.defaultPrevented; });
        });
        assert(result.every(Boolean), `${engine.name()}: browser zoom must be cancelled on ${selector}`);
        assert.equal(await webScale(), 1);
      };
      await assertZoomBlocked(".library-header");
      await page.locator("#library-search").focus();
      assert(await page.locator("#library-search").evaluate(element => parseFloat(getComputedStyle(element).fontSize) >= 16));
      await page.keyboard.type("Zoom QA");
      assert.equal(await webScale(), 1);
      await page.locator("#library-search").fill("");
      await page.locator("#library-new").click();
      await page.locator("#new-document-notebook").click();
      await assertZoomBlocked("#notebook-dialog");
      await page.locator("#notebook-title").fill("Zoom QA");
      await page.locator("#notebook-form button[type=submit]").click();
      await page.waitForFunction(() => !document.querySelector("#editor-workspace").hidden);
      await assertZoomBlocked(".editor-toolbar");
      const paperWidth = () => page.locator("#paper").evaluate(element => element.getBoundingClientRect().width);
      const original = await paperWidth();
      await page.locator("#ink-canvas").focus();
      await page.keyboard.press("Control+=");
      assert(await paperWidth() > original, "Keyboard zoom must scale paper");
      assert.equal(await webScale(), 1);
      await page.keyboard.press("Control+0");
      assert(Math.abs(await paperWidth() - original) < 2);
      await page.locator("#text-toggle").click();
      await page.locator("#page-text").focus();
      await page.keyboard.press("Control+=");
      assert(Math.abs(await paperWidth() - original) < 2, "Typing in a field must not change paper zoom");
      assert.equal(await webScale(), 1);
      await page.locator("#close-inspector").click();
      for (const mode of ["continuous", "horizontal", "paged"]) {
        await page.locator("#page-view-mode").selectOption(mode);
        for (const tool of ["pen", "hand", "select"]) {
          await page.locator("#fit-button").click();
          await page.locator("#zoom-in").click();
          await page.locator("#zoom-in").click();
          await page.locator(`#${tool}-tool`).click();
          await checkFingerCounts(page, mode, tool);
        }
      }
      await page.locator("#page-view-mode").selectOption("continuous");
      await page.locator("#fit-button").click();
      await page.locator("#pen-tool").click();
      await checkPalmRejection(page);
      await page.locator("#fit-button").click();
      if (engine === chromium) {
        const session = await context.newCDPSession(page);
        const pinch = async (y, expectedPaperZoom) => {
          const before = await paperWidth();
          await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ id: 1, x: 300, y }, { id: 2, x: 450, y }] });
          for (let step = 1; step <= 5; step++) {
            await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ id: 1, x: 300 - step * 8, y }, { id: 2, x: 450 + step * 8, y }] });
          }
          await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
          assert.equal(await webScale(), 1, "Native pinch must never scale the browser viewport");
          if (expectedPaperZoom) assert(await paperWidth() > before * 1.4, "Native pinch must still zoom paper");
          else assert(Math.abs(await paperWidth() - before) < 2, "Pinching toolbar must not zoom paper");
        };
        await pinch(24, false);
        const area = await page.locator("#paper-scroll").boundingBox();
        await pinch(area.y + 180, true);
        await page.locator("#fit-button").click();
        await page.locator("#zoom-in").click();
        await page.locator("#paper-scroll").evaluate(element => { element.scrollTop = 0; });
        const nativeState = () => page.evaluate(() => {
          const scroll = document.querySelector("#paper-scroll");
          return [scroll.scrollLeft, scroll.scrollTop, document.querySelector("#paper").style.transform];
        });
        const initial = await nativeState();
        const points = [{ id: 1, x: 300, y: area.y + 220 }, { id: 2, x: 480, y: area.y + 220 }, { id: 3, x: 560, y: area.y + 220 }];
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points.slice(0, 1) });
        for (let index = 0; index < 8; index++) {
          points[0].y -= 9;
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points.slice(0, 1) });
          await page.waitForTimeout(20);
        }
        const single = await nativeState();
        assert(single[1] > initial[1] + 10, `Native one-finger drag scrolled from ${initial[1]} to ${single[1]}`);
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points.slice(0, 2) });
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
        for (const point of points) point.y -= 40;
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points });
        assert.deepEqual(await nativeState(), single, "A real three-finger drag must leave the paper fixed");
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await page.locator("#paper-scroll").evaluate(element => { element.scrollTop = 0; });
        const fingers = [{ id: 1, x: 300, y: area.y + 180 }, { id: 2, x: 450, y: area.y + 180 }];
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: fingers });
        for (const delta of [20, 40, 60, 80, 100, 80]) {
          await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: fingers.map(point => ({ ...point, y: point.y + delta })) });
        }
        assert(Math.abs(await page.locator("#paper-scroll").evaluate(element => element.scrollTop) - 20) < 2, "Reversing after reaching the top must pan immediately without a dead zone");
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
      }
      await checkFirstPreviewStroke(page);
      await page.setViewportSize({ width: 1024, height: 768 });
      assert.equal(await webScale(), 1, "Rotation must keep browser scale fixed");
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine.name()}: 1/2/3-finger transitions in Scroll, Book scroll and Page turn with pen/hand/select, library, toolbar, dialogs, form focus, wheel, Safari gesture cancellation, keyboard paper zoom, rotation${engine === chromium ? ", native mobile pinch" : ""}`);
    } finally { await browser.close(); }
  }
} finally { server?.kill(); }

async function checkFingerCounts(page, mode, tool) {
  const label = `${mode}/${tool}`;
  const samples = await page.evaluate(async () => {
    const canvas = document.querySelector("#ink-canvas");
    const scroll = document.querySelector("#paper-scroll");
    const bounds = scroll.getBoundingClientRect();
    const snapshot = () => [scroll.scrollLeft, scroll.scrollTop, canvas.parentElement.style.transform];
    const send = (type, id, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerType: "touch", pointerId: id, bubbles: true, cancelable: true, isPrimary: id === 101,
      clientX: bounds.left + x, clientY: bounds.top + y, button: 0, buttons: type === "pointerup" ? 0 : 1, width: 8, height: 8,
    }));
    const initial = snapshot();
    send("pointerdown", 101, 220, 230);
    send("pointermove", 101, 210, 220);
    await new Promise(resolve => setTimeout(resolve, 115));
    send("pointermove", 101, 198, 208);
    send("pointermove", 101, 190, 200);
    const single = snapshot();
    send("pointerdown", 102, 390, 200);
    send("pointermove", 101, 170, 175);
    send("pointermove", 102, 370, 175);
    const pair = snapshot();
    send("pointerdown", 103, 480, 230);
    send("pointermove", 101, 120, 135);
    send("pointermove", 102, 320, 135);
    send("pointermove", 103, 490, 250);
    const three = snapshot();
    send("pointercancel", 101, 120, 135);
    send("pointermove", 102, 320, 135);
    const resumed = snapshot();
    send("pointermove", 103, 530, 230);
    const newPair = snapshot();
    send("pointerup", 103, 530, 230);
    send("pointermove", 102, 250, 85);
    send("pointerup", 102, 250, 85);
    return { initial, single, pair, three, resumed, newPair, afterRelease: snapshot() };
  });
  if (tool === "select") assert.deepEqual(samples.single, samples.initial, `${label}: drawing a selection moved the paper`);
  else assert.notDeepEqual(samples.single, samples.initial, `${label}: deliberate one-finger pan did not scroll`);
  assert.notDeepEqual(samples.pair, samples.single, `${label}: the pair did not move the viewport`);
  assert.deepEqual(samples.three, samples.pair, `${label}: three touches moved the viewport`);
  assert.deepEqual(samples.resumed, samples.three, `${label}: replacing a finger jumped`);
  assert.notDeepEqual(samples.newPair, samples.resumed, `${label}: the new pair did not resume`);
  assert.deepEqual(samples.afterRelease, samples.newPair, `${label}: the remaining finger moved the viewport`);
}

async function checkPalmRejection(page) {
  await page.locator("#zoom-in").click();
  await page.locator("#zoom-in").click();
  const samples = await page.evaluate(async () => {
    const canvas = document.querySelector("#ink-canvas"), scroll = document.querySelector("#paper-scroll");
    scroll.scrollTop = (scroll.scrollHeight - scroll.clientHeight) / 2;
    const rect = scroll.getBoundingClientRect();
    const snapshot = () => [scroll.scrollLeft, scroll.scrollTop, canvas.getBoundingClientRect().width];
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const event = (kind, phase, id, dy = 0, size = 8) => {
      canvas.dispatchEvent(new PointerEvent(`pointer${phase}`, {
        pointerId: id, pointerType: kind, isPrimary: true, bubbles: true, cancelable: true,
        width: size, height: size, pressure: phase === "down" || phase === "move" ? .45 : 0,
        buttons: phase === "down" || phase === "move" ? 1 : 0, button: 0,
        clientX: rect.x + (kind === "pen" ? 220 : 350), clientY: rect.y + 270 + dy,
      }));
    };
    const liftPen = () => { event("pen", "move", 80, 12); event("pen", "up", 80, 12); event("pen", "out", 80, 12); };
    const baseline = snapshot();
    // A small contact that overlaps the Pencil remains quarantined even when
    // the Pencil has lifted, left the canvas, and its hover cooldown has elapsed.
    event("pen", "down", 80); event("touch", "down", 10); event("touch", "move", 10, -40);
    liftPen(); await pause(390); event("touch", "move", 10, -100);
    const penFirst = snapshot(); event("touch", "up", 10, -100);
    event("touch", "down", 11); event("touch", "move", 11, -3);
    const jitter = snapshot();
    event("pen", "down", 80); liftPen(); await pause(390); event("touch", "move", 11, -85);
    const micro = snapshot(); event("touch", "up", 11, -85);

    // An ambiguous wrist contact may look like a finger until the stylus
    // arrives. The tentative pan should be rolled back at that point.
    event("touch", "down", 12); event("touch", "move", 12, -12);
    await pause(115); event("touch", "move", 12, -40); event("touch", "move", 12, -65);
    const tentative = snapshot();
    event("pen", "down", 80); const rolledBack = snapshot();
    liftPen(); await pause(390); event("touch", "move", 12, -115);
    const persistent = snapshot(); event("touch", "up", 12, -115);

    event("touch", "down", 13, 0, 72); event("touch", "down", 14);
    event("touch", "move", 13, -45, 72); event("touch", "move", 14, -55);
    event("touch", "up", 13, -45, 72); event("touch", "move", 14, -110);
    const broad = snapshot(); event("touch", "up", 14, -110);
    event("touch", "down", 15); event("touch", "move", 15, -2);
    await pause(405); event("touch", "move", 15, -40); event("touch", "move", 15, -80);
    const rested = snapshot(); event("touch", "up", 15, -80);

    event("touch", "down", 16); event("touch", "move", 16, -12);
    await pause(115); event("touch", "move", 16, -45); event("touch", "move", 16, -80);
    const intentional = snapshot(); event("touch", "up", 16, -80);
    return { baseline, penFirst, jitter, micro, tentative, rolledBack, persistent, broad, rested, intentional };
  });
  for (const key of ["penFirst", "jitter", "micro", "rolledBack", "persistent", "broad", "rested"]) {
    assert.deepEqual(samples[key], samples.baseline, `Palm sequence moved the viewport at ${key}`);
  }
  assert(samples.tentative[1] > samples.baseline[1] + 10, "Expected an actual pan before the stylus arrived");
  assert(samples.intentional[1] > samples.baseline[1] + 10, "A fresh single finger could not scroll after palms lifted");
  const archive = await notebookBackup(page);
  assert.equal(archive.pages[0].strokes.length, 3, "The three Pencil contacts must produce exactly three strokes");
}

async function notebookBackup(page) {
  await page.locator("#notebook-menu").click();
  const [download] = await Promise.all([page.waitForEvent("download"), page.locator("#notebook-menu-popup [data-action=export-notebook-backup]").click()]);
  return JSON.parse(await readFile(await download.path(), "utf8"));
}

async function checkFirstPreviewStroke(page) {
  await page.locator("#add-page").click();
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "2 / 2");
  await page.evaluate(async () => {
    const scroll = document.querySelector("#paper-scroll");
    const slot = document.querySelector(".flow-preview");
    const clip = scroll.getBoundingClientRect();
    const frame = () => new Promise(requestAnimationFrame);
    // Put the seam between the two sheets in view, then hit-test each point.
    scroll.scrollTop += slot.getBoundingClientRect().bottom - (clip.top + clip.height * .4);
    await frame(); await frame();
    const active = document.querySelector("#ink-canvas").getBoundingClientRect();
    const previous = slot.getBoundingClientRect();
    const overlapX = (Math.max(clip.left, active.left, previous.left) + Math.min(clip.right, active.right, previous.right)) / 2;
    const palmY = Math.max(clip.top, active.top) + 40;
    const penY = Math.min(clip.bottom, previous.bottom) - 60;
    const palm = document.elementFromPoint(overlapX, palmY);
    const pen = document.elementFromPoint(overlapX, penY);
    if (palm?.id !== "ink-canvas" || pen?.closest(".flow-preview") !== slot) throw new Error("Neighboring sheets must both be visible");
    const send = (target, type, pointerType, pointerId, y, dy = 0) => target.dispatchEvent(new PointerEvent(type, {
      pointerType, pointerId, isPrimary: true, bubbles: true, cancelable: true, width: 8, height: 8, button: 0,
      clientX: overlapX + dy, clientY: y + dy, buttons: type === "pointerup" ? 0 : 1, pressure: type === "pointerup" ? 0 : .45,
    }));
    send(palm, "pointerdown", "touch", 121, palmY);
    await new Promise(resolve => setTimeout(resolve, 405));
    // No pointerover or hover event precedes this first pen contact.
    send(pen, "pointerdown", "pen", 122, penY);
    send(document, "pointermove", "pen", 122, penY, 15);
    send(document, "pointerup", "pen", 122, penY, 28);
    send(palm, "pointerup", "touch", 121, palmY);
  });
  await page.waitForFunction(() => document.querySelector("#page-position").textContent === "1 / 2", null, { timeout: 5000 });
  const archive = await notebookBackup(page);
  assert.deepEqual(archive.pages.map(sheet => [sheet.title, sheet.strokes.length]), [["First page", 4], ["Page 2", 0]],
    "The first non-hovering preview stroke must land only on the sheet it touched");
}
