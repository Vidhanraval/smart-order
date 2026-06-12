// ── Flow completion payload (arrives inside a type: 'flow' message) ──

export interface FlowCompletionPayload {
  id: string; // Flow ID from Meta
  token: string; // flow_token we sent
  response: Record<string, string>; // user-submitted form data
}

// ── WhatsApp message ──────────────────────────────────────────────

export interface WhatsAppMessage {
  from: string; // phone number
  id: string; // WhatsApp message ID
  timestamp: string;
  type: 'text' | 'image' | 'audio' | 'button' | 'interactive' | 'flow';
  text?: { body: string };
  image?: { id: string; mime_type: string; sha256: string; caption?: string };
  audio?: { id: string; mime_type: string };
  button?: { payload: string; text: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description: string };
  };
  flow?: FlowCompletionPayload;
}

export interface WhatsAppWebhookPayload {
  object: string;
  entry: Array<{
    id: string;
    changes: Array<{
      value: {
        messaging_product: string;
        metadata: {
          display_phone_number: string;
          phone_number_id: string;
        };
        contacts?: Array<{
          profile: { name: string };
          wa_id: string;
        }>;
        messages?: WhatsAppMessage[];
        statuses?: Array<{
          id: string;
          status: string;
          timestamp: string;
          recipient_id: string;
        }>;
      };
      field: string;
    }>;
  }>;
}
