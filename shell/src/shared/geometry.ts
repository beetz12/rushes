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
export type CaptureRectangle = { x: number; y: number; width: number; height: number };
export function bubbleForCapture(
  desired: { x: number; y: number; size: number },
  capture: CaptureRectangle | null | undefined,
): { bounds: CaptureRectangle; center: [number, number]; sizeFraction: number } | undefined {
  if (
    !capture ||
    ![
      desired.x,
      desired.y,
      desired.size,
      capture.x,
      capture.y,
      capture.width,
      capture.height,
    ].every(Number.isFinite) ||
    desired.size <= 0 ||
    capture.width < 1 ||
    capture.height < 1
  )
    return;
  const size = Math.max(1, Math.floor(Math.min(desired.size, capture.width, capture.height)));
  const limit = (value: number, lower: number, upper: number) =>
    value < lower ? lower : value > upper ? upper : value;
  const bounds = {
    x: Math.round(limit(desired.x, capture.x, capture.x + capture.width - size)),
    y: Math.round(limit(desired.y, capture.y, capture.y + capture.height - size)),
    width: size,
    height: size,
  };
  const center = normalizedPointer(
    { x: bounds.x + size / 2, y: bounds.y + size / 2 },
    { left: capture.x, top: capture.y, width: capture.width, height: capture.height },
  );
  if (!center) return;
  return { bounds, center, sizeFraction: size / capture.width };
}
