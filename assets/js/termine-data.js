/* ==========================================================================
   MOINA – Termine & Standorte
   --------------------------------------------------------------------------
   Die einzige Stelle, an der Termine gepflegt werden. Daraus entstehen die
   Karten im Abschnitt „Wo ihr uns findet“ und die Veranstaltungsdaten für
   Google (JSON-LD, siehe initTermine in main.js).

   Vergangene Termine verschwinden automatisch, sobald ihre Endzeit vorbei
   ist – alte Einträge stören also nicht, können aber gelegentlich raus.

   Aufbau eines Eintrags:
     {
       datum:   "2026-10-17",              // JJJJ-MM-TT
       von:     "08:00",  bis: "13:00",    // Uhrzeit in Kieler Zeit
       titel:   "Markt am Exerzierplatz",
       ort:     "Exerzierplatz",           // Platz oder Straße
       stadt:   "Kiel",
       hinweis: ""                         // optional, z. B. "nur Mutzen"
     }
   ========================================================================== */

const TERMINE = [
  {
    datum: "2026-10-17",
    von: "08:00",
    bis: "13:00",
    titel: "Markt am Exerzierplatz",
    ort: "Exerzierplatz",
    stadt: "Kiel"
  }
];
