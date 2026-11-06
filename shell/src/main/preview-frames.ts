import { previewAcknowledgment, previewAcknowledgmentSchema } from '../shared/contracts';

// A native source token must survive both JPEG processing and the socket's
// pending-frame mailbox. An obsolete acknowledgment cannot restore a cleared UI.
export class PreviewFrames {
  private generation = 0;
  private token?: string;
  get currentToken() {
    return this.token;
  }
  clear() {
    this.token = undefined;
    return ++this.generation;
  }
  install(raw: unknown, generation = this.generation) {
    if (generation !== this.generation) return false;
    try {
      this.token = previewAcknowledgment(raw).previewToken;
    } catch (error) {
      this.clear();
      throw error;
    }
    return true;
  }
  accepts(raw: unknown) {
    const frame = previewAcknowledgmentSchema.safeParse(raw);
    return !!this.token && frame.success && frame.data.previewToken === this.token;
  }
}
