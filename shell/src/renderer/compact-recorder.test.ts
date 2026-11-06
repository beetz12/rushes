import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { CompactRecorder, type CompactRecorderProps } from './compact-recorder';
import { defaultOptions } from '../shared/contracts';

function recorderMarkup(recordingState: string, countdown: number | null) {
  const props: CompactRecorderProps = {
    options: defaultOptions,
    targets: { displays: [], windows: [], cameras: [], microphones: [] },
    preview: '',
    feedbackError: '',
    intent: 'screen',
    readiness: { voiceOff: true, tracks: ['Screen'] },
    busy: false,
    active: recordingState !== 'idle',
    recordingState,
    countdown,
    permissions: null,
    savedSetups: null,
    selectIntent: () => Promise.resolve(),
    chooseMode: () => Promise.resolve(),
    chooseCamera: () => Promise.resolve(),
    chooseMicrophone: () => undefined,
    update: () => Promise.resolve(),
    start: () => Promise.resolve(),
    stop: () => undefined,
    cancel: () => undefined,
    selectArea: () => undefined,
    refresh: () => undefined,
    settings: () => undefined,
    guide: () => undefined,
  };
  return renderToString(createElement(CompactRecorder, props));
}
describe('compact recorder transient actions', () => {
  it('shows the native countdown and a cancel action before capture begins', () => {
    const markup = recorderMarkup('armed', 3);
    expect(markup).toContain('Cancel countdown');
    expect(markup).toContain('Recording starts in 3');
    expect(markup).not.toContain('Stop recording');
  });
  it('keeps finalization distinct from a live capture or a new Start', () => {
    const markup = recorderMarkup('finishing', null);
    expect(markup).toContain('Saving recording');
    expect(markup).not.toContain('Stop recording');
    expect(markup).not.toContain('Start recording');
  });
  it('retains a Stop action while a take is paused', () => {
    const markup = recorderMarkup('paused', null);
    expect(markup).toContain('Recording paused');
    expect(markup).toContain('Stop recording');
  });
});
