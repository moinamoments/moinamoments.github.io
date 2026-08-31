/* ==========================================================================
   MOINA – Speisekarte (PLATZHALTER)
   --------------------------------------------------------------------------
   Diese Datei ist die einzige Stelle, die für die Speisekarte geändert
   werden muss. Später einfach Namen, Beschreibungen und Preise ersetzen.

   Aufbau eines Eintrags:
     { name: "Bezeichnung", desc: "Kurzbeschreibung", price: "4,50 €", tag: "Neu" }

   - price: weglassen oder "" -> es wird PRICE_PLACEHOLDER angezeigt ("—")
   - tag:   optional, z. B. "Beliebt", "Neu", "Vegan", "Saison"
   ========================================================================== */

const PRICE_PLACEHOLDER = "—";

const MENU = [
  {
    id: "crepes-suess",
    label: "Crêpes süß",
    items: [
      { name: "Zimt & Zucker",        desc: "Der Klassiker – hauchdünn, frisch von der Platte.", tag: "Klassiker" },
      { name: "Nutella",              desc: "Warm verstrichen, bis sie glänzt." },
      { name: "Joghurette",           desc: "Geschmolzene Joghurette – fruchtig und cremig." },
      { name: "Kinderriegel",         desc: "Geschmolzener Kinderriegel, warm verstrichen.", tag: "Beliebt" },
      { name: "Karamell & Meersalz",  desc: "Salzkaramell mit Sahnehaube." },
      { name: "Lotus Biscoff",        desc: "Cremiger Lotus-Biscoff-Aufstrich, warm verstrichen, mit zerbröseltem Karamellkeks.", tag: "Neu" }
    ]
  },
  {
    id: "crepes-herzhaft",
    label: "Crêpes herzhaft",
    items: [
      { name: "Käse",                 desc: "Geschmolzener Käse, frische Kräuter.", tag: "Vegetarisch" },
      { name: "Frischkäse & Zwiebeln",desc: "Frischkäse mit fein gewürfelten Zwiebeln.", tag: "Vegetarisch" },
      { name: "Tomate & Feta",        desc: "Tomate, Feta, Basilikum-Öl.", tag: "Vegetarisch" }
    ]
  },
  {
    id: "mutzen",
    label: "Mutzen",
    note: "Churros oder Mutzen – wir wechseln je nach Standort ab. Was heute dabei ist, steht auf Instagram.",
    items: [
      { name: "Mutzen klassisch",     desc: "Frisch ausgebacken, mit Puderzucker bestäubt.", tag: "Klassiker" },
      { name: "Mutzen Zimt-Zucker",   desc: "Noch warm in Zimt-Zucker gewendet." },
      { name: "Mutzen mit Schoko-Dip",desc: "Portion Mutzen mit warmer Schokoladensauce." },
      { name: "Mutzen-Tüte to go",    desc: "Große Tüte zum Teilen – oder auch nicht." }
    ]
  },
  {
    id: "churros",
    label: "Churros",
    note: "Churros oder Mutzen – wir wechseln je nach Standort ab. Was heute dabei ist, steht auf Instagram.",
    items: [
      { name: "Churros klassisch",    desc: "Knusprig gebacken, in Zimt-Zucker gewälzt.", tag: "Klassiker" },
      { name: "Churros mit Schokosauce", desc: "Mit warmer Schokolade zum Dippen.", tag: "Beliebt" },
      { name: "Churros Karamell",     desc: "Mit Salzkaramell-Sauce und Nusskrokant." },
      { name: "Churros Deluxe",       desc: "Doppelte Portion, zwei Saucen nach Wahl." }
    ]
  },
  {
    id: "toppings",
    label: "Toppings",
    items: [
      { name: "Geröstete Haselnüsse", desc: "Frisch geröstet und grob gehackt." },
      { name: "Krokant",              desc: "Knuspriger Nusskrokant." },
      { name: "Schokostreusel",       desc: "Feine Schokostreusel." }
    ]
  },
  {
    id: "kaffee-tee",
    label: "Kaffee & Tee",
    items: [
      { name: "Espresso",             desc: "Einfach oder doppelt." },
      { name: "Café Crème",           desc: "Mild und ausgewogen." },
      { name: "Cappuccino",           desc: "Mit feinporigem Milchschaum." },
      { name: "Latte Macchiato",      desc: "In Schichten, im Glas." },
      { name: "Heiße Schokolade",     desc: "Auf Wunsch mit Sahnehaube." },
      { name: "Teeauswahl",           desc: "Schwarz, grün, Kräuter oder Früchte." }
    ]
  },
  {
    id: "kalt",
    label: "Kaltgetränke",
    items: [
      { name: "Hausgemachte Limonade",desc: "Wechselnde Sorten der Saison.", tag: "Saison" },
      { name: "Apfelschorle",         desc: "Spritzig, nicht zu süß." },
      { name: "Softdrinks",           desc: "Auswahl klassischer Erfrischungsgetränke." },
      { name: "Wasser still / medium",desc: "0,33 l und 0,5 l." }
    ]
  }
];
