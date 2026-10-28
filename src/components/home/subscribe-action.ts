"use server";

export interface SubscribeState {
  status: "idle" | "ok" | "error";
  message?: string;
}

/**
 * Newsletter / circular-alert sign-up.
 *
 * Validation and feedback are real. The hand-off to the mailing provider is
 * deliberately not faked — spec §9 leaves the transactional email and newsletter
 * tool as [TBC], so this records the intent and returns honestly until that
 * decision is made. Rate limiting and CAPTCHA attach here too (spec §9).
 */
export async function subscribe(
  _prev: SubscribeState,
  formData: FormData,
): Promise<SubscribeState> {
  const email = String(formData.get("email") ?? "").trim();

  if (!email) {
    return { status: "error", message: "Please enter your email address." };
  }

  // Intentionally permissive: the provider is the real validator.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    return { status: "error", message: "That does not look like an email address." };
  }

  // TODO(integration): post to the chosen newsletter provider once selected.
  // Until then nothing is stored, so no address is collected under a promise
  // the chamber cannot yet keep.
  return {
    status: "error",
    message:
      "Sign-up is not connected yet. Email media@lcci.org.pk and the Information Department will add you.",
  };
}
