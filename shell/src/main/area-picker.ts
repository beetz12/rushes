import type { BrowserWindowConstructorOptions } from 'electron';
import type { CaptureRectangle } from '../shared/geometry';

type PickerWindow = { once(event: 'closed', listener: () => void): unknown };
type RecorderWindow = {
  isVisible(): boolean;
  isDestroyed(): boolean;
  hide(): void;
  show(): void;
  focus(): void;
};

/** Cover the display in its current Space. Native fullscreen creates a new Space. */
export function openAreaPicker<T extends PickerWindow>(
  display: CaptureRectangle,
  create: (options: BrowserWindowConstructorOptions) => T,
  recorder: RecorderWindow | undefined,
  canRestore: () => boolean,
): T {
  const picker = create({
    ...display,
    title: 'Rushes — Select recording area',
    fullscreen: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    movable: false,
    minimizable: false,
  });
  const restore = recorder && !recorder.isDestroyed() && recorder.isVisible();
  if (restore) recorder.hide();
  picker.once('closed', () => {
    if (restore && !recorder.isDestroyed() && canRestore()) {
      recorder.show();
      recorder.focus();
    }
  });
  return picker;
}
