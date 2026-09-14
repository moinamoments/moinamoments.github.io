import { strict as assert } from "node:assert";
import test from "node:test";

import {
  MAX_XML_DEPTH,
  MAX_XML_NODES,
  XmlError,
  childNamed,
  childrenNamed,
  decodeEntities,
  findFirst,
  parseXml,
  path,
  textAt,
} from "./xml.ts";

test("ein einzelnes Element mit Text", () => {
  const root = parseXml("<Rechnung>Hallo</Rechnung>");
  assert.equal(root.name, "Rechnung");
  assert.equal(root.text, "Hallo");
  assert.equal(root.children.length, 0);
});

test("die XML-Deklaration wird uebersprungen", () => {
  const root = parseXml('<?xml version="1.0" encoding="UTF-8"?><a>x</a>');
  assert.equal(root.name, "a");
});

test("das Byte-Vorzeichen am Dateianfang stoert nicht", () => {
  const root = parseXml('﻿<?xml version="1.0"?><a>x</a>');
  assert.equal(root.name, "a");
});

test("Namensraumkuerzel werden abgeschnitten, der rohe Name bleibt erhalten", () => {
  const root = parseXml("<ram:SpecifiedTradeProduct><ram:Name>Kaffee</ram:Name></ram:SpecifiedTradeProduct>");
  assert.equal(root.name, "SpecifiedTradeProduct");
  assert.equal(root.rawName, "ram:SpecifiedTradeProduct");
  assert.equal(textAt(root, "Name"), "Kaffee");
});

test("Attribute, auch mit einfachen Anfuehrungszeichen", () => {
  const root = parseXml(`<a b="1" c='zwei' udt:format="102"/>`);
  assert.deepEqual({ ...root.attributes }, { b: "1", c: "zwei", format: "102" });
});

test("ein Groesserzeichen im Attributwert beendet den Tag nicht", () => {
  // Der Fall, an dem ein naives indexOf(">") scheitert.
  const root = parseXml('<a title="5 > 3">x</a>');
  assert.equal(root.attributes.title, "5 > 3");
  assert.equal(root.text, "x");
});

test("leeres Element in beiden Schreibweisen", () => {
  assert.equal(parseXml("<a/>").text, "");
  assert.equal(parseXml("<a></a>").text, "");
});

test("Leerraum zwischen Elementen ist Formatierung, kein Text", () => {
  const root = parseXml("<a>\n  <b>1</b>\n  <b>2</b>\n</a>");
  assert.equal(root.text, "");
  assert.deepEqual(
    childrenNamed(root, "b").map((child) => child.text),
    ["1", "2"],
  );
});

test("Kommentare werden uebersprungen", () => {
  const root = parseXml("<a><!-- <b>nicht</b> -->text</a>");
  assert.equal(root.children.length, 0);
  assert.equal(root.text, "text");
});

test("CDATA wird roh uebernommen", () => {
  const root = parseXml("<a><![CDATA[<b> & ]]></a>");
  assert.equal(root.text, "<b> &");
  assert.equal(root.children.length, 0);
});

test("die fuenf eingebauten Entitaeten und Zahlenverweise", () => {
  assert.equal(decodeEntities("&amp;&lt;&gt;&quot;&apos;"), `&<>"'`);
  assert.equal(decodeEntities("&#8364;"), "€");
  assert.equal(decodeEntities("&#x20AC;"), "€");
  assert.equal(parseXml("<a>M&#252;ller &amp; Sohn</a>").text, "Müller & Sohn");
});

test("eine unbekannte Entitaet bleibt stehen, statt die Rechnung zu verwerfen", () => {
  // In einem Artikelnamen ist ein einzelnes & haeufiger als ein Angriff.
  assert.equal(decodeEntities("Tee &foo; Kaffee"), "Tee &foo; Kaffee");
});

test("ein Zahlenverweis auf ein Ersatzzeichen wird nicht aufgeloest", () => {
  assert.equal(decodeEntities("&#xD800;"), "&#xD800;");
  assert.equal(decodeEntities("&#x110000;"), "&#x110000;");
});

test("DOCTYPE wird abgewiesen - XXE und die Milliarde Lacher", () => {
  const boese = `<?xml version="1.0"?>
<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>
<foo>&xxe;</foo>`;
  assert.throws(() => parseXml(boese), (error: unknown) => error instanceof XmlError && /DOCTYPE/.test((error as Error).message));
});

test("Verschachtelung wird richtig aufgebaut", () => {
  const root = parseXml("<a><b><c>tief</c></b></a>");
  assert.equal(textAt(root, "b", "c"), "tief");
  assert.equal(path(root, "b", "c")?.name, "c");
  assert.equal(path(root, "b", "x"), null);
  assert.equal(textAt(root, "b", "x"), null);
});

test("childNamed und childrenNamed suchen nur eine Ebene tief", () => {
  const root = parseXml("<a><b><b>innen</b></b></a>");
  assert.equal(childrenNamed(root, "b").length, 1);
  assert.equal(childNamed(root, "c"), null);
});

test("findFirst sucht in jeder Tiefe", () => {
  const root = parseXml("<a><b><c><Ziel>hier</Ziel></c></b></a>");
  assert.equal(findFirst(root, "Ziel")?.text, "hier");
  assert.equal(findFirst(root, "Nichts"), null);
});

test("ein nicht geschlossenes Element ist ein Fehler", () => {
  assert.throws(() => parseXml("<a><b></a>"), XmlError);
  assert.throws(() => parseXml("<a>"), XmlError);
});

test("ein schliessendes Element ohne oeffnendes ist ein Fehler", () => {
  assert.throws(() => parseXml("<a></a></b>"), XmlError);
});

test("zwei Wurzelelemente sind ein Fehler", () => {
  assert.throws(() => parseXml("<a/><b/>"), XmlError);
});

test("Text ausserhalb eines Elements ist ein Fehler", () => {
  assert.throws(() => parseXml("Hallo<a/>"), XmlError);
  assert.throws(() => parseXml("<a/>Hallo"), XmlError);
});

test("eine leere Datei ist ein Fehler mit klarem Text", () => {
  assert.throws(() => parseXml("   "), (error: unknown) => error instanceof XmlError && /kein XML/.test((error as Error).message));
});

test("ein Attribut ohne Anfuehrungszeichen wird abgewiesen", () => {
  assert.throws(() => parseXml("<a b=1/>"), XmlError);
});

test("zu tiefe Schachtelung wird abgewiesen, bevor der Aufrufstapel voll ist", () => {
  const tief = "<a>".repeat(MAX_XML_DEPTH + 2) + "</a>".repeat(MAX_XML_DEPTH + 2);
  assert.throws(() => parseXml(tief), (error: unknown) => error instanceof XmlError && /tief/.test((error as Error).message));
});

test("zu viele Knoten werden abgewiesen", () => {
  const viele = `<a>${"<b/>".repeat(MAX_XML_NODES + 1)}</a>`;
  assert.throws(() => parseXml(viele), (error: unknown) => error instanceof XmlError && /viele Elemente/.test((error as Error).message));
});

test("eine zu grosse Datei wird gar nicht erst gelesen", () => {
  assert.throws(() => parseXml("x".repeat(8_000_001)), (error: unknown) => error instanceof XmlError && /zu gross/.test((error as Error).message));
});

test("ein Ausschnitt einer echten CII-Rechnung geht auf", () => {
  const cii = `<?xml version="1.0" encoding="UTF-8"?>
<rsm:CrossIndustryInvoice xmlns:rsm="urn:un:unece:uncefact:data:standard:CrossIndustryInvoice:100"
                          xmlns:ram="urn:un:unece:uncefact:data:standard:ReusableAggregateBusinessInformationEntity:100">
  <rsm:ExchangedDocument>
    <ram:ID>RE-2026-0815</ram:ID>
    <ram:IssueDateTime><udt:DateTimeString format="102">20260914</udt:DateTimeString></ram:IssueDateTime>
  </rsm:ExchangedDocument>
  <rsm:SupplyChainTradeTransaction>
    <ram:IncludedSupplyChainTradeLineItem>
      <ram:SpecifiedTradeProduct><ram:Name>Cola 0,33 l</ram:Name></ram:SpecifiedTradeProduct>
    </ram:IncludedSupplyChainTradeLineItem>
  </rsm:SupplyChainTradeTransaction>
</rsm:CrossIndustryInvoice>`;
  const root = parseXml(cii);
  assert.equal(root.name, "CrossIndustryInvoice");
  assert.equal(textAt(root, "ExchangedDocument", "ID"), "RE-2026-0815");
  assert.equal(findFirst(root, "DateTimeString")?.attributes.format, "102");
  assert.equal(findFirst(root, "DateTimeString")?.text, "20260914");
  assert.equal(findFirst(root, "Name")?.text, "Cola 0,33 l");
});
