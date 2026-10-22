import { ApiError } from "./http.ts";

/* The handoff scan rules live in the database, because the buyer, the
   seller and the agent all have to be refused in exactly the same way.
   These helpers are the one place that turns a database refusal into a
   status the app can act on and a reason it can branch on, so the three
   entry points cannot drift apart. */

const encoder = new TextEncoder();

export async function hashHandoffToken(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(token));
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
}

/* A handoff code is a single-use secret the server issued. Anything that
   does not look like one is refused before it reaches the database. */
export function looksLikeHandoffCode(code: string): boolean {
  return code.startsWith("KMH1.") && code.length >= 40;
}

/* Map a database refusal onto the status and reason the apps act on.
   The wording travels with the reason, so the page can tell the
   difference between "already scanned", "wrong person" and "the handover
   is done" without parsing English. */
export function scanFailure(error: unknown): ApiError {
  const message = (error as { message?: string })?.message || "That scan could not be accepted";
  if (/already scanned/i.test(message)) return new ApiError(409, message, "already_scanned");
  if (/already done/i.test(message)) return new ApiError(409, message, "already_done");
  if (/replaced by a newer one/i.test(message)) return new ApiError(409, message, "replaced");
  if (/no longer valid|expired/i.test(message)) return new ApiError(409, message, "expired");
  if (/order is closed|no handover left/i.test(message)) return new ApiError(409, message, "order_closed");
  if (/no longer held in escrow/i.test(message)) return new ApiError(409, message, "not_in_escrow");
  if (/only the buyer|only the seller|not allowed to scan/i.test(message)) {
    return new ApiError(403, message, "wrong_person");
  }
  if (/does not belong to any order|no longer exists/i.test(message)) {
    return new ApiError(404, message, "not_valid");
  }
  return new ApiError(400, message);
}

export interface HandoffOrder {
  ref: string;
  buyer_id: string;
  seller_id: string;
  buyer_name?: string | null;
  seller_name?: string | null;
}

export interface HandoffNotice {
  title: string;
  body: string;
  recipients: { id: string; link: string }[];
}

/* Who hears about a scan, and what they are told.

   The scanned code belongs to one side of the order, and that side is the
   one whose side of the handover just became true: the buyer when the
   seller's code was scanned, the seller when the buyer's code was
   scanned. The database writes the durable inbox entry to the same
   person, so the push and the inbox agree.

   An agent acts for the platform, so the seller who handed the parcel
   over is told as well. */
export function handoffNotice(
  order: HandoffOrder,
  role: string,
  codeType: string
): HandoffNotice {
  const ref = order.ref;
  const scanner =
    role === "agent" ? "A Kobe Mweusi agent"
      : role === "staff" ? "Kobe Mweusi staff"
        : role === "buyer" ? "The buyer"
          : "The seller";

  const owner = codeType === "buyer" ? order.buyer_id : order.seller_id;
  const ownerIsBuyer = codeType === "buyer";

  const recipients: { id: string; link: string }[] = [
    {
      id: owner,
      link: ownerIsBuyer ? `/buyer.html#order/${ref}` : "/seller.html#seller-orders",
    },
  ];

  /* The other side of the order hears about it only when a third party
     acted, because in a direct handover the counterparty is the one
     holding the phone and already knows. */
  if (role === "agent" || role === "staff") {
    const other = ownerIsBuyer ? order.seller_id : order.buyer_id;
    if (other && other !== owner) {
      recipients.push({
        id: other,
        link: ownerIsBuyer ? "/seller.html#seller-orders" : `/buyer.html#order/${ref}`,
      });
    }
  }

  return {
    title: "Handoff confirmed for order " + ref,
    body: scanner + " confirmed the handover for order " + ref + ".",
    recipients,
  };
}
