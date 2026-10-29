/** An error the CLI knows how to present to the user. */
export class CliError extends Error {
  readonly code: string;
  readonly status: number | undefined;

  constructor(code: string, message: string, status?: number) {
    super(message);
    this.name = 'CliError';
    this.code = code;
    this.status = status;
  }
}

/** An error response from the Paperboy API, already mapped to a friendly message. */
export class ApiError extends CliError {
  readonly requestId: string | undefined;
  readonly apiMessage: string | undefined;

  constructor(opts: { code: string; status: number; apiMessage?: string; requestId?: string }) {
    super(opts.code, friendlyMessage(opts.status, opts.apiMessage, opts.requestId), opts.status);
    this.name = 'ApiError';
    this.requestId = opts.requestId;
    this.apiMessage = opts.apiMessage;
  }
}

export function friendlyMessage(status: number, apiMessage?: string, requestId?: string): string {
  const detail = apiMessage ? ` ${apiMessage}` : '';
  const ref = requestId ? ` (request ${requestId})` : '';
  switch (status) {
    case 401:
      return 'Not signed in, or the API key was rejected. Run `paperboy connect` to sign in.';
    case 402:
      return `Not enough credits for this action. Add credits in your Paperboy dashboard and try again.${ref}`;
    case 403:
      return `You do not have access to that.${detail}${ref}`;
    case 404:
      return `Not found.${detail}${ref}`;
    case 409:
      return `Conflict.${detail}${ref}`;
    case 422:
      return `The request was not accepted.${detail}${ref}`;
    case 429:
      return `Rate limited. Wait a moment and try again.${ref}`;
    default:
      if (status >= 500) {
        return `The Paperboy server had a problem (HTTP ${status}). Try again shortly.${detail}${ref}`;
      }
      return `${apiMessage ?? `Request failed with HTTP ${status}.`}${ref}`;
  }
}
