/**
 * One slice of a ring, for the Camelot wheel on both apps (CamelotWheel.tsx, the phone's
 * SoundsLikeScreen.tsx): drawn without an outline, the room left between slices doing what an outline
 * did, and every corner rounded a little (the user's wish, 2026-11-17).
 *
 * Angles in radians, clockwise from three o'clock as SVG counts them. `gap` is the room between two
 * slices (and between the rings), in the drawing's own units; it stays the same width along the edge,
 * so the inner end of a slice gives up a larger angle than its outer end. Corners are rounded with a
 * curve whose control point is the sharp corner.
 */
export function ringSlice(cx: number, cy: number, inner: number, outer: number, from: number, to: number, corner = 5, gap = 3): string {
  const r0 = inner + gap / 2;
  const r1 = outer - gap / 2;
  const o0 = from + gap / 2 / r1;
  const o1 = to - gap / 2 / r1;
  const i0 = from + gap / 2 / r0;
  const i1 = to - gap / 2 / r0;
  const c = Math.max(0, Math.min(corner, (r1 - r0) / 2 - 0.5, ((o1 - o0) * r1) / 2 - 0.5, ((i1 - i0) * r0) / 2 - 0.5));
  const at = (r: number, a: number): [number, number] => [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  const toward = (p: [number, number], q: [number, number], d: number): [number, number] => {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const l = Math.hypot(dx, dy) || 1;
    return [p[0] + (dx / l) * d, p[1] + (dy / l) * d];
  };
  const f = (p: [number, number]): string => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
  const outer0 = at(r1, o0);
  const outer1 = at(r1, o1);
  const inner1 = at(r0, i1);
  const inner0 = at(r0, i0);
  const outerFrom = at(r1, o0 + c / r1);
  const outerTo = at(r1, o1 - c / r1);
  const innerFrom = at(r0, i1 - c / r0);
  const innerTo = at(r0, i0 + c / r0);
  const bigOuter = o1 - o0 > Math.PI ? 1 : 0;
  const bigInner = i1 - i0 > Math.PI ? 1 : 0;
  return [
    `M ${f(outerFrom)}`,
    `A ${r1.toFixed(2)} ${r1.toFixed(2)} 0 ${bigOuter} 1 ${f(outerTo)}`,
    `Q ${f(outer1)} ${f(toward(outer1, inner1, c))}`,
    `L ${f(toward(inner1, outer1, c))}`,
    `Q ${f(inner1)} ${f(innerFrom)}`,
    `A ${r0.toFixed(2)} ${r0.toFixed(2)} 0 ${bigInner} 0 ${f(innerTo)}`,
    `Q ${f(inner0)} ${f(toward(inner0, outer0, c))}`,
    `L ${f(toward(outer0, inner0, c))}`,
    `Q ${f(outer0)} ${f(outerFrom)}`,
    "Z",
  ].join(" ");
}
