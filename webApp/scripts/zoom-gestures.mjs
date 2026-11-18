import { chromium, webkit, devices } from "playwright";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";

// Disposable accounts and local storage; never connects to a real sync server.
const port = "4191";
const url = `http://127.0.0.1:${port}/native-notes/`;
const server = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "--port", port, "--strictPort"], { windowsHide: true, stdio: "ignore" });
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
        await page.locator("#fit-button").click();
        await page.locator("#zoom-in").click();
        await page.locator("#zoom-in").click();
        for (const tool of ["pen", "hand", "select"]) {
          await page.locator(`#${tool}-tool`).click();
          await checkFingerCounts(page, mode, tool);
        }
      }
      await page.locator("#page-view-mode").selectOption("continuous");
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
        const nativeState = () => page.evaluate(() => {
          const scroll = document.querySelector("#paper-scroll");
          return [scroll.scrollLeft, scroll.scrollTop, document.querySelector("#paper").style.transform];
        });
        const initial = await nativeState();
        const points = [{ id: 1, x: 300, y: area.y + 220 }, { id: 2, x: 480, y: area.y + 220 }, { id: 3, x: 560, y: area.y + 220 }];
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points.slice(0, 1) });
        points[0].y -= 50;
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points.slice(0, 1) });
        assert.deepEqual(await nativeState(), initial, "A real one-finger drag must leave the paper fixed");
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points.slice(0, 2) });
        await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: points });
        for (const point of points) point.y -= 40;
        await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: points });
        assert.deepEqual(await nativeState(), initial, "A real three-finger drag must leave the paper fixed");
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
      await page.setViewportSize({ width: 1024, height: 768 });
      assert.equal(await webScale(), 1, "Rotation must keep browser scale fixed");
      assert.deepEqual(errors, []);
      console.log(`PASS ${engine.name()}: 1/2/3-finger transitions in Scroll, Book scroll and Page turn with pen/hand/select, library, toolbar, dialogs, form focus, wheel, Safari gesture cancellation, keyboard paper zoom, rotation${engine === chromium ? ", native mobile pinch" : ""}`);
    } finally { await browser.close(); }
  }
} finally { server.kill(); }

async function checkFingerCounts(page, mode, tool) {
  const label = `${mode}/${tool}`;
  const samples = await page.evaluate(() => {
    const canvas = document.querySelector("#ink-canvas");
    const scroll = document.querySelector("#paper-scroll");
    const bounds = scroll.getBoundingClientRect();
    const snapshot = () => [scroll.scrollLeft, scroll.scrollTop, canvas.parentElement.style.transform];
    const send = (type, id, x, y) => canvas.dispatchEvent(new PointerEvent(type, {
      pointerType: "touch", pointerId: id, bubbles: true, cancelable: true, isPrimary: id === 101,
      clientX: bounds.left + x, clientY: bounds.top + y, button: 0, buttons: type === "pointerup" ? 0 : 1,
    }));
    const initial = snapshot();
    send("pointerdown", 101, 220, 230);
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
  assert.deepEqual(samples.single, samples.initial, `${label}: one touch moved the viewport`);
  assert.notDeepEqual(samples.pair, samples.single, `${label}: the pair did not move the viewport`);
  assert.deepEqual(samples.three, samples.pair, `${label}: three touches moved the viewport`);
  assert.deepEqual(samples.resumed, samples.three, `${label}: replacing a finger jumped`);
  assert.notDeepEqual(samples.newPair, samples.resumed, `${label}: the new pair did not resume`);
  assert.deepEqual(samples.afterRelease, samples.newPair, `${label}: the remaining finger moved the viewport`);
}
