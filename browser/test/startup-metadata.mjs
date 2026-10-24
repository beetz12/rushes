// Scalar observations from an explicitly generated startup diagnostic only.
export const startupPrefix = 'GENERATED_CAPTURE_STARTUP ';
const roles = ['screen', 'camera', 'microphone', 'tab-audio', 'composed'];
const phases = ['session-start-entered', 'session-start-resolved', 'journal-load-entered', 'journal-load-resolved'];
const scalarCount = value => Number.isSafeInteger(value) && value >= 0 && value <= 2147483647;
const scalarAge = value => value === null || scalarCount(value);
const vector = (value, length) => Array.isArray(value) && value.length === length && value.every(scalarCount);
export function audioFailureMetadata(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object') return;
  if (Object.keys(value).sort().join(',') !== 'closed,consumed,edge,input,lastAgeMs,lastKind,messages,output,pending,posted,quiesced,readied,schema,waitMs,writeAgeMs,writing') return;
  if (value.schema !== 1 || !['before-wait', 'timer', 'late-wake', 'other'].includes(value.edge)) return;
  if (value.input !== null && (!vector(value.input, 3) || ![0, 1].includes(value.input[0]) || value.input[1] === 0 || value.input[2] === 0)) return;
  if (![value.pending, value.posted, value.consumed].every(row => vector(row, 2)) || !scalarCount(value.messages)) return;
  if (![null, 'consumed', 'packet', 'ready', 'timing', 'error', 'stopped', 'unknown'].includes(value.lastKind)) return;
  if (![value.waitMs, value.lastAgeMs, value.writeAgeMs].every(scalarAge)) return;
  if (!Array.isArray(value.output) || value.output.length !== 4 || !scalarCount(value.output[0])
    || !scalarAge(value.output[1]) || !scalarCount(value.output[2]) || !scalarCount(value.output[3])) return;
  if (![value.writing, value.readied, value.quiesced, value.closed].every(flag => typeof flag === 'boolean')) return;
  return value;
}
export function lateAudioMetadata(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object' || !scalarCount(value.afterMs)) return;
  const keys = Object.keys(value).sort().join(',');
  if (value.event === 'consumed' && keys === 'afterMs,event,frames,source' && [0, 1].includes(value.source)
    && scalarCount(value.frames) && value.frames > 0) return value;
  if (value.event === 'error' && keys === 'afterMs,event,message' && typeof value.message === 'string' && value.message.length <= 512) return value;
  if (value.event === 'stopped' && keys === 'afterMs,event') return value;
}
export function encoderStartMetadata(value) {
  if (!value || Array.isArray(value) || typeof value !== 'object'
    || Object.keys(value).sort().join(',') !== 'atMs,audio,elapsedMs,encoders,released,role,schema,tracks,type') return;
  if (value.type !== 'encoder-start' || value.schema !== 1 || !roles.includes(value.role)
    || !scalarCount(value.atMs) || !scalarCount(value.elapsedMs) || typeof value.released !== 'boolean') return;
  if (!Array.isArray(value.encoders) || value.encoders.length < 1 || value.encoders.length > roles.length) return;
  if (!value.encoders.every(row => Array.isArray(row) && row.length === 8 && roles.includes(row[0])
    && ['inactive', 'recording', 'paused'].includes(row[1]) && row.slice(2).every(scalarCount))) return;
  if (new Set(value.encoders.map(row => row[0])).size !== value.encoders.length || !value.encoders.some(row => row[0] === value.role)) return;
  const trackRoles = [...roles.slice(0, 4), 'preview-video', 'preview-audio'];
  if (!Array.isArray(value.tracks) || value.tracks.length > 6 || !value.tracks.every(row => Array.isArray(row) && row.length === 4
    && trackRoles.includes(row[0]) && ['live', 'ended'].includes(row[1]) && row.slice(2).every(flag => typeof flag === 'boolean'))
    || new Set(value.tracks.map(row => row[0])).size !== value.tracks.length) return;
  if (value.audio !== null) {
    if (!value.audio || Object.keys(value.audio).sort().join(',') !== 'closed,consumed,lastAgeMs,lastKind,messages,output,pending,posted,quiesced,readied,writeAgeMs,writing'
      || !audioFailureMetadata({ schema: 1, edge: 'other', input: null, waitMs: null, ...value.audio })) return;
  }
  return value;
}
export function startupMetadata(text) {
  if (typeof text !== 'string' || text.length > 4096 || !text.startsWith(startupPrefix)) return;
  let row; try { row = JSON.parse(text.slice(startupPrefix.length)); } catch { return; }
  if (!row || Array.isArray(row) || typeof row.takeId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(row.takeId)
    || !Number.isSafeInteger(row.index) || row.index < 0 || row.index >= 256 || !Number.isFinite(row.timeMs) || row.timeMs < 0) return;
  const keys = Object.keys(row).sort().join(',');
  if (row.kind === 'phase' && keys === 'index,kind,phase,takeId,timeMs' && phases.includes(row.phase)) return row;
  if (row.kind === 'warning' && ['index,kind,message,state,takeId,timeMs', 'audio,index,kind,message,state,takeId,timeMs'].includes(keys)
    && ['ready', 'recording', 'paused', 'stopping', 'complete', 'interrupted', 'failed'].includes(row.state)
    && typeof row.message === 'string' && row.message.length <= 512
    && (!Object.hasOwn(row, 'audio') || audioFailureMetadata(row.audio))) return row;
  if (row.kind === 'encoder-timeout' && keys === 'detail,index,kind,takeId,timeMs' && encoderStartMetadata(row.detail)) return row;
  if (row.kind === 'audio-late' && row.workerId === 0) {
    const { takeId, index, timeMs, kind, workerId, ...detail } = row;
    if (lateAudioMetadata(detail)) return row;
  }
  if (row.kind === 'recorder-event' && keys === 'event,id,index,kind,role,state,takeId,timeMs'
    && Number.isSafeInteger(row.id) && row.id >= 0 && row.id < roles.length && roles[row.id] === row.role
    && ['start', 'error', 'stop'].includes(row.event) && ['inactive', 'recording', 'paused'].includes(row.state)) return row;
}

export function collectStartupMetadata(evidence, text) {
  if (!text.startsWith(startupPrefix)) return;
  const row = startupMetadata(text);
  if (!row) { evidence.invalidStartupObservations++; return; }
  if (row.kind === 'encoder-timeout' && evidence.firstEncoderTimeout === undefined) evidence.firstEncoderTimeout = row;
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
