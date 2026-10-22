import { useEffect, useRef } from 'react';
export function Icon({ name, size = 20 }: { name: string; size?: number }) {
  const paths: Record<string, string> = {
    record: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20',
    grid: 'M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z',
    cloud: 'M7 18H6a4 4 0 0 1-1-8 7 7 0 0 1 13-2 5 5 0 0 1 0 10h-1 M12 20V10 M8 14l4-4 4 4',
    screen: 'M3 4h18v13H3z M8 21h8 M12 17v4',
    camera: 'M3 6h12v12H3z M15 10l6-3v10l-6-3',
    mic: 'M9 4a3 3 0 0 1 6 0v8a3 3 0 0 1-6 0z M6 10v2a6 6 0 0 0 12 0v-2 M12 18v4 M8 22h8',
    help: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20 M9 8a3 3 0 1 1 4 3c-1 1-1 1-1 3 M12 17v1',
    arrow: 'M5 12h14 M14 7l5 5-5 5',
    down: 'M12 3v12 M7 10l5 5 5-5 M4 17v4h16v-4',
    check: 'M5 12l4 4 10-10',
    pause: 'M8 5v14 M16 5v14',
    stop: 'M5 5h14v14H5z',
    close: 'M6 6l12 12 M18 6 6 18',
    user: 'M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0 M4 22v-3a8 8 0 0 1 16 0v3',
    lock: 'M5 10h14v11H5z M8 10V6a4 4 0 1 1 8 0v4',
  };
  return <svg aria-hidden="true" strokeLinejoin="round" width={size} stroke="currentColor" viewBox="0 0 24 24" height={size} strokeLinecap="round" fill="none" strokeWidth="1.7"><path d={paths[name] ?? paths.record}/></svg>;
}
export function LiveVideo({ stream, className = '', label }: {stream?: MediaStream; className?: string; label: string}) {
  const element = useRef<HTMLVideoElement>(null);
  useEffect(() => { if (element.current) { element.current.srcObject = stream ?? null; if (stream) void element.current.play().catch(() => {}); } return () => { if (element.current) element.current.srcObject = null; }; }, [stream]);
  return <video ref={element} className={className} autoPlay playsInline muted aria-label={label}/>;
}
export const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2,'0')}:${Math.floor(ms / 1000 % 60).toString().padStart(2,'0')}`;
export const bytes = (value: number) => value < 1024 ** 2 ? `${Math.round(value / 1024)} KB` : `${(value / 1024 ** 2).toFixed(1)} MB`;
export function Notice({children, error = false}: {children: React.ReactNode; error?: boolean}) { return <div className={`notice ${error ? 'error' : ''}`} role={error ? 'alert' : 'status'}>{children}</div>; }
