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
    body: 'Choose what to show, check access and devices, then record. You can use the highlighted controls as you go. Nothing records until you choose Start recording. Skip hides this guide; Recording guide reopens it anytime.',
  },
  {
    title: 'What do you want to record?',
    target: 'capture-mode',
    body: 'Screen + camera is for a walkthrough with your face visible. Screen only leaves the camera off. Camera only turns screen capture off for a talking-head video. Your enabled inputs are saved as separate originals.',
  },
  {
    title: 'Choose your screen content',
    target: 'source',
    body: 'For a screen recording, choose Entire screen, A window, or Select area, then choose the actual source below. Select recording area lets you draw a frame on your desktop. Camera only leaves this screen source off.',
  },
  {
    title: 'Allow only the access you need',
    target: 'permissions',
    body: 'Use the access buttons for the inputs you enabled. Camera only does not need Screen Recording access. If access was denied, open Privacy & Security in System Settings, enable Rushes, then check again. Screen Recording access may require a relaunch.',
  },
  {
    title: 'Check camera and microphone',
    target: 'devices',
    body: 'Choose your camera to see its preview and your microphone to include your voice. Microphone off means no voice track. System audio includes sound from your Mac in screen recordings. Refresh devices after connecting a new device.',
  },
  {
    title: 'Ready for your first take',
    target: 'start',
    body: 'Start recording begins the audible countdown and minimizes this window. Drag the floating camera bubble to move it; × hides the bubble while keeping its camera track. Use the floating bar to Pause, Resume or Stop. After Stop, review your take and choose Save video, Save separate tracks or Create share link. Finish guide leaves you ready to record.',
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
