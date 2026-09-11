/** Keep browser gestures out of the app's paper-coordinate zoom system. */
export function lockBrowserZoom(): () => void {
  const controller = new AbortController();
  const options = { capture: true, passive: false, signal: controller.signal };
  const cancel = (event: Event): void => { if (event.cancelable) event.preventDefault(); };
  document.addEventListener("wheel", event => {
    if (event.ctrlKey || event.metaKey) cancel(event);
  }, options);
  document.addEventListener("keydown", event => {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && !event.isComposing && ["+", "=", "-", "_", "0"].includes(event.key)) cancel(event);
  }, options);
  document.addEventListener("touchmove", event => {
    if (event.touches.length > 1) cancel(event);
  }, options);
  // Safari can emit GestureEvents in addition to PointerEvents.
  for (const type of ["gesturestart", "gesturechange", "gestureend"]) {
    document.addEventListener(type, cancel, options);
  }
  return () => controller.abort();
}
