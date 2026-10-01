/**
 * Whether this deployment can receive a delivery callback at all.
 *
 * `lib/delivery-attrition.ts` reports `unevidenced` until Meta starts posting
 * delivery statuses, and that is the correct output — but it cannot tell you
 * *why* nothing is arriving, because from inside the process a callback that
 * was refused and a callback that was never sent look identical. Four things
 * have to be true before the first one lands, and three of them fail silently:
 *
 *   1. `WHATSAPP_APP_SECRET` is set. Without it the webhook refuses every
 *      callback, deliberately — see lib/whatsapp-status.ts, where an empty
 *      secret would otherwise verify forged signatures. The refusal is a 401
 *      in a log nobody is reading.
 *   2. `WHATSAPP_VERIFY_TOKEN` is set. Without it the GET handshake refuses,
 *      so the callback URL cannot be registered in the first place.
 *   3. The URL is registered and the app is subscribed to the business
 *      account. Nothing local can detect this; it needs Meta.
 *   4. The secret is the *right* secret. Nothing can detect this locally
 *      either — an HMAC computed with the wrong key verifies perfectly
 *      against itself — so this module checks the things that are detectable
 *      and does not pretend about the one that is not.
 *
 * The checks live here rather than in `scripts/preflight.ts` for the reason
 * that script already states about send safety: a preflight carrying its own
 * copy of a rule can report a state the runtime disagrees with, which is
 * worse than not checking. `verifyMetaSignature` is the authority on what the
 * webhook accepts, so the shape rules that gate it belong beside it and under
 * test.
 */

/** Where Meta must POST. Matches app/api/webhooks/whatsapp/route.ts. */
export const CALLBACK_PATH = "/api/webhooks/whatsapp";

/**
 * Meta app secrets are 32 lowercase hex characters.
 *
 * Used as a warning rather than a rule: the format is Meta's to change, and
 * refusing a credential because it did not match a pattern we inferred would
 * be this project making exactly the kind of unevidenced claim it audits. But
 * the app *id*, the WABA id and the access token are all right next to it on
 * the same dashboard page and none of them is 32 hex characters, so the shape
 * catches the paste that actually happens.
 */
export const APP_SECRET_PATTERN = /^[0-9a-f]{32}$/i;

export type ReadinessStatus = "ok" | "fail" | "warn";

export interface ReadinessCheck {
  name: string;
  status: ReadinessStatus;
  detail: string;
  /** What to do about it. Present whenever the status is not `ok`. */
  fix?: string;
}

/**
 * Decoration that survives a paste into `.env.local` and changes the value.
 *
 * Not hypothetical here. `WHATSAPP_DRY_RUN` once ended up as
 * `true          -> log instead of sending (safest)`, which is not the string
 * "true", and the pipeline switched itself to live sends without a word. A
 * secret with a trailing space produces a perfectly valid HMAC over the wrong
 * key, so the failure presents as "Meta's signatures are all wrong".
 */
function describeDecoration(raw: string): string | null {
  if (raw !== raw.trim()) return "surrounding whitespace";
  if (/^["'].*["']$/.test(raw)) return "surrounding quotes";
  if (/\s/.test(raw)) return "an embedded space — probably a trailing comment";
  return null;
}

export function checkAppSecret(raw: string | undefined): ReadinessCheck {
  const name = "delivery callback signature";

  if (!raw || raw.trim().length === 0) {
    return {
      name,
      status: "fail",
      detail: "WHATSAPP_APP_SECRET is unset — every delivery callback is refused",
      fix: "Meta app dashboard → App settings → Basic → App secret. Until it is set, delivery evidence never arrives and the dashboard's delivery panel stays unevidenced forever.",
    };
  }

  const decoration = describeDecoration(raw);
  if (decoration) {
    return {
      name,
      status: "fail",
      detail: `WHATSAPP_APP_SECRET has ${decoration}`,
      fix: "The value is signed over verbatim, so a stray character makes every signature mismatch — and it presents as Meta sending bad signatures rather than as a config error.",
    };
  }

  if (!APP_SECRET_PATTERN.test(raw)) {
    return {
      name,
      status: "warn",
      detail: `WHATSAPP_APP_SECRET is ${raw.length} characters, not the usual 32 hex`,
      fix: "Check this is the App secret and not the App ID, the WhatsApp Business Account ID, or the access token — all are on the same dashboard. Proceeding is fine if Meta has changed the format.",
    };
  }

  return {
    name,
    status: "ok",
    detail: "app secret present and the right shape",
  };
}

export function checkVerifyToken(raw: string | undefined): ReadinessCheck {
  const name = "delivery callback handshake";

  if (!raw || raw.trim().length === 0) {
    return {
      name,
      status: "fail",
      detail: "WHATSAPP_VERIFY_TOKEN is unset — the subscription handshake refuses",
      fix: "Invent any string, set it here, and paste the same string into Meta's callback configuration. Without it the URL cannot be registered at all, so no callback is ever sent.",
    };
  }

  const decoration = describeDecoration(raw);
  if (decoration) {
    return {
      name,
      status: "fail",
      detail: `WHATSAPP_VERIFY_TOKEN has ${decoration}`,
      // The handshake compares with ===, and the value also makes a round
      // trip through a query string on the way back.
      fix: "The token is compared exactly against the one Meta echoes, so a stray character fails the handshake with a bare 403 that names nothing.",
    };
  }

  return { name, status: "ok", detail: "verify token present" };
}

/**
 * The URL to paste into Meta's callback configuration.
 *
 * Derived rather than configured, because a second copy of the deployment's
 * own address is a second thing to get wrong — and the one place it must
 * match is a field in someone else's dashboard, where nothing will check it.
 */
export function checkCallbackUrl(baseUrl: string | null): ReadinessCheck {
  const name = "delivery callback URL";

  if (!baseUrl) {
    return {
      name,
      status: "warn",
      detail: "no public base URL to derive the callback from",
      fix: `Running locally, Meta cannot reach this process. Register https://<your-deployment>${CALLBACK_PATH} from a deployed environment, or tunnel to it.`,
    };
  }

  return {
    name,
    status: "ok",
    detail: `${baseUrl}${CALLBACK_PATH}`,
    fix: undefined,
  };
}

/**
 * Reads Meta's `/{waba-id}/subscribed_apps` response.
 *
 * This is the only one of the four preconditions that can actually be
 * confirmed rather than inferred: an empty list means no app will ever be
 * told about a delivery, however correct everything on this side is.
 */
export function readSubscription(params: {
  ok: boolean;
  body: unknown;
}): ReadinessCheck {
  const name = "delivery callback subscription";

  if (!params.ok) {
    const message = (params.body as any)?.error?.message ?? "lookup failed";
    return {
      name,
      status: "warn",
      detail: `could not check: ${message}`,
      fix: "Confirm in Meta's app dashboard → WhatsApp → Configuration that a callback URL is set and the `messages` field is subscribed.",
    };
  }

  const data = (params.body as any)?.data;
  const subscribed = Array.isArray(data) ? data.length : 0;

  if (subscribed === 0) {
    return {
      name,
      status: "fail",
      detail: "no app is subscribed to this business account",
      fix: "Meta app dashboard → WhatsApp → Configuration → Edit the callback URL, then subscribe to the `messages` field. Without the subscription Meta never POSTs a delivery status, so every send stays unconfirmed.",
    };
  }

  return {
    name,
    status: "ok",
    detail: `${subscribed} app(s) subscribed`,
  };
}

/**
 * Every check that needs no network. Ordered as they fail: a missing secret
 * makes the subscription moot, so it is reported first.
 */
export function assessCallbackReadiness(params: {
  appSecret: string | undefined;
  verifyToken: string | undefined;
  baseUrl: string | null;
}): ReadinessCheck[] {
  return [
    checkAppSecret(params.appSecret),
    checkVerifyToken(params.verifyToken),
    checkCallbackUrl(params.baseUrl),
  ];
}
