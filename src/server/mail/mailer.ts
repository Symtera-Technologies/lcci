import "server-only";

import { createTransport, type Transporter } from "nodemailer";
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
/* SMTP transport                                                             */
/* -------------------------------------------------------------------------- */

/**
 * SMTP over nodemailer.
 *
 * The transport LCCI actually has today: a mailbox on their own mail server,
 * with a host, a port and a password. It needs no account with a third party,
 * no API token to procure, and no decision about which provider to sign up
 * with — so it is what the contact form ships against, and the Postmark path
 * above stays for the day sign-in codes and twenty thousand renewal notices
 * make shared-IP reputation the binding problem.
 *
 * Everything in the module docstring about SMTP's costs is still true and is
 * not restated as a warning here, with one exception worth keeping in view:
 * **some shared cPanel plans block outbound connections to third-party SMTP
 * ports**, so a configuration that works from a developer's laptop can fail on
 * the host with a connection timeout and nothing else. If that happens, the
 * answer is the host's own `localhost:25`, not a longer timeout.
 *
 * The transport is built once and reused. nodemailer opens a fresh connection
 * per message unless pooling is on, which is deliberate: a pooled connection
 * is a socket held open inside a Passenger worker that may be killed between
 * requests, and the handshake it saves is worth less than not reasoning about
 * that. `SMTP_POOL=1` turns pooling on for a host where the handshake proves
 * expensive.
 */
class SmtpMailer implements Mailer {
  readonly name = "smtp";

  /** Built lazily so importing this module never opens a socket. */
  private transport: Transporter | null = null;

  constructor(
    private readonly options: SmtpOptions,
    private readonly fromAddress: string,
  ) {}

  private getTransport(): Transporter {
    this.transport ??= createTransport(smtpTransportOptions(this.options));
    return this.transport;
  }

  async send(message: OutboundMessage): Promise<SendResult> {
    const info = await this.getTransport().sendMail({
      from: this.fromAddress,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
      ...(message.replyTo ? { replyTo: message.replyTo } : {}),

      // The stream has no SMTP equivalent — it is a Postmark concept — so it
      // travels as a header instead of being dropped. A mail server that
      // filters or routes on it can; one that does not ignores it; and the
      // received message still says which stream it belonged to, which is the
      // first thing anyone debugging a delivery problem wants to know.
      headers: { "X-LCCI-Stream": message.stream },
    });

    // nodemailer synthesises a Message-ID when the server does not return one,
    // so this is populated either way and is what correlates a row in
    // `email_outbox` with a line in the server's mail log.
    return { providerId: info.messageId ?? null };
  }
}

export interface SmtpOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  rejectUnauthorized: boolean;
  pool: boolean;
}

/**
 * The nodemailer transport settings, as a pure function of the configuration.
 *
 * Extracted and exported so the decisions below can be asserted in a test. On
 * a live connection they are invisible — a session that silently fell back to
 * plaintext looks exactly like one that did not — and they are the settings
 * that decide whether a sign-in code crosses the network readable.
 */
export function smtpTransportOptions(options: SmtpOptions) {
  return {
    host: options.host,
    port: options.port,

    // Implicit TLS on 465, STARTTLS everywhere else. `requireTLS` makes the
    // upgrade mandatory rather than opportunistic: without it nodemailer will
    // happily continue in the clear when the server omits STARTTLS from its
    // greeting, which is precisely the downgrade an attacker on the path
    // would arrange, and these messages carry sign-in codes.
    secure: options.port === 465,
    requireTLS: options.port !== 465,

    ...(options.user
      ? { auth: { user: options.user, pass: options.password } }
      : {}),

    tls: {
      // Default true. cPanel mail servers frequently present a certificate
      // for the server's own hostname rather than for `mail.lcci.com.pk`, and
      // the temptation is to switch this off and move on — which silently
      // accepts any certificate, so the session is encrypted against a
      // passive observer and worthless against an active one. Left as an env
      // flag so turning it off is a recorded decision, and so the fix of
      // pointing SMTP_HOST at the name on the certificate stays the obvious
      // first move.
      rejectUnauthorized: options.rejectUnauthorized,
    },

    pool: options.pool,

    // Three separate timeouts, because the three ways SMTP hangs are
    // different: a host that never completes the TCP handshake, one that
    // accepts the connection and never greets, and one that greets and then
    // stops reading. Postmark's path gets the same ten seconds from a single
    // AbortSignal; SMTP needs all three to be equivalent.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  };
}

/**
 * Read the SMTP settings, or report why they are unusable.
 *
 * Returns the problems rather than throwing, because `getMailer()` is called
 * from the request path and a half-configured mail server must degrade to the
 * console transport with a loud log line — not take down every page that
 * happens to send something.
 */
function readSmtpOptions(): { options: SmtpOptions | null; problems: string[] } {
  const host = process.env.SMTP_HOST?.trim();
  if (!host) return { options: null, problems: [] };

  const problems: string[] = [];

  const port = Number.parseInt(process.env.SMTP_PORT?.trim() || "587", 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    problems.push("SMTP_PORT is not a port number.");
  }

  const user = process.env.SMTP_USER?.trim() ?? "";
  const password = process.env.SMTP_PASSWORD ?? "";

  // A username with no password is the shape a half-copied configuration
  // takes, and it fails at the server with a 535 that reads like a wrong
  // password rather than a missing one.
  if (user && !password) {
    problems.push("SMTP_USER is set but SMTP_PASSWORD is empty.");
  }

  if (problems.length > 0) return { options: null, problems };

  return {
    options: {
      host,
      port,
      user,
      password,
      rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED?.trim() !== "0",
      pool: process.env.SMTP_POOL?.trim() === "1",
    },
    problems: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Selection                                                                  */
/* -------------------------------------------------------------------------- */

let cached: Mailer | null = null;

/**
 * The configured mailer.
 *
 * SMTP first when `SMTP_HOST` is set, because that is the transport the
 * chamber has; Postmark when a token is present instead; the console when
 * neither is, which is the normal state of a development machine.
 *
 * Falls back rather than throwing, so a development machine and an off-box
 * build both work. In production the absence is logged once, loudly, because
 * silently not sending mail is the failure that takes longest to notice:
 * every flow appears to succeed.
 */
export function getMailer(): Mailer {
  if (cached) return cached;

  const token = process.env.POSTMARK_TOKEN?.trim();
  const from = process.env.MAIL_FROM?.trim();

  const smtp = readSmtpOptions();

  if (smtp.problems.length > 0) {
    logError(
      "SMTP is configured but unusable; falling back",
      new Error(smtp.problems.join(" ")),
    );
  }

  // `MAIL_FROM` is required for every transport. SMTP servers will often
  // accept a message with no From and rewrite it to the authenticated
  // mailbox, which works until the day it does not and nobody can say what
  // address members were seeing.
  if (smtp.options && from) {
    cached = new SmtpMailer(smtp.options, from);
    log.info("mail transport selected", { template: "smtp", channel: "email" });
    return cached;
  }

  if (smtp.options && !from) {
    logError(
      "SMTP_HOST is set but MAIL_FROM is not; no mail will be sent",
      new Error("MAIL_FROM is required by every mail transport"),
    );
  }

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
