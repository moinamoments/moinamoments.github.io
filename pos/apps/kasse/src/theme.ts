/**
 * Design-Token der Kasse.
 *
 * Bewusst produktneutral gehalten: die App wird von verschiedenen Betrieben
 * genutzt, also darf sie nicht nach einem davon aussehen. Die Akzentfarbe ist
 * das einzige, was ein Mandant spaeter setzen kann.
 *
 * Die Masse sind auf eine Hand am Verkaufsstand ausgelegt, nicht auf einen
 * Schreibtisch: Kacheln ab 96 px, Schaltflaechen ab 56 px Hoehe. Unter 44 px
 * trifft niemand mit Handschuhen oder klebrigen Fingern zuverlaessig.
 */

export const colors = {
  // Grundflaechen: dunkel, weil die Kasse oft in der Sonne steht und ein
  // heller Bildschirm dort schlechter lesbar ist als ein kontrastreicher.
  background: "#0F172A",
  surface: "#1B2537",
  surfaceRaised: "#263248",
  border: "#33415C",
  text: "#F1F5F9",
  textMuted: "#94A3B8",
  textOnAccent: "#0F172A",

  accent: "#38BDF8",
  accentDeep: "#0EA5E9",

  success: "#34D399",
  warning: "#FBBF24",
  danger: "#F87171",

  // Pfand hebt sich vom Warenumsatz ab - der Bediener soll es im Warenkorb
  // sofort als "kommt zurueck" erkennen.
  deposit: "#A78BFA",
} as const;

export const space = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

export const radius = { sm: 6, md: 10, lg: 14, pill: 999 } as const;

export const font = {
  small: 13,
  body: 15,
  label: 17,
  title: 20,
  amount: 26,
  amountLarge: 34,
} as const;

/** Mindestgroessen fuer Bedienung mit dem Finger. */
export const touch = { tile: 96, button: 56, row: 64 } as const;
