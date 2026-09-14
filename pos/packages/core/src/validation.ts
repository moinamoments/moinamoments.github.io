/**
 * Pruefung aller Benutzereingaben.
 *
 * Jede Stelle, an der ein Mensch etwas eintippt, ist eine Stelle, an der
 * Unsinn in die Kasse gelangen kann - und ein Bon mit unsinniger Adresse ist
 * kein gueltiger Beleg. Deshalb stehen alle Pruefungen hier und nicht in den
 * Bildschirmen: nur so sind sie vollstaendig testbar, und nur so pruefen zwei
 * Bildschirme dasselbe Feld gleich.
 *
 * Zwei Grundsaetze:
 *
 *   1. **Zurechtschneiden, nicht ablehnen, wo es harmlos ist.** Fuehrende
 *      Leerzeichen, doppelte Leerzeichen, ein versehentlicher Zeilenumbruch aus
 *      dem Einfuegen - das wird geglaettet. Wer am Verkaufsstand steht, soll
 *      sich nicht mit Formalien streiten.
 *   2. **Ablehnen mit Begruendung, wo es zaehlt.** Ein falscher Betrag, eine
 *      unmoegliche Menge, eine Adresse ohne Ort: dann gibt es eine Meldung, die
 *      sagt, was erwartet wird - nicht "ungueltige Eingabe".
 *
 * Was hier ausdruecklich *nicht* passiert: pruefen, ob eine Steuernummer beim
 * Finanzamt existiert oder eine E-Mail-Adresse erreichbar ist. Das kann eine
 * Kasse nicht, und ein Formular, das es behauptet, luegt.
 */

import { ONE, type Cents, type Quantity, parseAmount } from "./money.ts";
import { MAX_NAME_LENGTH } from "./limits.ts";

/** Ergebnis einer Pruefung: geprueft und zurechtgeschnitten, oder abgelehnt. */
export type Checked<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export function accepted<T>(value: T): Checked<T> {
  return { ok: true, value };
}

export function rejected<T>(reason: string): Checked<T> {
  return { ok: false, reason };
}

/**
 * Unsichtbare und richtungsaendernde Zeichen entfernen.
 *
 * Solche Zeichen sind aus dem Einfuegen aus einer Webseite schnell dabei und
 * auf einem Beleg unsichtbar - sie koennen die Anzeige einer Zeile aber
 * umdrehen. Auf einem Pflichtbeleg ist das nicht hinnehmbar. Ausserdem wandern
 * die Werte in CSV-Dateien der DSFinV-K und in ESC/POS-Bytestroeme; ein
 * Steuerzeichen zerlegt dort die Zeile.
 */
export function stripInvisible(input: string): string {
  let out = "";
  for (const char of input) {
    const code = char.codePointAt(0) ?? 0;
    // Steuerzeichen, ausser Tabulator, Zeilenumbruch und Wagenruecklauf -
    // die werden anschliessend zu Leerzeichen geglaettet.
    const isControl = (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d) || code === 0x7f;
    // Nullbreiten-Zeichen, Richtungsmarken, BOM.
    const isZeroWidth = code >= 0x200b && code <= 0x200f;
    const isBidi = (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069);
    const isBom = code === 0xfeff;
    if (isControl || isZeroWidth || isBidi || isBom) continue;
    out += char;
  }
  return out;
}

/**
 * Text glaetten: Rand abschneiden, innere Leerraumfolgen auf ein Leerzeichen,
 * Zeilenumbrueche entfernen.
 */
export function tidyText(input: string): string {
  return input.replace(/\s+/g, " ").trim();
}

/** Text fuer Anzeige und Aufzeichnung vorbereiten. */
export function cleanText(input: string): string {
  return tidyText(stripInvisible(input));
}

// --- Namen und Freitext ---------------------------------------------------

export function checkRequiredText(
  input: string,
  options: { readonly label: string; readonly max?: number; readonly min?: number },
): Checked<string> {
  const value = cleanText(input);
  const min = options.min ?? 1;
  const max = options.max ?? MAX_NAME_LENGTH;
  if (value.length < min) {
    return rejected(min === 1 ? `${options.label} fehlt.` : `${options.label} braucht mindestens ${min} Zeichen.`);
  }
  if (value.length > max) return rejected(`${options.label} darf hoechstens ${max} Zeichen lang sein.`);
  return accepted(value);
}

export function checkOptionalText(
  input: string,
  options: { readonly label: string; readonly max?: number },
): Checked<string | null> {
  const value = cleanText(input);
  if (value === "") return accepted(null);
  const max = options.max ?? MAX_NAME_LENGTH;
  if (value.length > max) return rejected(`${options.label} darf hoechstens ${max} Zeichen lang sein.`);
  return accepted(value);
}

/** Artikel- oder Warengruppenname. */
export function checkDisplayName(input: string, label = "Der Name"): Checked<string> {
  return checkRequiredText(input, { label, max: MAX_NAME_LENGTH });
}

/** Kundenname fuer den Beleg. Optional - die meisten Kunden nennen keinen. */
export function checkCustomerName(input: string): Checked<string | null> {
  return checkOptionalText(input, { label: "Der Kundenname", max: 80 });
}

// --- Betraege und Mengen --------------------------------------------------

export interface AmountOptions {
  readonly label?: string;
  /** Darf der Betrag 0,00 sein? */
  readonly allowZero?: boolean;
  readonly allowNegative?: boolean;
  /** Obergrenze in Cent. Schuetzt vor dem verrutschten Komma. */
  readonly max?: Cents;
}

/**
 * Betrag pruefen.
 *
 * Die Obergrenze ist kein Misstrauen, sondern Erfahrung: die haeufigste
 * Fehleingabe am Kassenstand ist eine Null zu viel. 100.000 EUR auf einem
 * Imbissbeleg ist kein Umsatz, sondern ein Tippfehler - und einmal
 * abgeschlossen laesst er sich nur noch stornieren.
 */
export function checkAmount(input: string, options: AmountOptions = {}): Checked<Cents> {
  const label = options.label ?? "Der Betrag";
  const text = cleanText(input);
  if (text === "") return rejected(`${label} fehlt.`);

  const value = parseAmount(text);
  if (value == null) return rejected(`${label} ist nicht lesbar. Beispiel: 4,50`);
  if (value === 0 && options.allowZero !== true) return rejected(`${label} muss groesser als 0,00 sein.`);
  if (value < 0 && options.allowNegative !== true) return rejected(`${label} darf nicht negativ sein.`);

  const max = options.max ?? 10_000_000; // 100.000,00 EUR
  if (Math.abs(value) > max) {
    return rejected(`${label} ist mit ${(value / 100).toFixed(2).replace(".", ",")} unwahrscheinlich hoch - Komma verrutscht?`);
  }
  return accepted(value);
}

/** Menge in Stueck. Ganzzahlig, weil man kein halbes Stueck verkauft. */
export function checkPieces(input: string, options: { readonly label?: string; readonly max?: number } = {}): Checked<Quantity> {
  const label = options.label ?? "Die Menge";
  const text = cleanText(input).replace(/\s/g, "");
  if (text === "") return rejected(`${label} fehlt.`);
  if (!/^\d{1,6}$/.test(text)) return rejected(`${label} muss eine ganze Zahl sein.`);
  const pieces = Number(text);
  if (pieces === 0) return rejected(`${label} muss groesser als 0 sein.`);
  const max = options.max ?? 9999;
  if (pieces > max) return rejected(`${label} ist mit ${pieces} unwahrscheinlich hoch.`);
  return accepted(pieces * ONE);
}

/**
 * Gewicht oder Volumen in Tausendsteln.
 *
 * Drei Nachkommastellen, weil Gramm die kleinste Einheit einer Waage im
 * Verkauf ist. `parseAmount` genuegt hier nicht - der laesst nur zwei zu.
 */
export function checkDecimalQuantity(
  input: string,
  options: { readonly label?: string; readonly max?: number } = {},
): Checked<Quantity> {
  const label = options.label ?? "Das Gewicht";
  const text = cleanText(input).replace(/\s/g, "").replace(",", ".");
  if (text === "" || text === ".") return rejected(`${label} fehlt.`);
  if (!/^\d{1,6}(\.\d{1,3})?$/.test(text)) {
    return rejected(`${label} ist nicht lesbar. Beispiel: 0,350 fuer 350 Gramm`);
  }
  const [whole = "0", frac = ""] = text.split(".");
  const value = Number(whole) * ONE + Number(frac.padEnd(3, "0") || "0");
  if (value === 0) return rejected(`${label} muss groesser als 0 sein.`);
  const max = (options.max ?? 999) * ONE;
  if (value > max) return rejected(`${label} ist mit ${text} unwahrscheinlich hoch.`);
  return accepted(value);
}

/** Mindestbestand. Leer heisst: keine Warnung. */
export function checkThreshold(input: string): Checked<Quantity | null> {
  const text = cleanText(input);
  if (text === "") return accepted(null);
  const checked = checkDecimalQuantity(text, { label: "Der Mindestbestand" });
  return checked.ok ? accepted(checked.value) : rejected(checked.reason);
}

/** Stueckzahl im Zaehlprotokoll. Leer und 0 bedeuten "nicht vorhanden". */
export function checkCashCount(input: string): Checked<number> {
  const text = cleanText(input).replace(/\s/g, "");
  if (text === "") return accepted(0);
  if (!/^\d{1,5}$/.test(text)) return rejected("Die Stueckzahl muss eine ganze Zahl sein.");
  return accepted(Number(text));
}

// --- Adresse und Steuerangaben -------------------------------------------

/** Postleitzahl. In Deutschland fuenf Ziffern. */
export function checkPostalCode(input: string, countryCode = "DE"): Checked<string> {
  const value = cleanText(input).replace(/\s/g, "");
  if (value === "") return rejected("Die Postleitzahl fehlt.");
  if (countryCode === "DE") {
    if (!/^\d{5}$/.test(value)) return rejected("Eine deutsche Postleitzahl hat fuenf Ziffern.");
    return accepted(value);
  }
  if (!/^[A-Za-z0-9 -]{2,10}$/.test(value)) return rejected("Die Postleitzahl ist nicht lesbar.");
  return accepted(value.toUpperCase());
}

/**
 * Steuernummer.
 *
 * Geprueft wird die Form, nicht die Existenz: 10 bis 13 Ziffern, ueblich mit
 * Schraegstrichen geschrieben. Die Schreibweise unterscheidet sich je
 * Bundesland - eine strenge Pruefung wuerde gueltige Nummern ablehnen, und das
 * ist der schlimmere Fehler.
 */
export function checkTaxNumber(input: string): Checked<string | null> {
  const value = cleanText(input);
  if (value === "") return accepted(null);
  if (!/^[\d/\s.-]+$/.test(value)) {
    return rejected("Die Steuernummer darf nur Ziffern und Trennzeichen enthalten.");
  }
  const digits = value.replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 13) {
    return rejected("Eine Steuernummer hat 10 bis 13 Ziffern, z. B. 21/815/08150.");
  }
  return accepted(value);
}

/**
 * Umsatzsteuer-Identifikationsnummer.
 *
 * Zwei Buchstaben Laenderkennung, dann die Kennung des Landes. Fuer Deutschland
 * neun Ziffern; bei anderen Laendern wird nur die grobe Form geprueft, weil die
 * Regeln je Land verschieden sind. Auch hier: Form, nicht Existenz.
 */
export function checkVatId(input: string): Checked<string | null> {
  const value = cleanText(input).replace(/\s/g, "").toUpperCase();
  if (value === "") return accepted(null);
  if (!/^[A-Z]{2}[A-Z0-9]{2,13}$/.test(value)) {
    return rejected("Eine USt-IdNr. beginnt mit dem Laenderkuerzel, z. B. DE123456789.");
  }
  if (value.startsWith("DE") && !/^DE\d{9}$/.test(value)) {
    return rejected("Eine deutsche USt-IdNr. lautet DE und neun Ziffern.");
  }
  return accepted(value);
}

// --- Kontakt --------------------------------------------------------------

/**
 * E-Mail-Adresse.
 *
 * Bewusst nachsichtig geprueft: die vollstaendige Form einer Adresse ist in
 * RFC 5322 so weit gefasst, dass jede strenge Pruefung gueltige Adressen
 * ablehnt. Geprueft wird, was Tippfehler erkennt - genau ein Klammeraffe,
 * etwas davor, ein Punkt danach, keine Leerzeichen.
 */
export function checkEmail(input: string, options: { readonly required?: boolean } = {}): Checked<string | null> {
  const value = cleanText(input).replace(/\s/g, "");
  if (value === "") {
    return options.required ? rejected("Die E-Mail-Adresse fehlt.") : accepted(null);
  }
  if (value.length > 254) return rejected("Die E-Mail-Adresse ist zu lang.");
  if (!/^[^@\s]+@[^@\s]+\.[A-Za-z]{2,}$/.test(value)) {
    return rejected("Die E-Mail-Adresse ist nicht lesbar. Beispiel: name@beispiel.de");
  }
  // Nur die Domain wird kleingeschrieben: Rechnernamen sind unabhaengig von
  // Gross- und Kleinschreibung, der Teil vor dem @ nach RFC 5321 nicht. Wer
  // beides kleinschreibt, riskiert eine Adresse, die nicht mehr zustellbar
  // ist - und das faellt erst auf, wenn der Kunde seinen Beleg nicht bekommt.
  const at = value.lastIndexOf("@");
  return accepted(`${value.slice(0, at)}@${value.slice(at + 1).toLowerCase()}`);
}

/**
 * Telefonnummer, normalisiert fuer den SMS-Versand.
 *
 * Ergebnis ist die Form mit Laendervorwahl, weil ein SMS-Versand ohne sie
 * nicht zuverlaessig funktioniert. Eine Nummer mit fuehrender Null wird mit der
 * Standardvorwahl ergaenzt - das ist die Form, die ein deutscher Kunde ansagt.
 */
export function checkPhone(
  input: string,
  options: { readonly required?: boolean; readonly defaultCountry?: string } = {},
): Checked<string | null> {
  const raw = cleanText(input);
  if (raw === "") {
    return options.required ? rejected("Die Telefonnummer fehlt.") : accepted(null);
  }

  const cleaned = raw.replace(/[\s/().-]/g, "");
  if (!/^\+?\d+$/.test(cleaned)) {
    return rejected("Die Telefonnummer darf nur Ziffern und ein fuehrendes Plus enthalten.");
  }

  const country = options.defaultCountry ?? "+49";
  let normalized: string;
  if (cleaned.startsWith("+")) normalized = cleaned;
  else if (cleaned.startsWith("00")) normalized = `+${cleaned.slice(2)}`;
  else if (cleaned.startsWith("0")) normalized = `${country}${cleaned.slice(1)}`;
  else normalized = `${country}${cleaned}`;

  const digits = normalized.slice(1);
  if (digits.length < 7) return rejected("Die Telefonnummer ist zu kurz.");
  if (digits.length > 15) return rejected("Die Telefonnummer ist zu lang.");
  return accepted(normalized);
}

// --- Drucker --------------------------------------------------------------

/**
 * Adresse eines Netzwerkdruckers: IP-Adresse oder Rechnername.
 *
 * Ein Rechnername ist zugelassen, weil manche Drucker im Netz nur darueber
 * erreichbar sind. Eine IP-Adresse wird auf Bereiche geprueft - 192.168.1.300
 * ist keine, und der Fehler ist sonst erst beim Drucken zu sehen.
 */
export function checkPrinterHost(input: string): Checked<string> {
  const value = cleanText(input).replace(/\s/g, "").toLowerCase();
  if (value === "") return rejected("Der Drucker braucht eine Adresse, z. B. 192.168.1.50.");

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(value)) {
    const parts = value.split(".").map(Number);
    if (parts.some((part) => part > 255)) {
      return rejected(`${value} ist keine IP-Adresse - die Teile gehen nur bis 255.`);
    }
    return accepted(value);
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(value)) {
    return rejected("Die Adresse ist nicht lesbar. Erwartet wird eine IP-Adresse oder ein Rechnername.");
  }
  if (value.length > 253) return rejected("Die Adresse ist zu lang.");
  return accepted(value);
}

/** Port des Druckers. 9100 ist bei Bondruckern der Standard. */
export function checkPort(input: string): Checked<number> {
  const value = cleanText(input).replace(/\s/g, "");
  if (value === "") return accepted(9100);
  if (!/^\d{1,5}$/.test(value)) return rejected("Der Port muss eine Zahl sein. Bondrucker nehmen ueblicherweise 9100.");
  const port = Number(value);
  if (port < 1 || port > 65_535) return rejected("Der Port liegt zwischen 1 und 65535.");
  return accepted(port);
}

// --- Anmeldung und Barcode -----------------------------------------------

/**
 * Anmelde-PIN eines Bedieners.
 *
 * Vier bis acht Ziffern, und die offensichtlich schwachen werden abgelehnt.
 * Die PIN schuetzt Storno und Entnahme - eine Kasse mit der PIN 1234 schuetzt
 * gar nichts, und das faellt erst auf, wenn Geld fehlt.
 */
export function checkPin(input: string): Checked<string> {
  const value = cleanText(input).replace(/\s/g, "");
  if (value === "") return rejected("Die PIN fehlt.");
  if (!/^\d{4,8}$/.test(value)) return rejected("Die PIN besteht aus vier bis acht Ziffern.");
  if (/^(\d)\1+$/.test(value)) return rejected("Eine PIN aus einer einzigen Ziffer ist keine.");
  const ascending = "01234567890";
  const descending = "09876543210";
  if (ascending.includes(value) || descending.includes(value)) {
    return rejected("Eine fortlaufende Ziffernfolge ist als PIN zu leicht zu erraten.");
  }
  return accepted(value);
}

/**
 * Barcode nach EAN-8, EAN-13, UPC-A oder GTIN-14.
 *
 * Mit Pruefziffer: ein Scanner liest gelegentlich falsch, und ein Zeichen zu
 * viel oder zu wenig faellt ohne Pruefziffer erst auf, wenn der Artikel nicht
 * gefunden wird. Die Pruefziffer ist die Modulo-10-Gewichtung der Norm.
 */
export function checkBarcode(input: string): Checked<string> {
  const value = cleanText(input).replace(/[\s-]/g, "");
  if (value === "") return rejected("Der Barcode fehlt.");
  if (!/^\d+$/.test(value)) return rejected("Ein Barcode besteht nur aus Ziffern.");
  if (![8, 12, 13, 14].includes(value.length)) {
    return rejected(`Ein Barcode hat 8, 12, 13 oder 14 Ziffern - dieser hat ${value.length}.`);
  }
  if (!hasValidGtinCheckDigit(value)) {
    return rejected("Die Pruefziffer des Barcodes stimmt nicht - bitte erneut scannen.");
  }
  return accepted(value);
}

/** Modulo-10-Pruefziffer der GTIN. */
export function hasValidGtinCheckDigit(digits: string): boolean {
  if (!/^\d+$/.test(digits) || digits.length < 8) return false;
  let sum = 0;
  // Von rechts nach links, beginnend links von der Pruefziffer: 3, 1, 3, 1, ...
  for (let index = digits.length - 2; index >= 0; index--) {
    const digit = Number(digits[index]);
    const weight = (digits.length - 1 - index) % 2 === 1 ? 3 : 1;
    sum += digit * weight;
  }
  const check = (10 - (sum % 10)) % 10;
  return check === Number(digits[digits.length - 1]);
}

// --- Sammelpruefung -------------------------------------------------------

/**
 * Betriebsdaten pruefen, die auf jeden Bon kommen (Paragraf 6 Nr. 1
 * KassenSichV).
 *
 * Sammelt alle Maengel, statt beim ersten abzubrechen: wer ein Formular
 * ausfuellt, will alle Probleme auf einmal sehen und nicht fuenfmal auf
 * "Speichern" tippen.
 */
export function checkTenantData(input: {
  readonly name: string;
  readonly legalName: string;
  readonly street: string;
  readonly postalCode: string;
  readonly city: string;
  readonly taxNumber: string;
  readonly vatId: string;
  readonly email: string;
}): { readonly ok: boolean; readonly problems: readonly string[] } {
  const problems: string[] = [];
  const add = <T>(checked: Checked<T>): void => {
    if (!checked.ok) problems.push(checked.reason);
  };

  add(checkRequiredText(input.name, { label: "Der Name des Betriebs" }));
  add(checkRequiredText(input.legalName, { label: "Der rechtliche Name" }));
  add(checkRequiredText(input.street, { label: "Strasse und Hausnummer" }));
  add(checkPostalCode(input.postalCode));
  add(checkRequiredText(input.city, { label: "Der Ort" }));
  add(checkTaxNumber(input.taxNumber));
  add(checkVatId(input.vatId));
  add(checkEmail(input.email));

  // Eine von beiden Nummern gehoert auf den Bon - ohne beide ist der Beleg
  // unvollstaendig.
  const hasTax = cleanText(input.taxNumber) !== "";
  const hasVat = cleanText(input.vatId) !== "";
  if (!hasTax && !hasVat) {
    problems.push("Auf den Beleg gehoert die Steuernummer oder die USt-IdNr. - mindestens eine von beiden.");
  }
  return { ok: problems.length === 0, problems };
}
