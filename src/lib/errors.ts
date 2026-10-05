/**
 * Typed error envelope. `type` is the stable value integrators branch on.
 * `code` is the specific reason. `message` is human-facing and may be
 * reworded without notice, so nothing should parse it.
 */

export type ErrorType =
  | 'card_error'
  | 'invalid_request_error'
  | 'authentication_error'
  | 'api_error'
  | 'rate_limit_error'
  | 'idempotency_error';

export type ErrorCode =
  | 'card_declined'
  | 'expired_card'
  | 'incorrect_cvc'
  | 'processing_error'
  | 'authentication_required'
  | 'invalid_request'
  | 'parameter_missing'
  | 'parameter_invalid'
  | 'resource_missing'
  | 'state_transition_invalid'
  | 'amount_too_small'
  | 'amount_too_large'
  | 'currency_unsupported'
  | 'idempotency_key_reuse'
  | 'idempotency_key_in_progress'
  | 'authentication_required_key'
  | 'authentication_invalid_key'
  | 'permission_denied'
  | 'cross_account_access'
  | 'rate_limited'
  | 'internal_error';

export type ApiErrorBody = {
  error: {
    type: ErrorType;
    code: ErrorCode;
    message: string;
    decline_code?: string;
    charge?: string;
    request_id?: string;
    docs_url?: string;
    retryable: boolean;
  };
};

const DOCS_BASE = 'https://docs.qqpg.io/errors';

export class ApiError extends Error {
  readonly status: number;
  readonly type: ErrorType;
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly declineCode?: string;
  readonly chargeId?: string;
  /** Extra fields merged into the error object, e.g. remaining_amount. */
  readonly extra: Record<string, unknown>;

  constructor(opts: {
    status: number;
    type: ErrorType;
    code: ErrorCode;
    message: string;
    retryable?: boolean;
    declineCode?: string;
    chargeId?: string;
    extra?: Record<string, unknown>;
  }) {
    super(opts.message);
    this.name = 'ApiError';
    this.status = opts.status;
    this.type = opts.type;
    this.code = opts.code;
    this.retryable = opts.retryable ?? false;
    this.declineCode = opts.declineCode;
    this.chargeId = opts.chargeId;
    this.extra = opts.extra ?? {};
  }

  toBody(requestId?: string): ApiErrorBody {
    return {
      error: {
        type: this.type,
        code: this.code,
        message: this.message,
        docs_url: `${DOCS_BASE}/${this.code.replace(/_/g, '-')}`,
        retryable: this.retryable,
        ...(this.declineCode ? { decline_code: this.declineCode } : {}),
        ...(this.chargeId ? { charge: this.chargeId } : {}),
        ...(requestId ? { request_id: requestId } : {}),
        ...this.extra,
      },
    };
  }
}

// ---------------------------------------------------------------- constructors

export const invalidRequest = (message: string, code: ErrorCode = 'invalid_request') =>
  new ApiError({ status: 400, type: 'invalid_request_error', code, message });

export const resourceMissing = (type: string, id: string) =>
  new ApiError({
    status: 404,
    type: 'invalid_request_error',
    code: 'resource_missing',
    message: `No such ${type}: '${id}'`,
  });

/** Raised when a resource exists but belongs to a different account. */
export const crossAccount = (type: string) =>
  new ApiError({
    status: 404,
    type: 'invalid_request_error',
    code: 'cross_account_access',
    message: `No such ${type} for this account.`,
  });

export const invalidStateTransition = (from: string, action: string, intentId: string) =>
  new ApiError({
    status: 409,
    type: 'invalid_request_error',
    code: 'state_transition_invalid',
    message: `Cannot ${action} a payment intent in state '${from}'.`,
    extra: { payment_intent: intentId, current_status: from },
  });

export const idempotencyKeyReuse = () =>
  new ApiError({
    status: 409,
    type: 'idempotency_error',
    code: 'idempotency_key_reuse',
    message: 'This idempotency key was already used with a different request body.',
  });

export const idempotencyInProgress = () =>
  new ApiError({
    status: 409,
    type: 'idempotency_error',
    code: 'idempotency_key_in_progress',
    message: 'A request with this idempotency key is currently in progress. Retry shortly.',
    retryable: true,
  });

export const permissionDenied = (message = 'This API key cannot perform that action.') =>
  new ApiError({ status: 403, type: 'authentication_error', code: 'permission_denied', message });

export const authenticationRequired = () =>
  new ApiError({
    status: 401,
    type: 'authentication_error',
    code: 'authentication_required',
    message: 'Provide an API key in the Authorization header.',
  });

export const authenticationInvalid = () =>
  new ApiError({
    status: 401,
    type: 'authentication_error',
    code: 'authentication_invalid_key',
    message: 'Invalid or revoked API key.',
  });

export const rateLimited = (retryAfterSeconds: number) =>
  new ApiError({
    status: 429,
    type: 'rate_limit_error',
    code: 'rate_limited',
    message: 'Too many requests.',
    retryable: true,
    extra: { retry_after: retryAfterSeconds },
  });

export const cardDeclined = (declineCode: string, message: string, chargeId?: string) =>
  new ApiError({
    status: 402,
    type: 'card_error',
    code: 'card_declined',
    message,
    declineCode,
    chargeId,
  });

export const internal = (message = 'An unexpected error occurred.') =>
  new ApiError({
    status: 500,
    type: 'api_error',
    code: 'internal_error',
    message,
    retryable: true,
  });
