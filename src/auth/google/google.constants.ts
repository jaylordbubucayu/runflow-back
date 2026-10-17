/** Machine-readable reasons a Google sign-in can fail. They travel to the frontend as ?googleError=<code>. */
export type GoogleLoginErrorCode =
  | 'access_denied' // the user pressed Cancel on Google's screen
  | 'invalid_state' // missing/expired/tampered state cookie, or state mismatch (possible CSRF)
  | 'exchange_failed' // Google rejected the code, or returned an unusable ID token
  | 'email_unverified' // Google says this email address is not verified
  | 'account_suspended'
  | 'account_conflict' // this RunFlow account is already linked to a different Google account
  | 'not_configured';

export class GoogleLoginError extends Error {
  constructor(public readonly code: GoogleLoginErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'GoogleLoginError';
  }
}

/** Roles a person may pick for themselves when creating an account with Google. Never `admin`. */
export const SELF_SERVE_ROLES = ['runner', 'organizer'] as const;
export type SelfServeRole = (typeof SELF_SERVE_ROLES)[number];

export const STATE_COOKIE = 'rf_google_oauth';
export const STATE_TTL_MS = 10 * 60 * 1000;
export const LOGIN_CODE_TTL_MS = 60 * 1000;
