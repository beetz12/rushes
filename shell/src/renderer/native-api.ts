import { unwrapNativeResponse } from '../shared/native-result';

// contextBridge copies Error.message/stack but drops custom Error properties.
// Decode the plain IPC envelope in the renderer, after crossing that boundary.
export function createNativeAPI<T extends object>(bridge: T): T {
  const client = { ...bridge };
  for (const [name, action] of Object.entries(bridge)) {
    if (name === 'onEvent' || typeof action !== 'function') continue;
    Object.defineProperty(client, name, {
      enumerable: true,
      value: async (...args: unknown[]) =>
        unwrapNativeResponse(await Reflect.apply(action, bridge, args)),
    });
  }
  return client;
}
