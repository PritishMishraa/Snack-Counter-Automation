import type { EmployeeId } from '../domain/model.js';
import type { ChatAction, ChatPort } from '../ports.js';

export interface SentMessage {
  readonly kind: 'direct' | 'channel';
  readonly to: string;
  readonly text: string;
  readonly actions: readonly ChatAction[];
}

/** Records every message instead of sending it. Tests assert on `messages`; the demo prints them. */
export class FakeChat implements ChatPort {
  readonly messages: SentMessage[] = [];
  private listener: ((m: SentMessage) => void) | undefined;

  onMessage(listener: (m: SentMessage) => void): void {
    this.listener = listener;
  }

  async sendDirect(to: EmployeeId, text: string, actions: readonly ChatAction[] = []): Promise<void> {
    this.record({ kind: 'direct', to, text, actions });
  }

  async postToChannel(channel: string, text: string, actions: readonly ChatAction[] = []): Promise<void> {
    this.record({ kind: 'channel', to: channel, text, actions });
  }

  directTo(employeeId: EmployeeId): SentMessage[] {
    return this.messages.filter((m) => m.kind === 'direct' && m.to === employeeId);
  }

  inChannel(channel: string): SentMessage[] {
    return this.messages.filter((m) => m.kind === 'channel' && m.to === channel);
  }

  clear(): void {
    this.messages.length = 0;
  }

  private record(m: SentMessage): void {
    this.messages.push(m);
    this.listener?.(m);
  }
}
