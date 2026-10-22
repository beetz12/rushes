import { z } from 'zod';

const failure = z.object({ code: z.string(), message: z.string() });

export function unwrapNativeResponse<T>(response: T): T {
  if (response && typeof response === 'object' && '__rushesError' in response) {
    const decoded = failure.safeParse(response.__rushesError);
    if (decoded.success)
      throw Object.assign(new Error(decoded.data.message), { code: decoded.data.code });
  }
  return response;
}
