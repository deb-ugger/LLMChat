// DOM measurements include root zoom, while fixed insets use layout pixels.
export function getLayoutViewport() {
  const scale = document.documentElement.currentCSSZoom;
  return { scale, width: window.innerWidth / scale, height: window.innerHeight / scale };
}

export function getLayoutRect(bounds: DOMRectReadOnly, scale = document.documentElement.currentCSSZoom) {
  return new DOMRect(bounds.x / scale, bounds.y / scale, bounds.width / scale, bounds.height / scale);
}

export function getFixedMenuPoint(x: number, y: number, rightSpace: number, bottomSpace: number, inset = 8) {
  const viewport = getLayoutViewport();
  return {
    x: Math.max(inset, Math.min(x / viewport.scale, viewport.width - rightSpace)),
    y: Math.max(inset, Math.min(y / viewport.scale, viewport.height - bottomSpace)),
  };
}
