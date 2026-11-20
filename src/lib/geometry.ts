/** 2D affine matrix [a, b, c, d, e, f], as used by PDF and SVG. */
export type Matrix = [number, number, number, number, number, number];
export type Point = [number, number];

/** Axis-aligned box in PDF user space (y grows upwards). x1 < x2, y1 < y2. */
export interface Box {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Matrix from PDF user space to on-screen CSS pixels for a page.
 * Same maths as PDF.js `PageViewport`, which isn't exported.
 * @param view the page's visible box [x0, y0, x1, y1]
 * @param rotation total rotation in degrees (page /Rotate + view rotation)
 * @param scale CSS pixels per PDF point
 */
export function pageMatrix(view: number[], rotation: number, scale: number): Matrix {
  const [x0, y0, x1, y1] = view;
  const cx = (x0 + x1) / 2;
  const cy = (y0 + y1) / 2;
  let a: number, b: number, c: number, d: number;
  switch (((rotation % 360) + 360) % 360) {
    case 90:
      [a, b, c, d] = [0, 1, 1, 0];
      break;
    case 180:
      [a, b, c, d] = [-1, 0, 0, 1];
      break;
    case 270:
      [a, b, c, d] = [0, -1, -1, 0];
      break;
    default:
      [a, b, c, d] = [1, 0, 0, -1];
  }
  let ox: number, oy: number;
  if (a === 0) {
    ox = Math.abs(cy - y0) * scale;
    oy = Math.abs(cx - x0) * scale;
  } else {
    ox = Math.abs(cx - x0) * scale;
    oy = Math.abs(cy - y0) * scale;
  }
  return [a * scale, b * scale, c * scale, d * scale, ox - a * scale * cx - c * scale * cy, oy - b * scale * cx - d * scale * cy];
}

export function apply(m: Matrix, x: number, y: number): Point {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export function invert(m: Matrix): Matrix {
  const det = m[0] * m[3] - m[1] * m[2];
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function boxFromPoints(points: Point[]): Box {
  let x1 = Infinity;
  let y1 = Infinity;
  let x2 = -Infinity;
  let y2 = -Infinity;
  for (const [x, y] of points) {
    x1 = Math.min(x1, x);
    y1 = Math.min(y1, y);
    x2 = Math.max(x2, x);
    y2 = Math.max(y2, y);
  }
  return { x1, y1, x2, y2 };
}

export function padBox(b: Box, pad: number): Box {
  return { x1: b.x1 - pad, y1: b.y1 - pad, x2: b.x2 + pad, y2: b.y2 + pad };
}

/** Transforms a box and returns the axis-aligned box around the result. */
export function transformBox(m: Matrix, b: Box): Box {
  return boxFromPoints([apply(m, b.x1, b.y1), apply(m, b.x2, b.y1), apply(m, b.x1, b.y2), apply(m, b.x2, b.y2)]);
}
