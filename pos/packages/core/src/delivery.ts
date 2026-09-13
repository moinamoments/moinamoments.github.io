/**
 * Digitaler Bonversand.
 *
 * Die Belegausgabepflicht (§ 146a Abs. 2 AO) verlangt, dass dem Kunden ein
 * Beleg **angeboten** wird - nicht, dass er gedruckt wird. Ein elektronischer
 * Beleg genuegt, wenn der Kunde ihn erhalten kann. Damit ist der Versand per
 * E-Mail oder SMS kein Zusatz, sondern ein vollwertiger Weg, die Pflicht zu
 * erfuellen - und der einzige, der ohne Papier und ohne Drucker funktioniert.
 *
 * ## Zwei Wege, und warum beide
 *
 *   1. **Ueber das Geraet** (`mailto:` und `sms:`): die App oeffnet das
 *      Mailprogramm oder die SMS-App mit fertigem Text. Braucht keinen Server,
 *      keine Zugangsdaten, keine laufenden Kosten - und der Versand geht vom
 *      Konto des Betriebs aus, nicht von einem fremden Dienst. Nachteil: der
 *      Bediener muss einmal auf "Senden" tippen, und es braucht ein
 *      eingerichtetes Mailkonto auf dem Geraet.
 *   2. **Ueber einen Dienst** (`DeliveryProvider`): ein Server verschickt
 *      selbstaendig. Das ist der Weg fuer den Dauerbetrieb, kostet aber Geld
 *      und verlangt einen Auftragsverarbeitungsvertrag nach Art. 28 DSGVO.
 *
 * ## Datenschutz
 *
 * Eine E-Mail-Adresse oder Telefonnummer eines Kunden ist ein personenbezogenes
 * Datum. Sie wird **nur** zum Versand dieses einen Belegs verwendet und nicht
 * zu einem Kundenstamm verdichtet - dafuer waere eine eigene Rechtsgrundlage
 * und eine Einwilligung noetig. Deshalb steht die Adresse am Beleg und nicht in
 * einer Kundentabelle, und `anonymizeContact` macht aus ihr das, was fuer die
 * Aufbewahrung genuegt.
 */

import { formatEuro } from "./money.ts";
import type { Order, Tenant } from "./model.ts";
import { type ReceiptView, renderReceiptText } from "./receipt.ts";
import { checkEmail, checkPhone } from "./validation.ts";

export class DeliveryError extends Error {}

export type DeliveryChannel = "EMAIL" | "SMS";

export const DELIVERY_LABELS: Record<DeliveryChannel, string> = {
  EMAIL: "E-Mail",
  SMS: "SMS",
};

/** Kontaktangabe des Kunden, ausschliesslich fuer diesen Beleg. */
export interface CustomerContact {
  readonly name?: string | null;
  readonly email?: string | null;
  readonly phone?: string | null;
}

/**
 * Adresse des Kunden fuer eine Rechnung.
 *
 * Gebraucht ab 250 EUR: darunter genuegt die Kleinbetragsrechnung nach
 * § 33 UStDV, darueber verlangt § 14 Abs. 4 UStG Name und Adresse des
 * Leistungsempfaengers. Ein Kunde, der eine Rechnung ueber 300 EUR ohne seine
 * Adresse bekommt, kann keine Vorsteuer ziehen - und kommt zurueck.
 */
export interface CustomerAddress {
  readonly name: string;
  readonly street?: string | null;
  readonly postalCode?: string | null;
  readonly city?: string | null;
  readonly vatId?: string | null;
}

/** Grenze der Kleinbetragsrechnung nach § 33 UStDV, in Cent. */
export const SMALL_INVOICE_LIMIT = 25_000;

/**
 * Braucht dieser Beleg die Adresse des Kunden?
 *
 * Nur wenn er als Rechnung dienen soll und ueber der Grenze liegt. Fuer den
 * normalen Kassenbon ist die Antwort nein - und danach zu fragen waere
 * ueberfluessige Datenerhebung.
 */
export function needsCustomerAddress(total: number, asInvoice: boolean): boolean {
  return asInvoice && Math.abs(total) > SMALL_INVOICE_LIMIT;
}

/** Fehlende Pflichtangaben einer Rechnung benennen. */
export function checkInvoiceRequirements(
  order: Pick<Order, "total">,
  address: CustomerAddress | null,
): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  if (!needsCustomerAddress(order.total, true)) return { ok: true, problems };

  if (!address) {
    problems.push(
      `Ab ${formatEuro(SMALL_INVOICE_LIMIT)} verlangt eine Rechnung Name und Adresse des Kunden (§ 14 Abs. 4 UStG).`,
    );
    return { ok: false, problems };
  }
  if (address.name.trim() === "") problems.push("Der Name des Kunden fehlt.");
  if ((address.street ?? "").trim() === "") problems.push("Strasse und Hausnummer des Kunden fehlen.");
  if ((address.postalCode ?? "").trim() === "" || (address.city ?? "").trim() === "") {
    problems.push("Postleitzahl und Ort des Kunden fehlen.");
  }
  return { ok: problems.length === 0, problems };
}

// --- Nachricht aufbauen ---------------------------------------------------

export interface DeliveryMessage {
  readonly channel: DeliveryChannel;
  /** Empfaenger, geprueft und normalisiert. */
  readonly to: string;
  readonly subject: string;
  readonly body: string;
  /**
   * Adresse zum Oeffnen der Mail- oder SMS-App. Alles darin ist kodiert, damit
   * Umlaute, Umbrueche und Sonderzeichen den Aufruf nicht zerlegen.
   */
  readonly url: string;
}

/**
 * Betreff eines Belegs.
 *
 * Enthaelt Betrieb, Belegnummer und Betrag - damit der Kunde die Mail in einem
 * Jahr noch findet, ohne sie zu oeffnen.
 */
export function receiptSubject(tenant: Pick<Tenant, "name">, view: ReceiptView): string {
  return `Beleg ${view.receiptNumber} · ${tenant.name} · ${view.total} EUR`;
}

/**
 * Text der E-Mail.
 *
 * Der Bon steht als Text darin, nicht als Anhang: ein Anhang braucht einen
 * Server, der ihn erzeugt und mitsendet, und `mailto:` kann keinen anhaengen.
 * Als Text ist der Beleg lesbar, durchsuchbar und ausdruckbar - und enthaelt
 * alle Pflichtangaben.
 */
export function receiptEmailBody(tenant: Tenant, view: ReceiptView, contact: CustomerContact): string {
  const greeting = contact.name ? `Hallo ${contact.name},` : "Guten Tag,";
  const lines = [
    greeting,
    "",
    `vielen Dank fuer Ihren Einkauf bei ${tenant.name}. Ihr Beleg:`,
    "",
    renderReceiptText(view, 42),
    "",
  ];
  if (view.qrPayload) {
    lines.push(
      "Zur Pruefung des Belegs durch die Finanzverwaltung:",
      view.qrPayload,
      "",
    );
  }
  lines.push(`${tenant.name}${tenant.email ? ` · ${tenant.email}` : ""}`);
  return lines.join("\n");
}

/**
 * Text der SMS.
 *
 * Kurz: eine SMS fasst 160 Zeichen, danach wird sie geteilt und kostet
 * mehrfach. Der vollstaendige Bon passt nicht hinein, also enthaelt die SMS die
 * Pflichtangaben in Kurzform - Betrieb, Belegnummer, Betrag, Zeitpunkt - und
 * den Hinweis, dass der vollstaendige Beleg auf Wunsch nachgereicht wird. Wer
 * den vollen Beleg will, bekommt ihn per E-Mail.
 */
export function receiptSmsBody(tenant: Pick<Tenant, "name">, view: ReceiptView): string {
  return `${tenant.name}: Beleg ${view.receiptNumber} vom ${view.issuedAt} ueber ${view.total} EUR. Vielen Dank!`;
}

/** RFC-3986-Kodierung fuer den Aufruf der Mail- oder SMS-App. */
function encode(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Beleg per E-Mail vorbereiten.
 *
 * Prueft die Adresse, bevor irgendetwas geoeffnet wird: eine Mail-App, die sich
 * mit einer unbrauchbaren Adresse oeffnet, hinterlaesst einen Bediener, der
 * nicht weiss, was schiefging.
 */
export function prepareEmail(
  tenant: Tenant,
  view: ReceiptView,
  contact: CustomerContact,
): DeliveryMessage {
  const checked = checkEmail(contact.email ?? "", { required: true });
  if (!checked.ok) throw new DeliveryError(checked.reason);
  const to = checked.value as string;

  const subject = receiptSubject(tenant, view);
  const body = receiptEmailBody(tenant, view, contact);
  return {
    channel: "EMAIL",
    to,
    subject,
    body,
    url: `mailto:${encode(to)}?subject=${encode(subject)}&body=${encode(body)}`,
  };
}

/** Beleg per SMS vorbereiten. */
export function prepareSms(
  tenant: Pick<Tenant, "name">,
  view: ReceiptView,
  contact: CustomerContact,
): DeliveryMessage {
  const checked = checkPhone(contact.phone ?? "", { required: true });
  if (!checked.ok) throw new DeliveryError(checked.reason);
  const to = checked.value as string;

  const body = receiptSmsBody(tenant, view);
  return {
    channel: "SMS",
    to,
    subject: "",
    body,
    // Das Trennzeichen vor dem Text ist plattformabhaengig: Android erwartet
    // "?", iOS "&". Ein "?" wird von beiden verstanden, wenn kein weiterer
    // Parameter folgt - und es folgt keiner.
    url: `sms:${encode(to)}?body=${encode(body)}`,
  };
}

/** Nachricht zum Kanal aufbauen. */
export function prepareDelivery(
  channel: DeliveryChannel,
  tenant: Tenant,
  view: ReceiptView,
  contact: CustomerContact,
): DeliveryMessage {
  return channel === "EMAIL" ? prepareEmail(tenant, view, contact) : prepareSms(tenant, view, contact);
}

// --- Versand ueber einen Dienst ------------------------------------------

/**
 * Serverseitiger Versand.
 *
 * Noch nicht angebunden - es gibt keinen Server. Die Schnittstelle steht hier,
 * damit der Weg ueber das Geraet und der Weg ueber einen Dienst dieselbe
 * Nachricht verwenden und die Oberflaeche sich nicht aendern muss.
 */
export interface DeliveryProvider {
  readonly name: string;
  readonly channels: readonly DeliveryChannel[];
  send(message: DeliveryMessage): Promise<{ readonly ok: boolean; readonly error?: string }>;
}

/** Protokoll eines Versands, fuer den Nachweis am Beleg. */
export interface DeliveryRecord {
  readonly orderId: string;
  readonly channel: DeliveryChannel;
  /** Empfaenger in verkuerzter Form - siehe `anonymizeContact`. */
  readonly recipient: string;
  readonly sentAt: string;
  readonly via: "device" | "provider";
  readonly ok: boolean;
  readonly error?: string | null;
}

/**
 * Empfaenger fuer die Aufbewahrung verkuerzen.
 *
 * Nachweisbar bleiben muss, **dass** ein Beleg herausgegeben wurde - nicht, an
 * welche vollstaendige Adresse. Deshalb wird gekuerzt: genug, um einen
 * Nachfragenden wiederzuerkennen, zu wenig, um einen Kundenstamm daraus zu
 * bauen. Datenminimierung nach Art. 5 Abs. 1 Buchst. c DSGVO ist keine
 * Freundlichkeit, sondern Pflicht.
 */
export function anonymizeContact(channel: DeliveryChannel, recipient: string): string {
  if (channel === "EMAIL") {
    const at = recipient.lastIndexOf("@");
    if (at <= 0) return "***";
    const local = recipient.slice(0, at);
    const domain = recipient.slice(at + 1);
    const head = local.slice(0, 1);
    return `${head}${"*".repeat(Math.max(1, local.length - 1))}@${domain}`;
  }
  // Telefonnummer: Laendervorwahl und die letzten zwei Stellen.
  const digits = recipient.replace(/\D/g, "");
  if (digits.length < 4) return "***";
  return `+${digits.slice(0, 2)}${"*".repeat(Math.max(1, digits.length - 4))}${digits.slice(-2)}`;
}

/** Versandprotokoll bilden. */
export function recordDelivery(
  order: Pick<Order, "id">,
  message: DeliveryMessage,
  options: { readonly sentAt: string; readonly via: "device" | "provider"; readonly ok: boolean; readonly error?: string | null },
): DeliveryRecord {
  return {
    orderId: order.id,
    channel: message.channel,
    recipient: anonymizeContact(message.channel, message.to),
    sentAt: options.sentAt,
    via: options.via,
    ok: options.ok,
    error: options.error ?? null,
  };
}
