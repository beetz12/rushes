import type { CaptureInputs, CaptureSession } from '../contracts';
// Wave-zero import seam; the capture slice replaces this before integration acceptance.
export async function createCaptureSession(_inputs: CaptureInputs): Promise<CaptureSession> {
  throw new Error('Capture implementation is not integrated yet.');
}
