/**
 * Kartenzahlung und Tap to Pay.
 *
 * ## Was Tap to Pay ist - und was es voraussetzt
 *
 * "Tap to Pay" heisst: die Karte oder das Telefon des Kunden wird an das
 * Telefon des Betriebs gehalten, ohne zusaetzliches Lesegeraet. Apple nennt es
 * *Tap to Pay on iPhone*, Google *Tap to Pay on Android*. Es ist technisch
 * moeglich und hier vorgesehen - aber es ist **kein Stueck Code, das man
 * einfach schreibt**, und das muss vor jeder Planung klar sein:
 *
 *   - **Apple** gibt die Funktion nur mit einem eigens beantragten Entitlement
 *     frei, und nur an Apps, die ueber einen zugelassenen Zahlungsdienstleister
 *     abrechnen. Ohne dessen SDK gibt es keinen Zugriff auf die NFC-Einheit zum
 *     Kartenlesen. Geraet: iPhone XS oder neuer, aktuelles iOS.
 *   - **Android** erlaubt es ebenfalls nur ueber einen zugelassenen Anbieter.
 *     Wird die PIN auf dem Bildschirm eingegeben, ist zusaetzlich eine
 *     Zertifizierung nach PCI MPoC im Spiel - die betrifft den Anbieter, nicht
 *     diese App, aber sie bestimmt, welcher Anbieter in Frage kommt.
 *   - **Abrechnung** laeuft immer ueber einen Zahlungsdienstleister (Stripe
 *     Terminal, Adyen, SumUp, Zettle und aehnliche). Der bekommt einen Anteil
 *     jeder Transaktion, und mit ihm wird ein Vertrag geschlossen.
 *
 * Was dieses Modul deshalb tut: es beschreibt die **Schnittstelle**, an die ein
 * solches SDK angebunden wird, und liefert einen Simulator, mit dem der ganze
 * Bezahlvorgang ohne Vertrag und ohne Geraet getestet werden kann. Der Umbau auf
 * einen echten Anbieter ist dann eine Datei - nicht der Bezahlbildschirm, nicht
 * der Belegabschluss, nicht die TSE-Logik.
 *
 * ## Die Reihenfolge, auf die es ankommt
 *
 *   1. Betrag feststehen lassen (Warenkorb ist fertig)
 *   2. **Karte autorisieren** - das ist der Schritt, der scheitern kann
 *   3. TSE-Transaktion abschliessen
 *   4. Beleg speichern und ausgeben
 *
 * Schritt 2 muss vor Schritt 3 liegen. Wird erst der Beleg signiert und dann
 * die Karte abgelehnt, steht ein bezahlter Beleg im Bestand, dem kein Geld
 * gegenuebersteht - und der laesst sich nur noch stornieren. Umgekehrt ist eine
 * autorisierte Zahlung ohne Beleg zwar auch ein Problem, aber ein behebbares:
 * der Beleg wird nachgeholt, das Geld ist da.
 */

import type { Cents } from "../money.ts";
import type { PaymentMethod, Timestamp } from "../model.ts";

export class TerminalError extends Error {
  readonly retryable: boolean;

  constructor(message: string, options: { readonly retryable?: boolean } = {}) {
    super(message);
    this.name = "TerminalError";
    this.retryable = options.retryable ?? false;
  }
}

/** Art der Verbindung zum Bezahlvorgang. */
export type TerminalKind =
  /** NFC im Telefon selbst - Tap to Pay. */
  | "TAP_TO_PAY"
  /** Externes Lesegeraet ueber Bluetooth. */
  | "BLUETOOTH_READER"
  /** Externes Lesegeraet im Netzwerk. */
  | "NETWORK_READER"
  /** Kein Terminal: Kartenzahlung wird nur gebucht, nicht abgewickelt. */
  | "MANUAL";

export const TERMINAL_LABELS: Record<TerminalKind, string> = {
  TAP_TO_PAY: "Tap to Pay (Telefon)",
  BLUETOOTH_READER: "Kartenleser (Bluetooth)",
  NETWORK_READER: "Kartenleser (Netzwerk)",
  MANUAL: "ohne Terminal buchen",
};

/** Was das eingerichtete Terminal kann. Steuert, was die Oberflaeche anbietet. */
export interface TerminalCapabilities {
  readonly kind: TerminalKind;
  /** Kontaktlos lesen (Karte oder Telefon an das Geraet halten). */
  readonly contactless: boolean;
  /** Karte einstecken (Chip). */
  readonly chip: boolean;
  /** PIN-Eingabe moeglich - bei Tap to Pay auf dem Bildschirm. */
  readonly pin: boolean;
  /**
   * Rueckbuchung ueber das Terminal moeglich.
   *
   * Wichtig fuer den Storno: kann das Terminal nicht zurueckbuchen, muss die
   * Rueckzahlung bar erfolgen oder der Kunde bekommt eine Gutschrift - und das
   * muss der Bediener *vor* dem Storno wissen.
   */
  readonly refund: boolean;
  /** Trinkgeld am Terminal abfragen. */
  readonly tip: boolean;
}

export type TerminalStatus = "READY" | "BUSY" | "NOT_CONFIGURED" | "UNREACHABLE";

/** Ergebnis einer Autorisierung. */
export interface TerminalPayment {
  /** Vom Anbieter vergebene Referenz - gehoert auf den Bon und in die DSFinV-K. */
  readonly reference: string;
  readonly amount: Cents;
  /** Zusaetzlich gegebenes Trinkgeld, falls am Terminal abgefragt. */
  readonly tip: Cents;
  /** Zahlart, wie sie der Beleg ausweist. */
  readonly method: Extract<PaymentMethod, "CARD_DEBIT" | "CARD_CREDIT" | "MOBILE">;
  /** Kartenmarke fuer den Bon, z. B. `girocard`, `Visa`, `Apple Pay`. */
  readonly scheme: string;
  /** Die letzten vier Stellen der Kartennummer, falls der Anbieter sie liefert. */
  readonly last4?: string | null;
  /** Genehmigungsnummer des Zahlungsdienstleisters. */
  readonly authorizationCode?: string | null;
  readonly completedAt: Timestamp;
}

export interface AuthorizeRequest {
  readonly amount: Cents;
  /** Belegnummer oder Vorgangs-Id, damit Zahlung und Beleg zusammenfindbar sind. */
  readonly reference: string;
  /** Trinkgeld am Terminal abfragen, wenn es das kann. */
  readonly askForTip?: boolean;
  /** Beschreibung fuer den Kontoauszug des Kunden. */
  readonly description?: string;
}

/**
 * Ein Bezahlterminal.
 *
 * Jede Methode kann fehlschlagen, und jeder Fehlschlag ist entweder
 * wiederholbar (Kunde haelt die Karte erneut hin) oder endgueltig (Karte
 * gesperrt). Diese Unterscheidung gehoert in die Antwort, weil die Oberflaeche
 * sie braucht: "Nochmal versuchen" oder "Andere Zahlart".
 */
export interface PaymentTerminal {
  readonly name: string;
  capabilities(): TerminalCapabilities;
  status(): Promise<TerminalStatus>;
  /** Betrag autorisieren. Wirft `TerminalError` bei Ablehnung oder Abbruch. */
  authorize(request: AuthorizeRequest): Promise<TerminalPayment>;
  /**
   * Zahlung zurueckbuchen - fuer Storno und Teilstorno.
   *
   * `amount` darf kleiner als die urspruengliche Zahlung sein; damit ist der
   * Teilstorno auch bei Kartenzahlung moeglich.
   */
  refund(payment: { readonly reference: string; readonly amount: Cents }): Promise<TerminalPayment>;
  /** Laufenden Vorgang abbrechen, wenn der Kunde es sich anders overlegt. */
  cancel(): Promise<void>;
}

/** Kein Terminal eingerichtet: Kartenzahlung wird nur gebucht. */
export const MANUAL_TERMINAL: PaymentTerminal = {
  name: "ohne Terminal",
  capabilities() {
    return { kind: "MANUAL", contactless: false, chip: false, pin: false, refund: false, tip: false };
  },
  async status() {
    return "NOT_CONFIGURED";
  },
  async authorize() {
    throw new TerminalError(
      "Es ist kein Bezahlterminal eingerichtet. Die Kartenzahlung kann nur gebucht werden - abgewickelt wird sie ausserhalb der Kasse.",
    );
  },
  async refund() {
    throw new TerminalError("Ohne Terminal ist keine Rueckbuchung moeglich - bitte bar auszahlen.");
  },
  async cancel() {
    // Es laeuft nichts, was abzubrechen waere.
  },
};

// --- Simulator ------------------------------------------------------------

export interface SimulatedTerminalOptions {
  readonly kind?: TerminalKind;
  readonly now?: () => Timestamp;
  /** Antwort des naechsten Vorgangs - fuer Tests der Ablehnung. */
  outcome?: "APPROVED" | "DECLINED" | "ABORTED" | "UNREACHABLE";
  /** Trinkgeld, das der simulierte Kunde gibt. */
  tip?: Cents;
  readonly scheme?: string;
  readonly capabilities?: Partial<TerminalCapabilities>;
}

/**
 * Simuliertes Terminal.
 *
 * NUR FUER TESTS UND ENTWICKLUNG. Es bewegt kein Geld. Die Referenz ist
 * erkennbar eine Simulation (`SIM-...`), damit ein versehentlich damit
 * abgeschlossener Beleg auffaellt und nicht als echte Kartenzahlung
 * durchgeht - dieselbe Vorsichtsmassnahme wie bei der Test-TSE.
 */
export class SimulatedTerminal implements PaymentTerminal {
  readonly name = "Simulation";
  private counter = 0;
  private readonly options: SimulatedTerminalOptions;

  constructor(options: SimulatedTerminalOptions = {}) {
    this.options = options;
  }

  capabilities(): TerminalCapabilities {
    const kind = this.options.kind ?? "TAP_TO_PAY";
    return {
      kind,
      contactless: true,
      chip: kind !== "TAP_TO_PAY",
      pin: true,
      refund: true,
      tip: true,
      ...this.options.capabilities,
    };
  }

  async status(): Promise<TerminalStatus> {
    return this.options.outcome === "UNREACHABLE" ? "UNREACHABLE" : "READY";
  }

  async authorize(request: AuthorizeRequest): Promise<TerminalPayment> {
    if (request.amount <= 0) {
      throw new TerminalError("Ein Betrag von 0,00 EUR oder weniger kann nicht autorisiert werden.");
    }
    switch (this.options.outcome ?? "APPROVED") {
      case "DECLINED":
        throw new TerminalError("Die Karte wurde abgelehnt. Bitte andere Zahlart.", { retryable: false });
      case "ABORTED":
        throw new TerminalError("Der Vorgang wurde am Terminal abgebrochen.", { retryable: true });
      case "UNREACHABLE":
        throw new TerminalError("Das Terminal ist nicht erreichbar.", { retryable: true });
      default:
        break;
    }

    const tip = this.options.capabilities?.tip === false ? 0 : (this.options.tip ?? 0);
    return {
      reference: `SIM-${String(++this.counter).padStart(6, "0")}`,
      amount: request.amount,
      tip: request.askForTip ? tip : 0,
      method: "CARD_DEBIT",
      scheme: this.options.scheme ?? "girocard",
      last4: "4242",
      authorizationCode: `A${String(this.counter).padStart(5, "0")}`,
      completedAt: (this.options.now ?? (() => new Date().toISOString()))(),
    };
  }

  async refund(payment: { reference: string; amount: Cents }): Promise<TerminalPayment> {
    if (payment.amount <= 0) throw new TerminalError("Der Rueckbuchungsbetrag muss positiv sein.");
    return {
      reference: `SIM-R-${String(++this.counter).padStart(6, "0")}`,
      amount: -payment.amount,
      tip: 0,
      method: "CARD_DEBIT",
      scheme: this.options.scheme ?? "girocard",
      last4: "4242",
      authorizationCode: null,
      completedAt: (this.options.now ?? (() => new Date().toISOString()))(),
    };
  }

  async cancel(): Promise<void> {
    // Der Simulator haelt keinen Vorgang offen.
  }
}

// --- Anbindung an den Belegabschluss -------------------------------------

/**
 * Terminal-Ergebnis in eine Zahlung des Belegs umwandeln.
 *
 * Das Trinkgeld wird **nicht** einfach in den Zahlbetrag gerechnet: es ist kein
 * Warenumsatz und gehoert als eigene Position auf den Beleg
 * (Geschaeftsvorfallart `TrinkgeldAN`). Deshalb liefert diese Funktion beides
 * getrennt zurueck, und der Bezahlbildschirm entscheidet, was er damit macht.
 */
export function terminalPaymentToIntent(payment: TerminalPayment): {
  readonly method: PaymentMethod;
  readonly amount: Cents;
  readonly reference: string;
  readonly label: string;
  readonly tip: Cents;
} {
  const label = payment.last4 ? `${payment.scheme} ...${payment.last4}` : payment.scheme;
  return {
    method: payment.method,
    amount: payment.amount,
    reference: payment.reference,
    label,
    tip: payment.tip,
  };
}

export interface TerminalConfig {
  readonly kind: TerminalKind;
  /** Name des Zahlungsdienstleisters, z. B. `stripe`, `adyen`, `sumup`. */
  readonly provider?: string | null;
  /** Netzwerkleser: Adresse. */
  readonly host?: string | null;
  readonly port?: number | null;
  /** Bluetooth-Leser: Geraeteadresse aus der Kopplung. */
  readonly bluetoothAddress?: string | null;
  /** Trinkgeld am Terminal abfragen. */
  readonly askForTip: boolean;
}

export const DEFAULT_TERMINAL_CONFIG: TerminalConfig = {
  kind: "MANUAL",
  provider: null,
  host: null,
  port: null,
  bluetoothAddress: null,
  askForTip: false,
};

/**
 * Voraussetzungen fuer die gewaehlte Art nennen.
 *
 * Steht in den Einstellungen unter der Auswahl. Wer Tap to Pay einschaltet,
 * soll sofort lesen, was dafuer noch fehlt - und nicht erst merken, dass es
 * nicht geht, wenn der erste Kunde die Karte hinhaelt.
 */
export function terminalRequirements(kind: TerminalKind): readonly string[] {
  switch (kind) {
    case "TAP_TO_PAY":
      return [
        "Vertrag mit einem Zahlungsdienstleister, der Tap to Pay anbietet.",
        "Auf iPhone: von Apple freigegebenes Entitlement, iPhone XS oder neuer.",
        "Auf Android: NFC-faehiges Geraet, vom Anbieter freigegeben.",
        "Die App muss als Entwicklungs-Build gebaut werden - in Expo Go ist der Zugriff auf NFC nicht moeglich.",
      ];
    case "BLUETOOTH_READER":
      return [
        "Vertrag mit einem Zahlungsdienstleister.",
        "Kartenleser des Anbieters, mit dem Geraet gekoppelt.",
        "Entwicklungs-Build der App mit dem SDK des Anbieters.",
      ];
    case "NETWORK_READER":
      return [
        "Vertrag mit einem Zahlungsdienstleister.",
        "Kartenleser im selben Netzwerk wie die Kasse.",
        "Entwicklungs-Build der App mit dem SDK des Anbieters.",
      ];
    case "MANUAL":
      return [
        "Keine Voraussetzungen. Die Kartenzahlung wird auf dem Beleg gebucht, aber nicht von der Kasse abgewickelt - das Geld kommt ueber ein separates Terminal.",
      ];
  }
}

/**
 * Kann mit dieser Einrichtung eine Karte abgewickelt werden?
 *
 * Getrennt von `validatePrinterConfig` und aehnlichen, weil die Folge eine
 * andere ist: ohne Drucker kann man den Bon anzeigen, ohne Terminal kann man
 * keine Karte annehmen.
 */
export function validateTerminalConfig(config: TerminalConfig): { ok: true } | { ok: false; reason: string } {
  if (config.kind === "MANUAL") return { ok: true };
  if (!config.provider || config.provider.trim() === "") {
    return { ok: false, reason: "Es ist kein Zahlungsdienstleister eingerichtet." };
  }
  if (config.kind === "NETWORK_READER" && (!config.host || config.host.trim() === "")) {
    return { ok: false, reason: "Der Kartenleser im Netzwerk braucht eine Adresse." };
  }
  if (config.kind === "BLUETOOTH_READER" && (!config.bluetoothAddress || config.bluetoothAddress.trim() === "")) {
    return { ok: false, reason: "Der Kartenleser ist noch nicht gekoppelt." };
  }
  return { ok: true };
}
