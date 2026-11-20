/**
 * Scrolls `container` so `el` is visible. Unlike `scrollIntoView`, this never scrolls
 * any other ancestor (which would shift the whole window).
 */
export function scrollIntoContainer(el: Element, container: HTMLElement, block: 'center' | 'nearest'): void {
  const c = container.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  const top = r.top - c.top;
  const left = r.left - c.left;
  if (block === 'center') {
    container.scrollTop += top - (container.clientHeight - r.height) / 2;
    if (left < 0 || left + r.width > container.clientWidth) {
      container.scrollLeft += left - (container.clientWidth - r.width) / 2;
    }
    return;
  }
  if (top < 0) container.scrollTop += top - 8;
  else if (top + r.height > container.clientHeight) container.scrollTop += top + r.height - container.clientHeight + 8;
}
