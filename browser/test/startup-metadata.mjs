// Scalar observations from an explicitly generated startup diagnostic only.
export const startupPrefix = 'GENERATED_CAPTURE_STARTUP ';
const roles = ['screen', 'camera', 'microphone', 'tab-audio', 'composed'];
const phases = ['session-start-entered', 'session-start-resolved', 'journal-load-entered', 'journal-load-resolved'];
export function startupMetadata(text) {
  if (typeof text !== 'string' || text.length > 4096 || !text.startsWith(startupPrefix)) return;
  let row; try { row = JSON.parse(text.slice(startupPrefix.length)); } catch { return; }
  if (!row || Array.isArray(row) || typeof row.takeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.takeId)
    || !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= 256 || !Number.isFinite(row.timeMs) || row.timeMs < 0) return;
  const keys = Object.keys(row).sort().join(',');
  if (row.kind === 'phase' && keys === 'index,kind,phase,takeId,timeMs' && phases.includes(row.phase)) return row;
  if (row.kind === 'warning' && keys === 'index,kind,message,state,takeId,timeMs'
    && ['ready', 'recording', 'paused', 'stopping', 'complete', 'interrupted', 'failed'].includes(row.state)
    && typeof row.message === 'string' && row.message.length <= 512) return row;
  if (row.kind === 'recorder-event' && keys === 'event,id,index,kind,role,state,takeId,timeMs'
    && Number.isSafeInteger(row.id) && row.id >= 0 && row.id < roles.length && roles[row.id] === row.role
    && ['start', 'error', 'stop'].includes(row.event) && ['inactive', 'recording', 'paused'].includes(row.state)) return row;
}

export function collectStartupMetadata(evidence, text) {
  if (!text.startsWith(startupPrefix)) return;
  const row = startupMetadata(text);
  if (!row) { evidence.invalidStartupObservations++; return; }
  if (row.kind === 'warning' && evidence.firstStartupWarning === undefined) evidence.firstStartupWarning = row;
  const takeId = evidence.startupObservationTakeId;
  if (takeId === undefined) evidence.startupObservationTakeId = row.takeId;
  if ((takeId !== undefined && takeId !== row.takeId) || row.index !== evidence.nextStartupObservationIndex)
    evidence.startupObservationSequenceErrors++;
  evidence.nextStartupObservationIndex = row.index + 1;
  if (evidence.startupObservations.length >= 128) { evidence.droppedStartupObservations++; return row.kind === 'warning' ? row : undefined; }
  evidence.startupObservations.push(row);
  return row;
}
