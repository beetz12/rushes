export type PointerPoint = { x: number; y: number };
export type PointerBounds = { left: number; top: number; width: number; height: number };
export function normalizedPointer(
  point: PointerPoint,
  bounds: PointerBounds | null | undefined,
): [number, number] | undefined {
  if (
    !bounds ||
    ![point.x, point.y, bounds.left, bounds.top, bounds.width, bounds.height].every(
      Number.isFinite,
    ) ||
    bounds.width <= 0 ||
    bounds.height <= 0
  )
    return;
  const constrain = (fraction: number) => (fraction < 0 ? 0 : fraction > 1 ? 1 : fraction);
  return [
    constrain((point.x - bounds.left) / bounds.width),
    constrain((point.y - bounds.top) / bounds.height),
  ];
}
