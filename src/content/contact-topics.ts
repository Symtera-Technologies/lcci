/**
 * What the contact form lets someone say they are writing about.
 *
 * A closed list, not free text, for three reasons that each matter on their
 * own. The label reaches a mail subject line, so it must be a value the
 * chamber chose rather than one a stranger typed. Staff triaging a shared
 * inbox want the first word of the subject to tell them whose desk it is.
 * And the list is the only place the form can usefully say "that is not done
 * here" — which is what the `redirect` field is for.
 *
 * The topics are the site's own sections. Nothing here invents a department
 * or an address: every enquiry goes to one published mailbox, and the topic
 * is a label on it, not a routing rule. When LCCI gives us real departmental
 * inboxes, routing becomes a destination field on these same entries.
 *
 * No `server-only` guard and no imports with one, because the form renders
 * this in the browser and the action validates against it on the server. One
 * list, two readers, no second copy to drift.
 */

export interface ContactTopic {
  /** Stored in `contact_messages.topic`, and what the form submits. */
  readonly code: string;
  /** Shown in the select, and carried into the subject line. */
  readonly label: string;
  /**
   * Shown under the select when this topic is chosen, for the journeys that
   * have a real handler somewhere else.
   *
   * The point is to stop someone typing a membership application into a
   * message box and then waiting. An honest form says where the thing they
   * want actually happens, even when that is off this website.
   */
  readonly redirect?: {
    readonly text: string;
    readonly href: string;
    readonly linkLabel: string;
  };
}

export const CONTACT_TOPICS: readonly ContactTopic[] = [
  {
    code: "membership",
    label: "Membership",
    redirect: {
      text: "Applying for membership or renewing is done on the chamber's membership portal, not here.",
      href: "https://membership.lcci.org.pk/register",
      linkLabel: "Go to the membership portal",
    },
  },
  {
    code: "certificates",
    label: "Certificates and attestation",
  },
  {
    code: "trade",
    label: "Trade enquiry",
    redirect: {
      text: "Buying from or selling to members, and delegation requests, have their own page with the details the chamber needs.",
      href: "/trade/inquiries",
      linkLabel: "Trade inquiries",
    },
  },
  {
    code: "events",
    label: "Events, exhibitions and training",
  },
  {
    code: "advocacy",
    label: "Policy and advocacy",
  },
  {
    code: "media",
    label: "Media and press",
  },
  {
    code: "other",
    label: "Something else",
  },
];

export const CONTACT_TOPIC_CODES: readonly string[] = CONTACT_TOPICS.map(
  (topic) => topic.code,
);

/**
 * The label for a stored code.
 *
 * Returns the code itself for a topic that has since been removed from the
 * list, rather than throwing or showing nothing. Old rows outlive the form
 * that wrote them, and the admin screen must still render a message sent
 * under a label the chamber has stopped offering.
 */
export function contactTopicLabel(code: string): string {
  return CONTACT_TOPICS.find((topic) => topic.code === code)?.label ?? code;
}
