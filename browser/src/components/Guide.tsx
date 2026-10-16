import { useEffect, useState } from 'react';
import { Icon } from './common';
const guideKey = 'rushes.browser.guide.v1';
const steps = [
  {target: 'mode', title: 'Start with what you want to show', text: 'Choose your screen, your camera, or both. Your screen and talking head are also saved as separate originals.'},
  {target: 'devices', title: 'Check your picture and sound', text: 'Enable camera and microphone when you need them. Rushes only requests access when you click. Check the live preview and microphone level before starting.'},
  {target: 'protection', title: 'Give your recording a backup', text: 'Drafts save on this browser. Persistent storage helps, but you can also choose a backup folder. Clearing browser data can remove local drafts.'},
  {target: 'start', title: 'Choose a screen for every take', text: 'The browser asks which tab, window or screen to record each time. Share tab audio if available. Cancelling that picker returns here without recording.'},
  {target: 'preview', title: 'Put your talking head in the right place', text: 'Drag the camera bubble within this preview. It is baked into the composed video. The preview stays on this page; it cannot float above other apps.'},
  {target: 'library', title: 'Review, download, then share', text: 'Find local drafts and download your composed video and separate originals. Paid cloud hosting needs sign-in and a subscription; every hosted video starts private.'},
];
export function useGuide() {
  const [open, setOpen] = useState(() => { try { return !localStorage.getItem(guideKey); } catch { return true; } });
  const [step, setStep] = useState(0);
  function dismiss(status: string) { try { localStorage.setItem(guideKey, status); } catch { /* This browser does not permit preference storage. */ } setOpen(false); }
  return { open, step, setStep, skip: () => dismiss('skipped'), finish: () => dismiss('completed'), replay: () => { setStep(0); setOpen(true); } };
}
export function Guide({ guide }: {guide: ReturnType<typeof useGuide>}) {
  useEffect(() => {
    if (!guide.open) return;
    const target = document.querySelector(`[data-guide="${steps[guide.step].target}"]`);
    target?.classList.add('guide-highlight');
    target?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return () => { target?.classList.remove('guide-highlight'); };
  }, [guide.open, guide.step]);
  if (!guide.open) return null;
  const step = steps[guide.step];
  return <aside className="guide-card" role="dialog" aria-label="First recording guide" aria-modal="false">
    <div className="guide-top"><span>YOUR FIRST RECORDING · {guide.step + 1} / {steps.length}</span><button aria-label="Dismiss guide (skip)" onClick={guide.skip}><Icon name="close" size={16}/></button></div>
    <h2>{step.title}</h2><p>{step.text}</p>
    <div className="guide-dots" aria-hidden="true">{steps.map((_, i) => <i key={i} className={i === guide.step ? 'selected' : ''}/>)}</div>
    <div className="guide-actions"><button className="text-button" onClick={guide.skip}>Skip guide</button><div>{guide.step > 0 && <button onClick={() => guide.setStep(guide.step - 1)}>Back</button>}<button className="primary" onClick={() => guide.step === steps.length - 1 ? guide.finish() : guide.setStep(guide.step + 1)}>{guide.step === steps.length - 1 ? 'Got it' : 'Next'}<Icon name="arrow" size={16}/></button></div></div>
  </aside>;
}
