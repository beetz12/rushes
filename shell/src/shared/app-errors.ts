import { isConnectionErrorCode } from './connection-error';

export type ErrorNotice = { message: string; code?: unknown };
export type AppErrors = {
  connection: { first: ErrorNotice; latest: ErrorNotice } | null;
  action: ErrorNotice | null;
};
export type ErrorTransition =
  | { type: 'report'; notice: ErrorNotice }
  | { type: 'clear-action' }
  | { type: 'verified-recovery' };
export const initialAppErrors: AppErrors = { connection: null, action: null };

export function appErrors(state: AppErrors, transition: ErrorTransition): AppErrors {
  if (transition.type === 'clear-action') return { ...state, action: null };
  if (transition.type === 'verified-recovery') return { ...state, connection: null };
  const notice = transition.notice;
  if (!notice.message) return { ...state, action: null };
  if (isConnectionErrorCode(notice.code))
    return {
      ...state,
      connection: { first: state.connection?.first ?? notice, latest: notice },
    };
  return { ...state, action: notice };
}
export function connectionMessages(state: AppErrors): string[] {
  if (!state.connection) return [];
  const { first, latest } = state.connection;
  return first.message === latest.message ? [first.message] : [first.message, latest.message];
}
export function appErrorText(state: AppErrors): string {
  return [...connectionMessages(state), ...(state.action ? [state.action.message] : [])].join('\n');
}
