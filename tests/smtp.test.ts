import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import {
  getMailer,
  setMailer,
  smtpTransportOptions,
  type SmtpOptions,
} from "@/server/mail/mailer";

/**
 * The SMTP transport: how it is chosen, and how it refuses to be downgraded.
 *
 * Two things here cannot be checked by looking at a delivered message, which
 * is why they are tested rather than eyeballed. **Whether the session was
 * encrypted** — a message that crossed the network in the clear arrives
 * looking exactly like one that did not, and these carry sign-in codes. And
 * **which transport was selected** — a misconfiguration that quietly falls
 * back to the console mailer makes every flow in the application appear to
 * succeed while no mail is sent at all, which is the failure that takes
 * longest to notice.
 *
 * There is no happy-path delivery test against a live server, deliberately.
 * Standing up one would mean either generating a certificate at test time, or
 * turning off the very TLS requirement the first group exists to protect. The
 * composition of the message is covered in `tests/contact.test.ts` and
 * `tests/mail.test.ts`, where it can be asserted exactly; what is left for
 * here is the connection.
 */

/** The one server a test starts, closed again in `afterEach`. */
let server: Server | null = null;

const BASE: SmtpOptions = {
  host: "mail.example.pk",
  port: 587,
  user: "notices@example.pk",
  password: "s3cret",
  rejectUnauthorized: true,
  pool: false,
};

describe("the SMTP transport's settings", () => {
  it("requires STARTTLS on a submission port", () => {
    const options = smtpTransportOptions({ ...BASE, port: 587 });
    expect(options.secure).toBe(false);
    expect(options.requireTLS).toBe(true);
  });

  it("uses implicit TLS on 465, where STARTTLS does not apply", () => {
    const options = smtpTransportOptions({ ...BASE, port: 465 });
    expect(options.secure).toBe(true);
    expect(options.requireTLS).toBe(false);
  });

  it("requires TLS on the host's own relay too", () => {
    // Port 25 to localhost is the shared-cPanel fallback, and it is the one
    // somebody will reach for when outbound 587 turns out to be blocked. It
    // gets the same requirement: "it is only going to localhost" is an
    // argument about the first hop, and the message does not stop there.
    expect(smtpTransportOptions({ ...BASE, port: 25 }).requireTLS).toBe(true);
  });

  it("verifies the server's certificate unless told otherwise", () => {
    expect(smtpTransportOptions(BASE).tls.rejectUnauthorized).toBe(true);
    expect(
      smtpTransportOptions({ ...BASE, rejectUnauthorized: false }).tls.rejectUnauthorized,
    ).toBe(false);
  });

  it("sends no credentials when none are configured", () => {
    // An unauthenticated relay is a real configuration — the host's own
    // localhost:25 — and an `auth` block with an empty user makes nodemailer
    // attempt AUTH, which such a server answers with a 5xx.
    const options = smtpTransportOptions({ ...BASE, user: "", password: "" });
    expect("auth" in options).toBe(false);
  });

  it("bounds every way an SMTP conversation can hang", () => {
    const options = smtpTransportOptions(BASE);
    expect(options.connectionTimeout).toBeLessThanOrEqual(10_000);
    expect(options.greetingTimeout).toBeLessThanOrEqual(10_000);
    expect(options.socketTimeout).toBeLessThanOrEqual(30_000);
  });
});

describe("the SMTP transport on the wire", () => {
  afterEach(async () => {
    setMailer(null);
    if (server) {
      await new Promise<void>((resolve) => server?.close(() => resolve()));
      server = null;
    }
  });

  it("refuses to send to a server that will not offer STARTTLS", async () => {
    // The downgrade that matters. A server — or something sitting in front of
    // one — that simply omits STARTTLS from its EHLO response gets plaintext
    // out of an opportunistic client, and nothing anywhere reports it. This
    // asserts the send fails instead.
    const port = await listen((line, reply) => {
      if (line.startsWith("EHLO") || line.startsWith("HELO")) {
        // A greeting with no STARTTLS in it.
        reply("250-mail.test\r\n250 SIZE 10240000\r\n");
      } else if (line.startsWith("STARTTLS")) {
        // What a server with no TLS says when asked anyway. Worth stubbing
        // precisely: answering `250 OK` here instead leaves the client waiting
        // out its socket timeout for a handshake that never comes, which is
        // the same verdict ten seconds later and a much worse test.
        reply("502 Command not implemented\r\n");
      } else if (line.startsWith("QUIT")) {
        reply("221 Bye\r\n");
      } else {
        reply("250 OK\r\n");
      }
    });

    process.env.SMTP_HOST = "127.0.0.1";
    process.env.SMTP_PORT = String(port);
    process.env.SMTP_USER = "";
    process.env.SMTP_PASSWORD = "";
    process.env.MAIL_FROM = "notices@example.pk";
    setMailer(null);

    const mailer = getMailer();
    expect(mailer.name).toBe("smtp");

    await expect(
      mailer.send({
        to: "someone@example.pk",
        subject: "Your sign-in code",
        text: "123456",
        stream: "transactional",
      }),
    ).rejects.toThrow(/tls|starttls/i);
  });
});

describe("choosing a transport", () => {
  const saved = { ...process.env };

  afterEach(() => {
    for (const key of [
      "SMTP_HOST",
      "SMTP_PORT",
      "SMTP_USER",
      "SMTP_PASSWORD",
      "POSTMARK_TOKEN",
      "MAIL_FROM",
    ]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    setMailer(null);
  });

  function select(env: Record<string, string | undefined>): string {
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    setMailer(null);
    return getMailer().name;
  }

  it("prefers SMTP, which is the transport the chamber has", () => {
    expect(
      select({
        SMTP_HOST: "mail.example.pk",
        MAIL_FROM: "notices@example.pk",
        POSTMARK_TOKEN: "a-token",
      }),
    ).toBe("smtp");
  });

  it("falls back to Postmark when only a token is configured", () => {
    expect(
      select({
        SMTP_HOST: undefined,
        MAIL_FROM: "notices@example.pk",
        POSTMARK_TOKEN: "a-token",
      }),
    ).toBe("postmark");
  });

  it("logs instead of sending when nothing is configured", () => {
    expect(
      select({ SMTP_HOST: undefined, POSTMARK_TOKEN: undefined, MAIL_FROM: undefined }),
    ).toBe("console");
  });

  it("does not send from an unstated address", () => {
    // Without MAIL_FROM an SMTP server will commonly rewrite the sender to
    // whichever mailbox authenticated, which works right up until the day it
    // does not and nobody can say what address members were seeing.
    expect(
      select({ SMTP_HOST: "mail.example.pk", MAIL_FROM: undefined, POSTMARK_TOKEN: undefined }),
    ).toBe("console");
  });

  it("refuses a username with no password rather than failing at the server", () => {
    // The shape a half-copied configuration takes. Left to the server it
    // comes back as a 535, which reads like a wrong password rather than a
    // missing one, and the hour spent resetting it is wasted.
    expect(
      select({
        SMTP_HOST: "mail.example.pk",
        SMTP_USER: "notices@example.pk",
        SMTP_PASSWORD: "",
        MAIL_FROM: "notices@example.pk",
        POSTMARK_TOKEN: undefined,
      }),
    ).toBe("console");
  });

  it("refuses a port that is not one", () => {
    expect(
      select({
        SMTP_HOST: "mail.example.pk",
        SMTP_PORT: "not-a-port",
        SMTP_USER: undefined,
        SMTP_PASSWORD: undefined,
        MAIL_FROM: "notices@example.pk",
        POSTMARK_TOKEN: undefined,
      }),
    ).toBe("console");
  });
});

/**
 * The smallest thing that answers SMTP.
 *
 * Line-based and stateless beyond the handler, which is all these tests need:
 * none of them gets as far as DATA. Listening on port 0 so the suite can run
 * anywhere and in parallel with itself.
 */
function listen(
  handle: (line: string, reply: (text: string) => void) => void,
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((socket) => {
      const reply = (text: string) => socket.write(text);
      reply("220 mail.test ESMTP\r\n");

      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let newline = buffer.indexOf("\r\n");
        while (newline !== -1) {
          handle(buffer.slice(0, newline), reply);
          buffer = buffer.slice(newline + 2);
          newline = buffer.indexOf("\r\n");
        }
      });

      socket.on("error", () => {
        // A client that gives up mid-conversation is the expected outcome of
        // the downgrade test, not a failure of the server.
      });
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server?.address();
      resolve(typeof address === "object" && address ? address.port : 0);
    });
  });
}
