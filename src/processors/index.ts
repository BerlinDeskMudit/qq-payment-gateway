/**
 * Processor abstraction. Everything above this interface is ours; everything
 * below it is somebody else's protocol.
 *
 * Two rules the interface exists to enforce:
 *   1. Every mutating call takes a caller-supplied idempotency key, and the
 *      adapter must pass it to the processor as the provider idempotency key.
 *      Local deduplication alone is not enough: a crash between our write and
 *      the processor's response must not become a second charge.
 *   2. The adapter records which processor it used, so a retry is routed back
 *      to the same provider rather than failing over mid-payment.
 */

export type AuthorizationResult =
  | { outcome: 'approved'; networkReference: string }
  | { outcome: 'declined'; declineCode: string; declineMessage: string }
  | { outcome: 'requires_action'; redirectUrl: string; networkReference: string }
  | { outcome: 'error'; errorCode: string; retryable: boolean };

export type CaptureResult =
  | { outcome: 'captured'; networkReference: string }
  | { outcome: 'capture_failed'; errorCode: string; retryable: boolean };

export type VoidResult =
  | { outcome: 'voided' }
  | { outcome: 'void_failed'; errorCode: string; retryable: boolean };

export type RefundResult =
  | { outcome: 'refunded'; networkReference: string }
  | { outcome: 'refund_failed'; errorCode: string; retryable: boolean };

export type ProcessorName = 'sandbox' | 'acquirer_a' | 'acquirer_b';

export interface Processor {
  readonly name: ProcessorName;
  authorize(input: {
    idempotencyKey: string;
    processorToken: string;
    amount: number;
    currency: string;
    networkReference?: string;
    /**
     * The outcome of an issuer challenge the cardholder has already been
     * shown. Set by a flow that performed the challenge (hosted Checkout
     * renders it inline); production adapters must take it from the
     * processor's own challenge response, never from anything the client
     * submitted, because accepting it from the browser is a 3DS bypass.
     */
    challengeResult?: 'passed';
  }): Promise<AuthorizationResult>;
  capture(input: {
    idempotencyKey: string;
    networkReference: string;
    amount: number;
    currency: string;
  }): Promise<CaptureResult>;
  void(input: { idempotencyKey: string; networkReference: string }): Promise<VoidResult>;
  refund(input: {
    idempotencyKey: string;
    networkReference: string;
    amount: number;
    currency: string;
  }): Promise<RefundResult>;
}

/**
 * Deterministic sandbox processor.
 *
 * Outcomes are driven by the processor token, which the tokenization layer
 * derives from well-known test card numbers. Same input, same output, every
 * time: a flaky test result is worse than no test.
 */

export type SandboxBehaviour = 'approve' | 'decline' | 'three_ds' | 'error' | 'insufficient' | 'unknown';

const SANDBOX_TOKENS: Record<string, SandboxBehaviour> = {
  tok_sandbox_4242: 'approve',
  tok_sandbox_1111: 'approve',
  tok_sandbox_0002: 'decline',
  tok_sandbox_9995: 'three_ds',
  tok_sandbox_0119: 'insufficient',
  tok_sandbox_0069: 'error',
};

/** Maps a test card number to the behaviour the sandbox will exhibit. */
export function behaviourForTestCard(cardNumber: string): SandboxBehaviour {
  const digits = cardNumber.replace(/\D/g, '');
  if (digits.endsWith('4242') || digits.endsWith('1111')) return 'approve';
  if (digits.endsWith('0002')) return 'decline';
  if (digits.endsWith('9995')) return 'three_ds';
  if (digits.endsWith('0119')) return 'insufficient';
  if (digits.endsWith('0069')) return 'error';
  return 'unknown';
}

/** Deterministic token for a test card. Not a real vault token. */
export function sandboxTokenFor(cardNumber: string): string {
  const last4 = cardNumber.replace(/\D/g, '').slice(-4);
  return `tok_sandbox_${last4 || '0000'}`;
}

export class SandboxProcessor implements Processor {
  readonly name = 'sandbox' as const;

  async authorize(input: {
    idempotencyKey: string;
    processorToken: string;
    amount: number;
    currency: string;
    networkReference?: string;
    challengeResult?: 'passed';
  }): Promise<AuthorizationResult> {
    // Provider-side idempotency: reauthorizing the same key returns the
    // original result rather than creating a second authorization.
    const memo = this.memo(input.idempotencyKey);
    if (memo) return memo.result;

    const behaviour = SANDBOX_TOKENS[input.processorToken] ?? 'unknown';
    let result: AuthorizationResult;

    switch (behaviour) {
      case 'approve':
        result = { outcome: 'approved', networkReference: `auth_${input.idempotencyKey.slice(-12)}` };
        break;
      case 'three_ds':
        // A 3DS card challenges on the first authorization and approves once
        // the challenge has been answered, which is what an issuer does. The
        // challenge itself is rendered by the hosted page; the answer comes
        // back through that flow, not from re-submitting the card.
        result = input.challengeResult === 'passed'
          ? { outcome: 'approved', networkReference: `auth_${input.idempotencyKey.slice(-12)}` }
          : {
              outcome: 'requires_action',
              redirectUrl: `https://sandbox.3ds.example/challenge/${input.idempotencyKey.slice(-8)}`,
              networkReference: `auth_${input.idempotencyKey.slice(-12)}`,
            };
        break;
      case 'insufficient':
        result = {
          outcome: 'declined',
          declineCode: 'insufficient_funds',
          declineMessage: 'The card does not have enough funds.',
        };
        break;
      case 'error':
        result = { outcome: 'error', errorCode: 'processor_unavailable', retryable: true };
        break;
      case 'decline':
      case 'unknown':
      default:
        result = { outcome: 'declined', declineCode: 'generic_decline', declineMessage: 'Your card was declined.' };
        break;
    }

    this.remember(input.idempotencyKey, result);
    return result;
  }

  async capture(input: { idempotencyKey: string; networkReference: string; amount: number; currency: string }): Promise<CaptureResult> {
    return { outcome: 'captured', networkReference: `chp_${input.idempotencyKey.slice(-12)}` };
  }

  async void(input: { idempotencyKey: string; networkReference: string }): Promise<VoidResult> {
    return { outcome: 'voided' };
  }

  async refund(input: { idempotencyKey: string; networkReference: string; amount: number; currency: string }): Promise<RefundResult> {
    return { outcome: 'refunded', networkReference: `rfp_${input.idempotencyKey.slice(-12)}` };
  }

  // Provider-side idempotency memo, in place for the process lifetime.
  private memos = new Map<string, { result: AuthorizationResult }>();

  private memo(key: string) {
    return this.memos.get(key);
  }

  private remember(key: string, result: AuthorizationResult) {
    this.memos.set(key, { result });
  }
}

export class ProcessorRegistry {
  private processors = new Map<ProcessorName, Processor>();

  register(processor: Processor): void {
    this.processors.set(processor.name, processor);
  }

  get(name: ProcessorName): Processor {
    const p = this.processors.get(name);
    if (!p) throw new Error(`No processor registered under '${name}'.`);
    return p;
  }

  /**
   * Picks the processor for a new intent. Later, when we add a second real
   * acquirer, routing belongs here, keyed on merchant config and card
   * geography, not scattered through the payments service.
   */
  pickDefault(): Processor {
    return this.get('sandbox');
  }
}
