import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  GuideSession,
  guideAllowed,
  guideCardPosition,
  visibleTourRect,
  type GuideState,
  type TourRect,
} from './onboarding-state';
import type { RushesAPI } from '../shared/contracts';

const steps = [
  {
    title: 'Your first recording',
    target: '',
    body: 'A short guide to access, sources and recording controls. You can use the highlighted controls as you go. Nothing records until you choose Start recording.',
  },
  {
    title: 'Choose the access you need',
    target: 'permissions',
    body: 'Screen Recording is needed when you capture a screen. Camera only leaves screen capture off and needs Camera access. Microphone access is optional for your voice. After a denial, open Privacy & Security in System Settings, enable Rushes, then check again. A Screen Recording grant may need a relaunch. Accessibility and Input Monitoring are only for optional advanced tracking.',
  },
  {
    title: 'Choose what to show',
    target: 'source',
    body: 'Record an entire display, one window, or a selected rectangle. Camera only turns screen capture off for a talking-head video. Choose the actual screen source below these tabs. For an area, use Select recording area and drag your frame.',
  },
  {
    title: 'Choose your devices',
    target: 'devices',
    body: 'Camera off and Microphone off work for a silent screen recording. Select a camera to open its preview, a microphone for your voice, and System audio for sound from your Mac. Use Refresh devices after connecting a device.',
  },
  {
    title: 'Start when you are ready',
    target: 'start',
    body: 'Choose no countdown, 3 seconds or 5 seconds. A short tone marks each countdown step; Escape cancels. When the take actually starts, the main window minimizes and the camera bubble and floating Pause, Resume and Stop bar stay available. Finish guide does not start a recording.',
  },
  {
    title: 'Move or hide your camera',
    target: 'bubble-help',
    body: 'Drag the floating camera bubble to move it. Its × button hides the overlay during a take while your camera track continues. When idle, × also stops the preview. You can choose the camera again to reopen it. Bubble size is in Settings.',
  },
  {
    title: 'Keep originals; export a video',
    target: 'originals',
    body: 'Rushes keeps screen, camera, microphone and system audio as separate original tracks for the inputs you enabled. After Stop, review the take in My recordings and choose one combined video or separate original files under Export output. Sharing uploads a rendered video through your configured provider. Review sharing settings before your first take, including Auto-share. Finish guide leaves you here, ready to choose Start recording.',
  },
];

export function OnboardingTour({
  api,
  recordingState,
  countdown,
  onStep,
  onError,
}: {
  api: RushesAPI;
  recordingState: string;
  countdown: number | null;
  onStep: (target: string | null) => void;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<GuideState>({
    open: false,
    step: 0,
    saving: false,
    error: '',
  });
  const session = useMemo(
    () => new GuideSession((action) => api.onboarding(action), setState),
    [api],
  );
  const cardRef = useRef<HTMLElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const returnFocus = useRef<HTMLElement | null>(null);
  const [bounds, setBounds] = useState<TourRect | null>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const visible = state.open && guideAllowed(recordingState, countdown);
  const step = steps[state.step];
  useEffect(() => {
    void session.load();
    const refresh = () => void session.load();
    window.addEventListener('focus', refresh);
    const off = api.onEvent((event) => {
      if (event.event !== 'onboarding-changed') return;
      if (event.action === 'reset') void session.replaySaved();
      else refresh();
    });
    return () => {
      off();
      window.removeEventListener('focus', refresh);
    };
  }, [api, session]);
  useEffect(() => {
    onStep(visible ? step.target : null);
    return () => onStep(null);
  }, [visible, step.target, onStep]);
  useEffect(() => {
    if (!visible) return;
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
    };
  }, [visible]);
  useEffect(() => {
    if (visible) headingRef.current?.focus({ preventScroll: true });
  }, [visible, state.step]);
  useEffect(() => {
    if (!state.open && state.error) onError(state.error);
  }, [state.error, state.open, onError]);
  useLayoutEffect(() => {
    if (!visible) return;
    let frame = 0;
    let target: HTMLElement | null = null;
    const measure = () => {
      target = step.target
        ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
        : null;
      const next = visibleTourRect(
        target?.getBoundingClientRect() ?? null,
        window.innerWidth,
        window.innerHeight,
      );
      setBounds(next);
      const card = cardRef.current?.getBoundingClientRect();
      if (card)
        setPosition(
          guideCardPosition(
            next,
            { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
            card,
          ),
        );
    };
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(measure);
    };
    target = step.target
      ? document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`)
      : null;
    target?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    measure();
    const resize = new ResizeObserver(schedule);
    if (cardRef.current) resize.observe(cardRef.current);
    if (target) resize.observe(target);
    const mutation = new MutationObserver(schedule);
    mutation.observe(document.querySelector('.main') ?? document.body, {
      childList: true,
      subtree: true,
    });
    window.addEventListener('resize', schedule);
    window.addEventListener('scroll', schedule, true);
    return () => {
      resize.disconnect();
      mutation.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('scroll', schedule, true);
    };
  }, [visible, step.target]);
  useEffect(() => {
    if (!visible) return;
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        void session.persist('dismiss');
        return;
      }
      if (!cardRef.current?.contains(document.activeElement)) return;
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        session.move(state.step + 1, steps.length - 1);
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        session.move(state.step - 1, steps.length - 1);
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  }, [visible, state.step, session]);
  if (!visible) return null;
  return (
    <div className="tour-layer">
      {bounds && (
        <div
          className="tour-spotlight"
          aria-hidden="true"
          style={{ left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height }}
        />
      )}
      <section
        className="tour-card"
        ref={cardRef}
        role="dialog"
        aria-modal="false"
        aria-labelledby="tour-title"
        aria-describedby="tour-description"
        style={position}
      >
        <div className="tour-progress">
          Recording guide · {state.step + 1} of {steps.length}
        </div>
        <h2 id="tour-title" ref={headingRef} tabIndex={-1}>
          {step.title}
        </h2>
        <p id="tour-description">{step.body}</p>
        {step.target && !bounds && (
          <p className="tour-missing" role="status">
            This control is outside the current view. You can continue the guide or scroll to it.
          </p>
        )}
        {state.error && (
          <p className="tour-error" role="alert">
            {state.error}
          </p>
        )}
        <div className="tour-actions">
          <button
            className="tour-skip"
            disabled={state.saving}
            onClick={() => void session.persist('dismiss')}
          >
            Skip guide
          </button>
          {state.step > 0 && (
            <button
              className="secondary small"
              disabled={state.saving}
              onClick={() => session.move(state.step - 1, steps.length - 1)}
            >
              Back
            </button>
          )}
          <button
            className="primary small"
            disabled={state.saving}
            onClick={() =>
              state.step === steps.length - 1
                ? void session.persist('complete')
                : session.move(state.step + 1, steps.length - 1)
            }
          >
            {state.saving
              ? 'Saving…'
              : state.step === 0
                ? 'Show me around'
                : state.step === steps.length - 1
                  ? 'Finish guide'
                  : 'Next'}
          </button>
        </div>
        <p className="tour-keyboard">Tab to use controls · ← / → within the guide · Esc to skip</p>
      </section>
    </div>
  );
}
