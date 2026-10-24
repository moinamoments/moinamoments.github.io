/* ==========================================================================
   MOINA – Termine & Standorte
   --------------------------------------------------------------------------
   Die einzige Stelle, an der Termine gepflegt werden. Daraus entstehen die
   Karten im Abschnitt „Wo ihr uns findet“, die Ankündigung im Startbereich
   und die Veranstaltungsdaten für Google (JSON-LD, siehe initTermine in
   main.js). Vergangene Termine verschwinden automatisch.

   EINZELTERMIN (z. B. Stadtfest):
     {
       datum:   "2026-11-14",              // JJJJ-MM-TT
       von:     "11:00",  bis: "18:00",    // Uhrzeit in Kieler Zeit
       titel:   "Martinsmarkt",
       ort:     "Rathausplatz",            // Platz oder Straße
       stadt:   "Kiel"
     }

   REGELMÄSSIGER TERMIN (jede Woche am selben Tag):
     {
       jeden:   "Samstag",                 // Montag … Sonntag
       von:     "08:00",  bis: "13:00",
       titel:   "Markt am Exerzierplatz",
       ort:     "Exerzierplatz",
       stadt:   "Kiel",
       ab:      "2026-10-24",              // optional: erster Termin
       endet:   "2027-03-27",              // optional: letzter Termin
       ausser:  ["2026-12-26"]             // optional: ausfallende Tage
     }

   Für beide optional:
       hinweis:      "nur Mutzen"          // zusätzliche Zeile auf der Karte
       ankuendigung: true                  // zusätzlich oben im Startbereich
   ========================================================================== */

const TERMINE = [
  {
    jeden: "Samstag",
    von: "08:00",
    bis: "13:00",
    titel: "Markt am Exerzierplatz",
    ort: "Exerzierplatz",
    stadt: "Kiel",
    ankuendigung: true
  }
];
