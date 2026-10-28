import "server-only";

import { log, logError } from "@/server/log";
import { env } from "@/server/env";

/**
 * The mail adapter.
 *
 * Mirrors the seam convention `src/content/repository.ts` already establishes:
 * one interface, a swappable implementation, and no caller importing a
 * provider SDK directly.
 *
 * Why not cPanel's own mail, which is sitting right there: shared cPanel IPs
 * carry shared reputation, so a sign-in code that arrives in four minutes or
 * lands in spam is a *broken login* rather than a slow one — and that makes
 * mail delivery the highest-risk dependency in the whole authentication
 * design. cPanel also enforces a per-domain hourly cap, commonly 200 to 500,
 * which roughly twenty thousand renewal reminders would blow through, getting
 * the domain's mail suspended. And a cPanel queue gives no usable bounce or
 * complaint visibility.
 *
 * Why an HTTPS API rather than SMTP: no long-lived socket, no handshake
 * latency inside a Passenger worker, and — decisively — many shared cPanel
 * plans block outbound SMTP to third parties outright. An HTTPS POST sidesteps
 * that entire class of problem.
 *
 * `nodemailer` stays a dependency regardless. It is the cleanest way to
 * compose MIME for a receipt with an attachment, it is pure JavaScript with no
 * native build to break the off-box deploy, and it is the fallback transport
 * if the provider's API turns out to be unreachable from the host.
 */

export interface OutboundMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  replyTo?: string;
  /**
   * Transactional mail and bulk mail are kept on separate provider streams,
   * so a bad broadcast cannot damage the reputation that sign-in code delivery
   * depends on.
   */
  stream: "transactional" | "broadcast";
}

export interface SendResult {
  /** The provider's id, stored for bounce correlation. */
  providerId: string | null;
}

export interface Mailer {
  readonly name: string;
  send(message: OutboundMessage): Promise<SendResult>;
}

/* -------------------------------------------------------------------------- */
/* Console transport — development                                            */
/* -------------------------------------------------------------------------- */

/**
 * Writes the message to the log instead of sending it.
 *
 * Used when no provider is configured, which is the normal state of a
 * development machine. It deliberately logs the subject and recipient but
 * never the body: a sign-in code in a terminal is still a sign-in code in a
 * scrollback buffer, and in development the code is also returned by the
 * sign-in route for exactly this reason.
 */
class ConsoleMailer implements Mailer {
  readonly name = "console";

  async send(message: OutboundMessage): Promise<SendResult> {
    log.info("email not sent (no provider configured)", {
      template: message.subject.slice(0, 60),
      channel: message.stream,
    });
    return { providerId: null };
  }
}

/* -------------------------------------------------------------------------- */
/* Postmark transport                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Postmark over HTTPS.
 *
 * Chosen for the transactional stream because it is transactional-only, has
 * the best inbox rates for exactly the mail that must not be late — sign-in
 * codes, receipts, status changes — and exposes per-message delivery events.
 * SES is the cost-driven alternative once renewal volume is real.
 *
 * No SDK: one fetch against a documented endpoint, so there is no package to
 * keep current and nothing extra in the server bundle.
 */
class PostmarkMailer implements Mailer {
  readonly name = "postmark";

  constructor(
    private readonly token: string,
    private readonly fromAddress: string,
    private readonly streams: { transactional: string; broadcast: string },
  ) {}

  async send(message: OutboundMessage): Promise<SendResult> {
    // A hard timeout, because the sign-in path awaits this send: a provider
    // that hangs must become a visible error in ten seconds rather than a
    // Passenger request timeout with no explanation.
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "X-Postmark-Server-Token": this.token,
      },
      body: JSON.stringify({
        From: this.fromAddress,
        To: message.to,
        Subject: message.subject,
        TextBody: message.text,
        ...(message.html ? { HtmlBody: message.html } : {}),
        ...(message.replyTo ? { ReplyTo: message.replyTo } : {}),
        MessageStream: this.streams[message.stream],
      }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!response.ok) {
      // The provider's error body can echo the recipient address, so it is
      // read for the status code and nothing else is kept.
      throw new Error(`Postmark rejected the message (HTTP ${response.status})`);
    }

    const body = (await response.json()) as { MessageID?: string };
    return { providerId: body.MessageID ?? null };
  }
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

let cached: Mailer | null = null;

/**
 * The configured mailer.
 *
 * Falls back to the console transport rather than throwing when no provider is
 * set, so a development machine and an off-box build both work. In production
 * the absence is logged once, loudly, because silently not sending mail is the
 * failure that takes longest to notice: every flow appears to succeed.
 */
export function getMailer(): Mailer {
  if (cached) return cached;

  const token = process.env.POSTMARK_TOKEN?.trim();
  const from = process.env.MAIL_FROM?.trim();

  if (token && from) {
    cached = new PostmarkMailer(token, from, {
      transactional: process.env.POSTMARK_STREAM_TRANSACTIONAL?.trim() || "outbound",
      broadcast: process.env.POSTMARK_STREAM_BROADCAST?.trim() || "broadcast",
    });
    return cached;
  }

  if (env.isProduction) {
    logError(
      "no mail provider configured in production; no email will be delivered",
      new Error("POSTMARK_TOKEN and MAIL_FROM are not set"),
    );
  }

  cached = new ConsoleMailer();
  return cached;
}

/** For tests. */
export function setMailer(mailer: Mailer | null): void {
  cached = mailer;
}

/**
 * Deliverability notes, recorded here because they are a precondition for the
 * first send rather than an optimisation afterwards.
 *
 * - **SPF**: one record, `-all` once every sender is known. Mind the
 *   ten-lookup limit; do not accumulate includes.
 * - **DKIM**: the provider's keys on a selector subdomain, *plus* cPanel's own
 *   DKIM for mail that genuinely originates there. Two selectors coexist fine.
 * - **DMARC**: start at `p=none` with `rua=`, read aggregate reports for two
 *   to four weeks, then `p=quarantine`, then `p=reject`. Going straight to
 *   `reject` on a domain whose existing flows nobody has fully inventoried
 *   will silently break something.
 *
 * And the one that is an authentication problem rather than a cosmetic one:
 * staff use `@lcci.org.pk` while the site is `lcci.com.pk`. Sign-in codes must
 * come from the domain the member sees in the address bar. Sending them from a
 * different domain actively teaches members that LCCI login mail arrives from
 * varied domains, which is the precondition phishing needs. This is plan open
 * question 15 and it blocks the login flow, not the launch.
 */
export const DELIVERABILITY_PRECONDITIONS = [
  "SPF published for the sending domain",
  "DKIM published on a provider selector",
  "DMARC published at p=none with an aggregate report address",
  "The sending domain matches the canonical site domain",
] as const;
