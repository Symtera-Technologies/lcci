import { describe, expect, it } from "vitest";
import { renderTemplate } from "@/server/mail/templates";
import {
  CONTACT_TOPICS,
  CONTACT_TOPIC_CODES,
  contactTopicLabel,
} from "@/content/contact-topics";
import { newEnquiryReference } from "@/server/enquiries";

/**
 * The contact form's two risky edges, tested where they live.
 *
 * The form itself is ordinary — a schema, a wrapper that every other action
 * already goes through, and markup. What is not ordinary is that this is the
 * **first path in the application where a stranger's text reaches a mail
 * header**, and that the reference it mints is the only identifier anybody
 * has for a message. Those get tests; the rest is covered by the route and
 * action machinery that was already here.
 */

const ENQUIRY = {
  reference: "LC-7K2MQB",
  name: "Ayesha Rahim",
  email: "ayesha@shalimartextiles.com.pk",
  phone: null,
  organisation: null,
  topic: "Certificates and attestation",
  message: "How long does a certificate of origin take?",
  receivedAt: "3 November 2026 at 4:12 pm",
};

describe("the contact enquiry template", () => {
  it("sets Reply-To to the sender, which is the whole point", () => {
    // Without this a member of staff presses reply and reaches the no-reply
    // mailbox the site sends from, and the enquiry dies there.
    const message = renderTemplate("contact-enquiry", ENQUIRY);
    expect(message.replyTo).toBe("ayesha@shalimartextiles.com.pk");
  });

  it("refuses an address carrying a second header", () => {
    // The address came out of a public form. A newline in it is an attempt to
    // append `Bcc:` to the message, and the renderer has to be where that
    // stops — not the mail server, and certainly not the recipient.
    expect(() =>
      renderTemplate("contact-enquiry", {
        ...ENQUIRY,
        email: "someone@example.com\r\nBcc: everyone@example.com",
      }),
    ).toThrow(/Reply-To/);
  });

  it("refuses an address with a display name wrapped around it", () => {
    // `"X" <a@b.c>` is legal in a mail header and is not what the form asked
    // for, so it is either a bug or someone probing the parser.
    expect(() =>
      renderTemplate("contact-enquiry", {
        ...ENQUIRY,
        email: '"Ayesha" <ayesha@example.com>',
      }),
    ).toThrow(/Reply-To/);
  });

  it("keeps the sender's words out of the subject line", () => {
    // Only the chamber's own topic label and the reference. A subject is a
    // header; a body is not, and the name is useful enough to be worth having
    // in the body and not worth the question in the header.
    const message = renderTemplate("contact-enquiry", {
      ...ENQUIRY,
      name: "Subject: injected",
      message: "Subject: also injected",
    });

    expect(message.subject).not.toContain("injected");
    expect(message.subject).toContain("Certificates and attestation");
    expect(message.subject).toContain("LC-7K2MQB");
  });

  it("carries the whole message, so the inbox is enough to act on", () => {
    // A notification that requires opening an admin panel to find out what
    // somebody asked is a notification that gets filed and forgotten.
    const message = renderTemplate("contact-enquiry", ENQUIRY);
    expect(message.text).toContain("How long does a certificate of origin take?");
    expect(message.text).toContain("ayesha@shalimartextiles.com.pk");
  });

  it("tells the reader the address was never verified", () => {
    // It is what somebody typed into a public form, and staff about to act on
    // a request should know that before they do.
    expect(renderTemplate("contact-enquiry", ENQUIRY).text).toMatch(/not verified/i);
  });
});

describe("the sender's acknowledgement", () => {
  const ACK = {
    reference: "LC-7K2MQB",
    name: "Ayesha Rahim",
    topic: "Certificates and attestation",
    message: "How long does a certificate of origin take?",
    telephone: "111-222-499",
  };

  it("quotes back what they sent", () => {
    // The only record they have that the chamber received anything. A bare
    // "thank you, we will be in touch" is indistinguishable from the
    // acknowledgement every website sends and nobody believes.
    expect(renderTemplate("contact-acknowledgement", ACK).text).toContain(
      "How long does a certificate of origin take?",
    );
  });

  it("carries the reference in the subject and the body", () => {
    const message = renderTemplate("contact-acknowledgement", ACK);
    expect(message.subject).toContain("LC-7K2MQB");
    expect(message.text).toContain("LC-7K2MQB");
  });

  it("offers the switchboard instead of promising a time", () => {
    // No service standard exists for this inbox, and inventing one would be
    // the chamber committing to something nobody agreed to.
    const text = renderTemplate("contact-acknowledgement", ACK).text;
    expect(text).toContain("111-222-499");
    expect(text).not.toMatch(/within \d+ (working )?(hours|days)/i);
  });

  it("sets no Reply-To, because it comes from a no-reply mailbox", () => {
    expect(renderTemplate("contact-acknowledgement", ACK).replyTo).toBeUndefined();
  });
});

describe("enquiry references", () => {
  it("is shaped so it can be read down a telephone", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(newEnquiryReference()).toMatch(/^LC-[0-9BCDFGHJKLMNPQRTVWXY]{6}$/);
    }
  });

  it("leaves out the characters that are confused when spoken or typed", () => {
    // No I, O, S or Z — and no vowels, so the generator cannot produce a
    // reference that reads as a word.
    const sample = Array.from({ length: 500 }, () => newEnquiryReference()).join("");
    expect(sample.slice(0)).not.toMatch(/[IOSZAEU]/);
  });

  it("does not repeat itself over a realistic volume", () => {
    // Not a uniformity test — it is a smoke alarm for the generator being
    // wired to a constant, which is the way this fails in practice.
    const seen = new Set(Array.from({ length: 2000 }, () => newEnquiryReference()));
    expect(seen.size).toBeGreaterThan(1990);
  });
});

describe("the topic list", () => {
  it("offers a code the action will accept for every option shown", () => {
    // The select and the zod enum read the same constant, and this is the
    // assertion that keeps it that way if someone splits them.
    for (const topic of CONTACT_TOPICS) {
      expect(CONTACT_TOPIC_CODES).toContain(topic.code);
    }
  });

  it("names the codes so they fit the column and reach a subject safely", () => {
    for (const topic of CONTACT_TOPICS) {
      expect(topic.code, topic.code).toMatch(/^[a-z_]{1,40}$/);
      expect(topic.label, topic.code).not.toMatch(/[\r\n]/);
    }
  });

  it("sends the journeys that have a real handler to that handler", () => {
    // The point of asking the topic before the message box: somebody applying
    // for membership finds out before they type an application into a form
    // that cannot accept one.
    const membership = CONTACT_TOPICS.find((topic) => topic.code === "membership");
    expect(membership?.redirect?.href).toContain("membership.lcci.org.pk");

    const trade = CONTACT_TOPICS.find((topic) => topic.code === "trade");
    expect(trade?.redirect?.href).toBe("/trade/inquiries");
  });

  it("still labels a message sent under a topic that has been retired", () => {
    // Old rows outlive the form that wrote them, and the admin screen has to
    // render them rather than showing a blank where the topic was.
    expect(contactTopicLabel("membership")).toBe("Membership");
    expect(contactTopicLabel("a_topic_we_dropped")).toBe("a_topic_we_dropped");
  });
});
