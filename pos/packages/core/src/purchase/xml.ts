/**
 * Ein kleiner XML-Leser.
 *
 * ## Warum eigener Code und keine Bibliothek
 *
 * Eine Lieferantenrechnung nach ZUGFeRD oder XRechnung ist XML. Hermes - die
 * JavaScript-Maschine unter React Native - bringt keinen `DOMParser` mit, es
 * muesste also ohnehin etwas dazu. Und was hier hereinkommt, kommt **von
 * aussen**: aus einer Datei, die ein Lieferant geschickt hat. Ein Leser fuer
 * fremde Dateien ist genau die Stelle, an der man wissen will, was der Code
 * tut - deshalb steht er hier und nicht in einem Paket, das mit jedem Update
 * neu zu pruefen waere.
 *
 * ## Was dieser Leser absichtlich nicht kann
 *
 *   - **`<!DOCTYPE ...>` wird abgewiesen.** Dort stehen Entitaetsdefinitionen,
 *     und die sind der Einstieg in zwei alte Angriffe: XXE liest ueber eine
 *     Entitaet Dateien vom Geraet, die "Milliarde Lacher" blaeht eine Datei
 *     von wenigen Kilobyte auf Gigabyte im Speicher auf. Wer keine
 *     Entitaetsdefinitionen versteht, kann beides nicht. Echte ZUGFeRD- und
 *     XRechnungs-Dateien haben keinen DOCTYPE.
 *   - **Keine Namensraum-Aufloesung.** Gemerkt wird der lokale Name
 *     (`ram:SpecifiedTradeProduct` -> `SpecifiedTradeProduct`). Fuer das
 *     Auslesen einer Rechnung reicht das, und es macht die Suche unabhaengig
 *     davon, welches Kuerzel der Erzeuger gewaehlt hat.
 *   - **Keine Verarbeitung von `xml:space`, keine Schemapruefung.** Das ist
 *     Aufgabe eines Pruefdienstes, nicht einer Kasse.
 *
 * ## Grenzen
 *
 * Groesse, Tiefe und Knotenzahl sind begrenzt (siehe unten). Eine Kasse laeuft
 * auf einem Telefon; eine Datei, die den Speicher fuellt, ist kein Sonderfall,
 * den man spaeter behandelt, sondern der erste Fall, den ein Leser fuer fremde
 * Dateien behandeln muss.
 */

export class XmlError extends Error {}

/**
 * Groesse der Datei in Zeichen.
 *
 * Eine Lieferantenrechnung mit hundert Positionen liegt bei 100 bis 300 KB.
 * 8 MB ist reichlich Luft und bleibt eine Groesse, die ein Telefon ohne
 * Nachdenken traegt.
 */
export const MAX_XML_LENGTH = 8_000_000;

/**
 * Schachtelungstiefe.
 *
 * CII schachtelt tief (Rechnung > Handelsvorgang > Position > Artikel >
 * Kennzeichnung), etwa acht Ebenen. 40 ist weit darueber und verhindert, dass
 * eine boshaft gebaute Datei den Aufrufstapel fuellt.
 */
export const MAX_XML_DEPTH = 40;

/** Knoten insgesamt - hundert Positionen erzeugen grob 3000 Knoten. */
export const MAX_XML_NODES = 200_000;

/** Ein Element. `text` ist der unmittelbare Textinhalt, ohne den der Kinder. */
export interface XmlNode {
  /** Name ohne Namensraumkuerzel, z. B. `SpecifiedTradeProduct`. */
  readonly name: string;
  /** Name wie er dasteht, z. B. `ram:SpecifiedTradeProduct`. */
  readonly rawName: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly children: readonly XmlNode[];
  readonly text: string;
}

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/**
 * Entitaeten aufloesen.
 *
 * Nur die fuenf eingebauten und Zahlenverweise. Ein unbekannter Name (`&foo;`)
 * bleibt **wortwoertlich stehen** statt einen Fehler zu werfen: in einem
 * Artikelnamen ist ein einzelnes `&` haeufiger als ein Angriff, und eine
 * Rechnung, die an einem Ampersand scheitert, hilft niemandem.
 */
export function decodeEntities(value: string): string {
  if (!value.includes("&")) return value;
  return value.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return codePoint(code) ?? whole;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return codePoint(code) ?? whole;
    }
    return ENTITIES[body] ?? whole;
  });
}

function codePoint(code: number): string | null {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return null;
  // Ersatzzeichen einzeln sind kein gueltiges Zeichen; sie wuerden eine
  // kaputte Zeichenkette erzeugen, die spaeter irgendwo anders auffaellt.
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/** Das Byte-Vorzeichen am Dateianfang, das Windows-Werkzeuge gern setzen. */
function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

interface Builder {
  readonly rawName: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  text: string;
}

function localName(rawName: string): string {
  const colon = rawName.indexOf(":");
  return colon < 0 ? rawName : rawName.slice(colon + 1);
}

function finish(builder: Builder): XmlNode {
  return {
    name: localName(builder.rawName),
    rawName: builder.rawName,
    attributes: builder.attributes,
    children: builder.children,
    // Umgebende Leerzeichen sind in XML Formatierung, kein Inhalt.
    text: builder.text.trim(),
  };
}

/**
 * XML einlesen.
 *
 * Liefert das Wurzelelement. Wirft `XmlError`, wenn die Datei nicht aufgeht -
 * mit der Zeichenstelle, damit ein Lieferant etwas in der Hand hat, wenn seine
 * Datei nicht angenommen wird.
 */
export function parseXml(source: string): XmlNode {
  if (source.length > MAX_XML_LENGTH) {
    throw new XmlError(`Die Datei ist zu gross (${source.length} Zeichen, erlaubt sind ${MAX_XML_LENGTH}).`);
  }
  const input = stripBom(source);

  const stack: Builder[] = [];
  let root: XmlNode | null = null;
  let nodes = 0;
  let position = 0;

  function fail(message: string, at: number): never {
    throw new XmlError(`${message} (Zeichen ${at}).`);
  }

  while (position < input.length) {
    const open = input.indexOf("<", position);
    if (open < 0) {
      // Text nach dem letzten Element. Nur Leerraum ist erlaubt.
      if (input.slice(position).trim().length > 0) fail("Text ausserhalb eines Elements", position);
      break;
    }

    if (open > position) {
      const chunk = input.slice(position, open);
      const current = stack[stack.length - 1];
      if (current) current.text += decodeEntities(chunk);
      else if (chunk.trim().length > 0) fail("Text ausserhalb eines Elements", position);
    }

    if (input.startsWith("<!--", open)) {
      const end = input.indexOf("-->", open + 4);
      if (end < 0) fail("Ein Kommentar wird nicht geschlossen", open);
      position = end + 3;
      continue;
    }

    if (input.startsWith("<![CDATA[", open)) {
      const end = input.indexOf("]]>", open + 9);
      if (end < 0) fail("Ein CDATA-Abschnitt wird nicht geschlossen", open);
      const current = stack[stack.length - 1];
      // In CDATA steht der Text roh - Entitaeten werden dort nicht aufgeloest.
      if (current) current.text += input.slice(open + 9, end);
      position = end + 3;
      continue;
    }

    if (input.startsWith("<?", open)) {
      const end = input.indexOf("?>", open + 2);
      if (end < 0) fail("Eine Verarbeitungsanweisung wird nicht geschlossen", open);
      position = end + 2;
      continue;
    }

    if (input.startsWith("<!DOCTYPE", open) || input.startsWith("<!doctype", open)) {
      // Siehe Kopf der Datei: hier faengt XXE an, und deshalb hoert es hier auf.
      throw new XmlError(
        "Die Datei enthaelt eine Dokumenttypdefinition (DOCTYPE). Solche Dateien werden nicht gelesen, weil dort Verweise auf fremde Inhalte stehen koennen. Eine Rechnung nach ZUGFeRD oder XRechnung braucht keinen DOCTYPE.",
      );
    }

    if (input.startsWith("<!", open)) fail("Unbekannte Anweisung", open);

    const close = findTagEnd(input, open);
    if (close < 0) fail("Ein Element wird nicht geschlossen", open);
    const inner = input.slice(open + 1, close);

    if (inner.startsWith("/")) {
      const name = inner.slice(1).trim();
      const current = stack.pop();
      if (!current) fail(`Schliessendes Element </${name}> ohne oeffnendes`, open);
      if (current.rawName !== name) fail(`</${name}> schliesst <${current.rawName}> nicht`, open);
      const node = finish(current);
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else root = node;
      position = close + 1;
      continue;
    }

    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const { rawName, attributes } = parseTag(body, open, fail);

    if (++nodes > MAX_XML_NODES) {
      throw new XmlError(`Die Datei hat zu viele Elemente (erlaubt sind ${MAX_XML_NODES}).`);
    }

    if (selfClosing) {
      const node: XmlNode = { name: localName(rawName), rawName, attributes, children: [], text: "" };
      const parent = stack[stack.length - 1];
      if (parent) parent.children.push(node);
      else if (root) fail("Mehr als ein Wurzelelement", open);
      else root = node;
    } else {
      if (stack.length >= MAX_XML_DEPTH) {
        throw new XmlError(`Die Datei ist zu tief geschachtelt (erlaubt sind ${MAX_XML_DEPTH} Ebenen).`);
      }
      if (stack.length === 0 && root) fail("Mehr als ein Wurzelelement", open);
      stack.push({ rawName, attributes, children: [], text: "" });
    }
    position = close + 1;
  }

  if (stack.length > 0) {
    throw new XmlError(`Das Element <${stack[stack.length - 1]!.rawName}> wird nicht geschlossen.`);
  }
  if (!root) throw new XmlError("Die Datei enthaelt kein XML-Element.");
  return root;
}

/**
 * Das `>` finden, das diesen Tag beendet.
 *
 * Nicht einfach `indexOf(">")`: in einem Attributwert darf ein `>` stehen
 * (`<a title="5 > 3">`), und wer das uebersieht, zerlegt genau die Rechnung,
 * in der ein Artikelname ein Groesserzeichen enthaelt.
 */
function findTagEnd(input: string, open: number): number {
  let quote: string | null = null;
  for (let index = open + 1; index < input.length; index++) {
    const char = input[index]!;
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
    else if (char === "<") return -1;
  }
  return -1;
}

function parseTag(
  body: string,
  at: number,
  fail: (message: string, at: number) => never,
): { rawName: string; attributes: Record<string, string> } {
  const trimmed = body.trim();
  if (trimmed.length === 0) fail("Element ohne Namen", at);

  let index = 0;
  while (index < trimmed.length && !/\s/.test(trimmed[index]!)) index++;
  const rawName = trimmed.slice(0, index);
  if (!/^[A-Za-z_][\w.\-]*(:[A-Za-z_][\w.\-]*)?$/.test(rawName)) fail(`Ungueltiger Elementname "${rawName}"`, at);

  const attributes: Record<string, string> = {};
  while (index < trimmed.length) {
    while (index < trimmed.length && /\s/.test(trimmed[index]!)) index++;
    if (index >= trimmed.length) break;

    const nameStart = index;
    while (index < trimmed.length && trimmed[index] !== "=" && !/\s/.test(trimmed[index]!)) index++;
    const rawAttribute = trimmed.slice(nameStart, index);
    if (rawAttribute.length === 0) break;

    while (index < trimmed.length && /\s/.test(trimmed[index]!)) index++;
    if (trimmed[index] !== "=") fail(`Attribut "${rawAttribute}" ohne Wert`, at);
    index++;
    while (index < trimmed.length && /\s/.test(trimmed[index]!)) index++;

    const quote = trimmed[index];
    if (quote !== '"' && quote !== "'") fail(`Wert von "${rawAttribute}" steht nicht in Anfuehrungszeichen`, at);
    index++;
    const valueStart = index;
    while (index < trimmed.length && trimmed[index] !== quote) index++;
    if (index >= trimmed.length) fail(`Wert von "${rawAttribute}" wird nicht geschlossen`, at);
    // Auch beim Attribut zaehlt der lokale Name; `udt:format` und `format`
    // meinen dasselbe, und welches Kuerzel dasteht, entscheidet der Erzeuger.
    attributes[localName(rawAttribute)] = decodeEntities(trimmed.slice(valueStart, index));
    index++;
  }

  return { rawName, attributes };
}

/** Alle unmittelbaren Kinder mit diesem lokalen Namen. */
export function childrenNamed(node: XmlNode, name: string): XmlNode[] {
  return node.children.filter((child) => child.name === name);
}

/** Das erste unmittelbare Kind mit diesem Namen, oder `null`. */
export function childNamed(node: XmlNode, name: string): XmlNode | null {
  return node.children.find((child) => child.name === name) ?? null;
}

/**
 * Einem Pfad aus lokalen Namen folgen: `path(root, "Header", "ID")`.
 *
 * Immer das erste passende Kind. Fuer Rechnungen genuegt das - wo mehrere
 * gleichnamige Kinder vorkommen (Positionen, Steuerzeilen), wird
 * `childrenNamed` benutzt, damit der Umgang mit der Mehrzahl im Aufrufer
 * sichtbar bleibt und nicht hier verschwindet.
 */
export function path(node: XmlNode, ...names: readonly string[]): XmlNode | null {
  let current: XmlNode | null = node;
  for (const name of names) {
    if (!current) return null;
    current = childNamed(current, name);
  }
  return current;
}

/** Text an einem Pfad, oder `null`, wenn es den Weg nicht gibt. */
export function textAt(node: XmlNode, ...names: readonly string[]): string | null {
  const found = path(node, ...names);
  if (!found) return null;
  return found.text.length > 0 ? found.text : null;
}

/**
 * Das erste Element mit diesem Namen, egal wie tief.
 *
 * Nuetzlich, weil UBL und CII dieselbe Angabe an unterschiedlichen Stellen
 * fuehren - und weil manche Erzeuger eine Ebene einziehen, die im Beispiel der
 * Spezifikation nicht steht.
 */
export function findFirst(node: XmlNode, name: string): XmlNode | null {
  if (node.name === name) return node;
  for (const child of node.children) {
    const found = findFirst(child, name);
    if (found) return found;
  }
  return null;
}
