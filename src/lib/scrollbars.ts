/**
 * A scrollbar shows while the pointer is over what it scrolls. CSS's :hover can't be trusted with
 * that: Chromium keeps a scrollbar's hover look when the pointer leaves straight off the bar, and
 * the bar stays on screen. So the scrolling areas under the pointer are marked here
 * (data-scroll-shown, index.css), and the mark comes off once the pointer is elsewhere, which
 * repaints the bar.
 */
const MARK = "data-scroll-shown";

function scrolls(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.scrollHeight <= el.clientHeight && el.scrollWidth <= el.clientWidth) return false;
  const style = getComputedStyle(el);
  return /auto|scroll/.test(`${style.overflowY} ${style.overflowX}`);
}

export function watchScrollbars(): () => void {
  let marked: Element[] = [];
  const markFrom = (target: EventTarget | null): void => {
    const now: Element[] = [];
    for (let el = target instanceof Element ? target : null; el; el = el.parentElement) if (scrolls(el)) now.push(el);
    for (const el of marked) if (!now.includes(el)) el.removeAttribute(MARK);
    for (const el of now) if (!el.hasAttribute(MARK)) el.setAttribute(MARK, "");
    marked = now;
  };
  const over = (e: PointerEvent): void => markFrom(e.target);
  // Out of the window altogether.
  const out = (e: PointerEvent): void => {
    if (!e.relatedTarget) markFrom(null);
  };
  const away = (): void => markFrom(null);
  document.addEventListener("pointerover", over, true);
  document.addEventListener("pointerout", out, true);
  window.addEventListener("blur", away);
  return () => {
    document.removeEventListener("pointerover", over, true);
    document.removeEventListener("pointerout", out, true);
    window.removeEventListener("blur", away);
    markFrom(null);
  };
}
