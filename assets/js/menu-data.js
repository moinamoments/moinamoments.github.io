/* ==========================================================================
   MOINA – Speisekarte
   --------------------------------------------------------------------------
   Diese Datei ist die einzige Stelle, die für die Speisekarte geändert
   werden muss – sie speist sowohl die Karte auf der Website als auch die
   strukturierten Daten für Google (siehe initMenuSchema in main.js).

   Aufbau eines Eintrags:
     { name: "Bezeichnung", desc: "Kurzbeschreibung", price: "4,50 €", tag: "Neu" }

   - price: weglassen oder "" -> es wird PRICE_PLACEHOLDER angezeigt ("—")
   - tag:   optional, z. B. "Beliebt", "Neu", "Vegan", "Saison"
   - note:  optionaler Hinweis über der Kategorie (z. B. wechselndes Angebot)
   ========================================================================== */

const PRICE_PLACEHOLDER = "—";

const MENU = [
  {
    id: "crepes-suess",
    label: "Crêpes süß",
    items: [
      { name: "Zimt & Zucker",        desc: "Der Klassiker – hauchdünn, frisch von der Platte.", price: "4,50 €", tag: "Klassiker" },
      { name: "Nutella",              desc: "Warm verstrichen, bis sie glänzt.",                 price: "5,00 €" },
      { name: "Joghurette",           desc: "Geschmolzene Joghurette – fruchtig und cremig.",    price: "5,50 €" },
      { name: "Kinderriegel",         desc: "Geschmolzener Kinderriegel, warm verstrichen.",     price: "5,50 €", tag: "Beliebt" },
      { name: "Karamell & Meersalz",  desc: "Salzkaramell mit Sahnehaube.",                      price: "5,00 €" },
      { name: "Lotus Biscoff",        desc: "Cremiger Lotus-Biscoff-Aufstrich, warm verstrichen, mit zerbröseltem Karamellkeks.", price: "5,00 €", tag: "Neu" }
    ]
  },
  {
    id: "crepes-herzhaft",
    label: "Crêpes herzhaft",
    items: [
      { name: "Käse",                 desc: "Geschmolzener Käse, frische Kräuter.",     price: "5,00 €", tag: "Vegetarisch" },
      { name: "Frischkäse & Zwiebeln",desc: "Frischkäse mit fein gewürfelten Zwiebeln.", price: "6,00 €", tag: "Vegetarisch" },
      { name: "Tomate & Feta",        desc: "Tomate, Feta, Basilikum-Öl.",               price: "6,50 €", tag: "Vegetarisch" }
    ]
  },
  {
    id: "mutzen",
    label: "Mutzen",
    note: "Churros oder Mutzen – wir wechseln je nach Standort ab. Was heute dabei ist, steht auf Instagram.",
    items: [
      { name: "Mutzen klassisch",     desc: "Frisch ausgebacken, mit Puderzucker bestäubt.", price: "4,50 €", tag: "Klassiker" },
      { name: "Mutzen Zimt & Zucker", desc: "Noch warm in Zimt-Zucker gewendet.",             price: "4,80 €" },
      { name: "Mutzen mit Nutella",   desc: "Portion Mutzen mit warmem Nutella zum Dippen.",  price: "5,00 €" },
      { name: "Mutzen-Tüte to go",    desc: "Große Tüte zum Teilen – oder auch nicht.",       price: "7,00 €" }
    ]
  },
  {
    id: "churros",
    label: "Churros",
    note: "Churros oder Mutzen – wir wechseln je nach Standort ab. Was heute dabei ist, steht auf Instagram.",
    items: [
      { name: "Churros klassisch",    desc: "Knusprig gebacken, in Zimt-Zucker gewälzt.", price: "5,00 €", tag: "Klassiker" },
      { name: "Churros mit Nutella",  desc: "Mit warmem Nutella zum Dippen.",             price: "5,50 €", tag: "Beliebt" },
      { name: "Churros Karamell",     desc: "Mit Salzkaramell-Sauce.",                    price: "5,50 €" },
      { name: "Churros Deluxe",       desc: "Doppelte Portion, zwei Saucen nach Wahl.",   price: "9,00 €" }
    ]
  },
  {
    id: "toppings",
    label: "Toppings",
    note: "Zum Draufstreuen – auf Crêpes, Mutzen oder Churros.",
    items: [
      { name: "Geröstete Haselnüsse", desc: "Frisch geröstet und grob gehackt.", price: "0,80 €" },
      { name: "Krokant",              desc: "Knuspriger Nusskrokant.",           price: "0,70 €" },
      { name: "Schokostreusel",       desc: "Feine Schokostreusel.",             price: "0,70 €" }
    ]
  },
  {
    id: "kaffee-tee",
    label: "Kaffee & Tee",
    items: [
      { name: "Espresso",             desc: "Kräftig und kurz.",                    price: "1,50 €" },
      { name: "Café Crème",           desc: "Mild und ausgewogen.",                 price: "2,50 €" },
      { name: "Cappuccino",           desc: "Mit feinporigem Milchschaum.",         price: "3,00 €" },
      { name: "Latte Macchiato",      desc: "Im großen Becher, in Schichten.",      price: "3,50 €" },
      { name: "Heiße Schokolade",     desc: "Mit Milch, auf Wunsch mit Sahnehaube.",price: "3,00 €" },
      { name: "Teeauswahl",           desc: "Schwarz, grün, Kräuter oder Früchte.", price: "2,00 €" }
    ]
  },
  {
    id: "kalt",
    label: "Kaltgetränke",
    items: [
      { name: "Hausgemachte Limonade",desc: "Wechselnde Sorten der Saison.",             price: "3,00 €", tag: "Saison" },
      { name: "Apfelschorle",         desc: "Spritzig, nicht zu süß.",                   price: "2,50 €" },
      { name: "Softdrinks",           desc: "Auswahl klassischer Erfrischungsgetränke.", price: "3,00 €" },
      { name: "Wasser still / medium",desc: "0,33 l und 0,5 l.",                         price: "2,00 €" }
    ]
  }
];
