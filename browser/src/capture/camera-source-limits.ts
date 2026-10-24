import { BROWSER_LIMITS } from '../contracts';

const axes = [['width', BROWSER_LIMITS.width, true], ['height', BROWSER_LIMITS.height, true],
  ['frameRate', BROWSER_LIMITS.fps, false]] as const;
const own = (value: object, key: string) => Object.hasOwn(value, key);
const numeric = (value: unknown, integer: boolean): value is number => typeof value === 'number'
  && Number.isFinite(value) && value > 0 && (!integer || Number.isSafeInteger(value));

function boundedAxis(value: unknown, setting: unknown, limit: number, integer: boolean): boolean {
  if (!numeric(setting, integer) || setting > limit || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const range = value as Record<string, unknown>;
  if (Object.keys(range).some(key => !['min', 'max', 'exact', 'ideal'].includes(key))
    || !['max', 'exact'].some(key => own(range, key))) return false;
  for (const key of ['min', 'max', 'exact', 'ideal']) {
    if (!(key in range)) continue;
    if (!own(range, key) || !numeric(range[key], integer)) return false;
    const bound = range[key] as number;
    if (key === 'min' && setting < bound) return false;
    if (key === 'max' && (bound > limit || setting > bound)) return false;
    if (key === 'exact' && (bound > limit || setting !== bound)) return false;
  }
  return true;
}

// Settled device-video sources acquired by this app may already carry its limits.
// Display/unknown sources and additional constraint semantics retain applyConstraints.
export function cameraSourceAlreadyBounded(track: MediaStreamTrack): boolean {
  try {
    if (track.kind !== 'video' || track.readyState !== 'live') return false;
    const supported = globalThis.navigator?.mediaDevices?.getSupportedConstraints?.();
    if (!supported || !axes.every(([key]) => supported[key] === true)) return false;
    const settings = track.getSettings() as unknown as Record<string, unknown>;
    const constraints = track.getConstraints() as unknown as Record<string, unknown>;
    if (!settings || !constraints || Array.isArray(settings) || Array.isArray(constraints)
      || typeof settings.deviceId !== 'string' || !settings.deviceId.trim()) return false;
    if (['displaySurface', 'logicalSurface', 'cursor', 'screenPixelRatio'].some(key => key in settings || key in constraints)) return false;
    for (const key in constraints) if (!['width', 'height', 'frameRate', 'deviceId', 'advanced'].includes(key)) return false;
    if ('advanced' in constraints && (!own(constraints, 'advanced') || !Array.isArray(constraints.advanced) || constraints.advanced.length)) return false;
    if ('deviceId' in constraints) {
      if (!own(constraints, 'deviceId') || supported.deviceId !== true) return false;
      const selected = constraints.deviceId;
      if (typeof selected === 'string') { if (selected !== settings.deviceId) return false; }
      else if (!selected || typeof selected !== 'object' || Array.isArray(selected)
        || Object.keys(selected).join(',') !== 'exact'
        || (selected as { exact?: unknown }).exact !== settings.deviceId) return false;
    }
    return axes.every(([key, limit, integer]) => own(constraints, key)
      && boundedAxis(constraints[key], settings[key], limit, integer));
  } catch { return false; }
}
