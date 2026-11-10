// Provider-neutral messaging port. WA-AKG is one implementation; a mock is used for tests/demo.

export interface Recipient {
  phoneNumber: string; // E.164
  jid: string | null;
}

export interface SendResult {
  externalMessageId: string | null;
}

export interface MessagingPort {
  readonly name: string;
  sendText(to: Recipient, text: string, meta: { correlationId: string }): Promise<SendResult>;
}

/** Normalised inbound message, produced by a provider-specific webhook parser. */
export interface InboundMessage {
  provider: string;
  externalMessageId: string;
  fromJid: string;
  fromPhone: string | null;
  text: string;
  timestamp: Date;
}

export type ParsedWebhook =
  | { kind: 'message'; message: InboundMessage }
  | { kind: 'ignored'; reason: string; externalMessageId?: string };
