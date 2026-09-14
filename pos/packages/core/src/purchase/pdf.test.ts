import { strict as assert } from "node:assert";
import { deflateSync } from "node:zlib";
import test from "node:test";

import { parseInvoiceXml } from "./invoice.ts";
import { PdfError, asInvoiceXml, base64ToBytes, extractInvoiceXml, looksLikePdf } from "./pdf.ts";

const XML = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100">
  <rsm:ExchangedDocument><ram:ID>RE-2026-0815</ram:ID></rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:SpecifiedTradeProduct><ram:Name>Cola 0,33 l</ram:Name></ram:SpecifiedTradeProduct>
      <ram:SpecifiedLineTradeDelivery><ram:BilledQuantity unitCode="H87">24</ram:BilledQuantity></ram:SpecifiedLineTradeDelivery>
    </ram:IncludedSupplyChainTradeLineItem>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;

/**
 * Eine PDF bauen, wie ein ZUGFeRD-Erzeuger sie schreibt.
 *
 * Bewusst von Hand zusammengesetzt und nicht als feste Beispieldatei abgelegt:
 * so laesst sich einzeln durchspielen, was in echten Dateien verschieden ist -
 * gepackt oder ungepackt, mit oder ohne Anhang, mit weiteren Stroemen daneben.
 */
function buildPdf(parts: {
  attachment?: Uint8Array;
  attachmentName?: string;
  flate?: boolean;
  extraStreams?: readonly Uint8Array[];
  encrypted?: boolean;
}): Uint8Array {
  const chunks: Uint8Array[] = [];
  const encoder = new TextEncoder();
  const push = (text: string) => chunks.push(encoder.encode(text));

  push("%PDF-1.7\n%\xE2\xE3\xCF\xD3\n");

  let object = 1;
  for (const extra of parts.extraStreams ?? []) {
    push(`${object++} 0 obj\n<< /Length ${extra.length} >>\nstream\n`);
    chunks.push(extra);
    push("\nendstream\nendobj\n");
  }

  if (parts.attachment) {
    const data = parts.flate ? new Uint8Array(deflateSync(parts.attachment)) : parts.attachment;
    const filter = parts.flate ? " /Filter /FlateDecode" : "";
    push(`${object} 0 obj\n<< /Type /EmbeddedFile /Subtype /text#2Fxml${filter} /Length ${data.length} >>\nstream\n`);
    chunks.push(data);
    push("\nendstream\nendobj\n");
    object++;
    push(`${object++} 0 obj\n<< /Type /Filespec /F (${parts.attachmentName ?? "factur-x.xml"}) /UF (${parts.attachmentName ?? "factur-x.xml"}) >>\nendobj\n`);
  }

  push(`trailer\n<< /Root 1 0 R${parts.encrypted ? " /Encrypt 9 0 R" : ""} >>\n%%EOF\n`);

  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

const xmlBytes = new TextEncoder().encode(XML);

test("eine PDF-Datei wird als solche erkannt", () => {
  assert.equal(looksLikePdf(buildPdf({ attachment: xmlBytes })), true);
  assert.equal(looksLikePdf(new TextEncoder().encode("<?xml version=\"1.0\"?><a/>")), false);
});

test("ZUGFeRD: der gepackte Anhang wird gefunden und gelesen", () => {
  const pdf = buildPdf({ attachment: xmlBytes, flate: true });
  const attachment = extractInvoiceXml(pdf);
  assert.equal(attachment.name, "factur-x.xml");
  assert.equal(attachment.content, XML);

  // Und er laesst sich anschliessend als Rechnung lesen.
  const invoice = parseInvoiceXml(attachment.content);
  assert.equal(invoice.invoiceNumber, "RE-2026-0815");
  assert.equal(invoice.lines[0]?.name, "Cola 0,33 l");
});

test("auch ein ungepackter Anhang wird gefunden", () => {
  const attachment = extractInvoiceXml(buildPdf({ attachment: xmlBytes, flate: false }));
  assert.equal(attachment.content, XML);
});

test("der Anhang wird zwischen anderen Datenstroemen gefunden", () => {
  // Seiteninhalte und Bilder stehen in derselben Datei; keiner davon ist die
  // Rechnung, und keiner darf das Lesen abbrechen.
  const seite = new Uint8Array(deflateSync(new TextEncoder().encode("BT /F1 12 Tf (Rechnung) Tj ET")));
  const bild = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xd9]);
  const pdf = buildPdf({ attachment: xmlBytes, flate: true, extraStreams: [seite, bild] });
  assert.equal(extractInvoiceXml(pdf).content, XML);
});

test("ein Anhang, dessen Name nichts verraet, wird trotzdem gefunden", () => {
  // Entschieden wird am Inhalt, nicht am Namen - genau dafuer.
  const pdf = buildPdf({ attachment: xmlBytes, flate: true, attachmentName: "anhang1.xml" });
  assert.equal(extractInvoiceXml(pdf).content, XML);
});

test("eine XRechnung im UBL-Format wird ebenso gefunden", () => {
  const ubl = new TextEncoder().encode(
    '<?xml version="1.0"?><ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"><cbc:ID>4711</cbc:ID></ubl:Invoice>',
  );
  const attachment = extractInvoiceXml(buildPdf({ attachment: ubl, flate: true }));
  assert.equal(parseInvoiceXml(attachment.content).invoiceNumber, "4711");
});

test("eine PDF ohne Anhang sagt, was stattdessen geht", () => {
  const seite = new Uint8Array(deflateSync(new TextEncoder().encode("BT (Rechnung) Tj ET")));
  assert.throws(
    () => extractInvoiceXml(buildPdf({ extraStreams: [seite] })),
    (error: unknown) => error instanceof PdfError && /keine maschinenlesbare Rechnung/.test((error as Error).message) && /CSV/.test((error as Error).message),
  );
});

test("XMP-Metadaten sind XML, aber keine Rechnung", () => {
  const xmp = new TextEncoder().encode(
    '<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF><rdf:Description/></rdf:RDF></x:xmpmeta>',
  );
  assert.equal(asInvoiceXml(xmp), null);
  assert.throws(() => extractInvoiceXml(buildPdf({ extraStreams: [xmp] })), PdfError);
});

test("eine verschluesselte PDF wird mit klarer Ansage abgewiesen", () => {
  assert.throws(
    () => extractInvoiceXml(buildPdf({ attachment: xmlBytes, flate: true, encrypted: true })),
    (error: unknown) => error instanceof PdfError && /verschluesselt/.test((error as Error).message),
  );
});

test("was keine PDF ist, wird gar nicht erst durchsucht", () => {
  assert.throws(
    () => extractInvoiceXml(new TextEncoder().encode("Hallo, ich bin ein Textdokument.")),
    (error: unknown) => error instanceof PdfError && /keine PDF/.test((error as Error).message),
  );
});

test("eine zu grosse Datei wird abgewiesen", () => {
  const gross = new Uint8Array(33 * 1024 * 1024);
  gross.set(new TextEncoder().encode("%PDF-1.7"), 0);
  assert.throws(() => extractInvoiceXml(gross), (error: unknown) => error instanceof PdfError && /zu gross/.test((error as Error).message));
});

test("ein beschaedigter gepackter Strom bricht die Suche nicht ab", () => {
  // Der kaputte Strom steht vor dem Anhang. Wer beim ersten Fehler aufgibt,
  // findet die Rechnung nie.
  const kaputt = new Uint8Array([0x78, 0x9c, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
  const pdf = buildPdf({ attachment: xmlBytes, flate: true, extraStreams: [kaputt] });
  assert.equal(extractInvoiceXml(pdf).content, XML);
});

test("asInvoiceXml nimmt keine Binaerdaten an", () => {
  const binaer = new Uint8Array(64);
  for (let index = 0; index < 64; index++) binaer[index] = 0x80 + (index % 64);
  assert.equal(asInvoiceXml(binaer), null);
  assert.equal(asInvoiceXml(new Uint8Array(0)), null);
});

test("Base64 in Bytes - gegen Buffer geprueft", () => {
  for (const probe of ["", "a", "ab", "abc", "abcd", "Hallo Welt", "Müller & Söhne", "%PDF-1.7\n%âã"]) {
    const erwartet = new Uint8Array(Buffer.from(probe, "utf8"));
    assert.deepEqual(base64ToBytes(Buffer.from(probe, "utf8").toString("base64")), erwartet, probe);
  }
  // Auch mit Zeilenumbruechen, wie manche Werkzeuge sie setzen.
  const lang = Buffer.from("x".repeat(200));
  const umbrochen = lang.toString("base64").replace(/(.{76})/g, "$1\n");
  assert.deepEqual(base64ToBytes(umbrochen), new Uint8Array(lang));
});

test("eine ganze ZUGFeRD-PDF ueber den Weg, den die App geht: Base64 -> Bytes -> XML", () => {
  const pdf = buildPdf({ attachment: xmlBytes, flate: true });
  const base64 = Buffer.from(pdf).toString("base64");
  const invoice = parseInvoiceXml(extractInvoiceXml(base64ToBytes(base64)).content);
  assert.equal(invoice.invoiceNumber, "RE-2026-0815");
});

test("kaputte Kodierung wird gemeldet", () => {
  assert.throws(() => base64ToBytes("!!!not base64!!!"), PdfError);
});
