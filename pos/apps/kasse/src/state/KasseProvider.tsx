/**
 * Zustand der Kasse.
 *
 * Eine einzige Stelle, an der Kern (@kp/core), Datenbank und Bildschirm
 * zusammenkommen. Die Bildschirmseiten enthalten selbst keine Rechen- und
 * keine Rechtslogik - sie rufen hier Aktionen auf und zeigen an, was
 * zurueckkommt. Das ist der Grund, warum die Summen- und Steuerlogik
 * vollstaendig ohne React getestet werden kann.
 *
 * Wichtig ist die Reihenfolge beim Bezahlen. `pay()` macht genau das, was die
 * KassenSichV verlangt, und in dieser Folge:
 *
 *   1. Belegnummer aus dem Nummernkreis des Geraets ziehen
 *   2. TSE-Transaktion abschliessen (oder den Ausfall dokumentieren)
 *   3. Beleg in die Datenbank schreiben - unteilbar
 *   4. Beleg in die Outbox legen
 *   5. erst danach den Warenkorb leeren
 *
 * Schlaegt Schritt 3 fehl, ist kein Beleg entstanden und der Warenkorb steht
 * unveraendert da: der Bediener kann es erneut versuchen, ohne dass Ware oder
 * Geld verloren geht.
 *
 * ## Anmeldung, Rechte und Sperre
 *
 * Wer angemeldet ist, entscheidet hier - nicht auf den Bildschirmseiten. Sie
 * fragen `can(...)` und blenden aus, was nicht erlaubt ist; die Aktionen hier
 * pruefen es zusaetzlich, weil ein ausgeblendeter Knopf keine Sicherung ist.
 *
 * Zwei Entscheidungen, die den Betrieb ernst nehmen:
 *
 *   - **Ohne vergebene PIN keine Anmeldepflicht.** Eine frisch eingerichtete
 *     Kasse muss benutzbar sein. Erst wenn ein Bediener eine PIN hat, wird
 *     angemeldet und gesperrt.
 *   - **Die Sperre wird beim Aufwachen gerechnet, nicht von einem Zeitgeber.**
 *     Das Betriebssystem haelt eine App im Hintergrund an; ein `setInterval`
 *     laeuft dann nicht weiter und die Kasse waere nach zwei Stunden in der
 *     Tasche unversperrt.
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import {
  type AuditEvent,
  type Capability,
  type Cart,
  type CashMovement,
  type CashMovementType,
  type CashCountEntry,
  type Category,
  type CustomerContact,
  type DeliveryChannel,
  type Device,
  type DepositCatalog,
  type DepositItem,
  type LockState,
  type Order,
  type ParkedSale,
  type PaymentIntent,
  type Product,
  type Quantity,
  type ServiceMode,
  type Store,
  type Tenant,
  type TseClient,
  type User,
  type CartTotals,
  type VoidSelection,
  DEFAULT_LOCK_POLICY,
  MockTse,
  ONE,
  PIN_ITERATIONS,
  addDepositReturn,
  addFreeLine,
  addProduct as addProductToCart,
  attemptLogin,
  beginTransaction,
  buildAuditEntry,
  buildCashMovement,
  buildPartialVoidCart,
  buildReceiptView,
  buildVoidCart,
  cartTotals,
  changeQuantity,
  clearLines,
  createDepositCatalog,
  describeLoginOutcome,
  effectiveCapabilities,
  emptyCart,
  finishTransaction,
  hashPin,
  isoWithOffset,
  openDay,
  outboxKey,
  parkSale,
  prepareDelivery,
  recordDelivery,
  removeLine as removeCartLine,
  requireCapability,
  resumeSale,
  setLineDiscount,
  setOrderDiscount,
  setQuantity,
  setServiceMode as setCartServiceMode,
  setWaiveDeposit,
  shouldLock,
  sortParkedSales,
  systemClock,
  touchActivity,
  userCan,
  movementsForOrder,
  type OpenTransaction,
  type StockMovement,
} from "@kp/core";
import { type Db, openDb } from "../db/database.ts";
import {
  appendAudit,
  appendCashMovement,
  appendDelivery,
  applyStockMovement,
  countOutbox,
  deleteParkedSale,
  getDevice,
  getLoginAttempts,
  getStore,
  getTenant,
  listCategories,
  listOpenCashMovements,
  listParkedSales,
  listProducts,
  listUsers,
  nextSequence,
  saveLoginAttempts,
  saveOrder,
  saveParkedSale,
  saveUser,
  upsertOutboxEntry,
} from "../db/repositories.ts";
import { ensureSeeded, isPlaceholderTenant } from "./seed.ts";

/** Ids werden auf dem Geraet erzeugt, damit offline Belege entstehen koennen. */
function newId(): string {
  // `crypto.randomUUID` ist in Hermes nicht ueberall vorhanden; der Rueckfall
  // erzeugt eine ausreichend eindeutige Id aus Zeit und Zufall.
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Ergebnis einer Anmeldung, so wie der Anmeldebildschirm es braucht. */
export interface LoginResult {
  readonly ok: boolean;
  /** Meldung im Klartext - bei Erfolg leer. */
  readonly message: string;
}

export interface KasseState {
  readonly ready: boolean;
  readonly error: string | null;
  readonly tenant: Tenant | null;
  readonly store: Store | null;
  readonly device: Device | null;
  /** Der angemeldete Bediener; `null`, solange niemand angemeldet ist. */
  readonly user: User | null;
  /** Alle aktiven Bediener - fuer die Auswahl beim Anmelden. */
  readonly users: readonly User[];
  /**
   * Muss sich jemand anmelden? Nur wenn mindestens ein Bediener eine PIN hat.
   * Eine Kasse, die gerade eingerichtet wird, soll nicht aussperren.
   */
  readonly loginRequired: boolean;
  /** Gesperrt: es ist niemand angemeldet, obwohl es noetig waere. */
  readonly locked: boolean;
  /** Grund der Sperre im Klartext, fuer den Anmeldebildschirm. */
  readonly lockNotice: string | null;
  readonly categories: readonly Category[];
  readonly products: readonly Product[];
  readonly deposits: DepositCatalog;
  readonly cart: Cart;
  readonly totals: CartTotals;
  /** Geparkte Vorgaenge dieser Kasse, aelteste zuerst. */
  readonly parked: readonly ParkedSale[];
  /** Bargeldbewegungen der laufenden Schicht. */
  readonly cashMovements: readonly CashMovement[];
  /** Ist die Kasse eingerichtet, oder stehen noch Platzhalterdaten drin? */
  readonly needsSetup: boolean;
  readonly tseOnline: boolean;
  readonly outboxPending: number;
  /** Der letzte abgeschlossene Beleg, fuer die Bonanzeige. */
  readonly lastOrder: Order | null;
  readonly busy: boolean;
}

export interface KasseActions {
  // --- Anmeldung ---------------------------------------------------------
  login(userId: string, pin: string): Promise<LoginResult>;
  logout(): Promise<void>;
  /** Von Hand sperren - der Knopf fuer "ich gehe kurz weg". */
  lock(): Promise<void>;
  /** Bedienung melden, damit die Untaetigkeitssperre nicht zuschlaegt. */
  touch(): void;
  /** Darf der angemeldete Bediener das? Ohne Anmeldung immer `false`. */
  can(capability: Capability): boolean;
  /** Rechte des angemeldeten Bedieners, fuer Anzeigen. */
  capabilities(): readonly Capability[];
  /** PIN eines Bedieners setzen oder entfernen. */
  setPin(userId: string, pin: string | null): Promise<void>;
  saveOperator(user: User): Promise<void>;

  // --- Erfassung ---------------------------------------------------------
  addProduct(product: Product, options?: { quantity?: Quantity; price?: number; note?: string }): void;
  addOpenAmount(name: string, price: number, taxKey: number): void;
  setQuantity(lineId: string, quantity: Quantity): void;
  changeQuantity(lineId: string, delta: Quantity): void;
  removeLine(lineId: string): void;
  clear(): void;
  setServiceMode(mode: ServiceMode): void;
  waiveDeposit(lineId: string, waive: boolean): void;
  returnDeposit(item: DepositItem, quantity?: Quantity): void;
  discountLine(lineId: string, amount: number): void;
  discountOrder(amount: number): void;

  // --- Abschluss ---------------------------------------------------------
  pay(payments: readonly PaymentIntent[], options?: { customerName?: string | null }): Promise<Order>;
  voidOrder(order: Order, reason: string): Promise<Order>;
  partialVoid(order: Order, selections: readonly VoidSelection[], reason: string): Promise<Order>;

  // --- Parken ------------------------------------------------------------
  park(label: string): Promise<ParkedSale>;
  resume(sale: ParkedSale): Promise<void>;
  discardParked(sale: ParkedSale): Promise<void>;

  // --- Kassenbuch --------------------------------------------------------
  addCashMovement(type: CashMovementType, amount: number, reason: string): Promise<CashMovement>;
  openCashDay(cashCount: readonly CashCountEntry[]): Promise<CashMovement>;

  // --- Bonversand --------------------------------------------------------
  sendReceipt(
    order: Order,
    channel: DeliveryChannel,
    contact: CustomerContact,
    open: (url: string) => Promise<boolean>,
  ): Promise<void>;

  /** Protokolleintrag schreiben - fuer Seiten, die selbst etwas aendern. */
  audit(event: AuditEvent, details?: { subject?: string | null; detail?: string | null; amount?: number | null }): Promise<void>;
  reload(): Promise<void>;
  /** Liefert die Datenbank fuer Seiten, die eigene Abfragen brauchen. */
  db(): Db;
  /** Aktuelle Uhrzeit in der Zeitzone des Betriebs. */
  now(): string;
}

const KasseContext = createContext<(KasseState & KasseActions) | null>(null);

export function useKasse(): KasseState & KasseActions {
  const context = useContext(KasseContext);
  if (!context) throw new Error("useKasse ausserhalb von <KasseProvider>");
  return context;
}

export function KasseProvider({ children, tse }: { children: React.ReactNode; tse?: TseClient }) {
  const [db, setDb] = useState<Db | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [store, setStore] = useState<Store | null>(null);
  const [device, setDevice] = useState<Device | null>(null);
  const [user, setUser] = useState<User | null>(null);
  const [users, setUsers] = useState<readonly User[]>([]);
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [products, setProducts] = useState<readonly Product[]>([]);
  const [parked, setParked] = useState<readonly ParkedSale[]>([]);
  const [cashMovements, setCashMovements] = useState<readonly CashMovement[]>([]);
  const [cart, setCart] = useState<Cart>(() => emptyCart("", "TAKEAWAY"));
  const [tseOnline, setTseOnline] = useState(false);
  const [outboxPending, setOutboxPending] = useState(0);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);
  const [lockNotice, setLockNotice] = useState<string | null>(null);

  /**
   * Die TSE. Ohne konfigurierten Anbieter laeuft die Test-TSE - erkennbar an
   * der Seriennummer, die "TEST-TSE" enthaelt und so auf jedem Bon auffaellt.
   */
  const tseClient = useMemo<TseClient>(() => tse ?? new MockTse({ clock: systemClock() }), [tse]);

  const clock = useMemo(() => systemClock(tenant?.timeZone ?? "Europe/Berlin"), [tenant?.timeZone]);

  /**
   * Die laufende TSE-Transaktion.
   *
   * Sie beginnt, sobald die erste Position im Warenkorb landet - nicht beim
   * Bezahlen. Sonst stuende auf dem Bon eine Startzeit, die nach der
   * tatsaechlichen Erfassung liegt.
   */
  const openTransaction = useRef<OpenTransaction | null>(null);

  /**
   * Letzte Bedienung, fuer die Untaetigkeitssperre.
   *
   * Als Ref und nicht als State: jeder Tastendruck wuerde sonst die ganze
   * Oberflaeche neu zeichnen, und an der Kasse wird schnell getippt.
   */
  const activity = useRef<LockState>({
    lastActivityAt: isoWithOffset(new Date(), "Europe/Berlin"),
    locked: false,
    hasOpenCart: false,
  });

  const deposits = useMemo<DepositCatalog>(() => {
    try {
      return createDepositCatalog([...products]);
    } catch (issue) {
      // Ein fehlerhafter Pfandverweis darf die Kasse nicht lahmlegen, muss
      // aber sichtbar werden.
      setError(`Pfandzuordnung fehlerhaft: ${(issue as Error).message}`);
      return { for: () => [], all: () => [] };
    }
  }, [products]);

  const totals = useMemo(
    () => cartTotals(cart, { smallBusiness: tenant?.smallBusiness ?? false, deposits }),
    [cart, deposits, tenant?.smallBusiness],
  );

  /**
   * Anmeldepflicht.
   *
   * Sie entsteht mit der ersten vergebenen PIN. Bis dahin arbeitet die Kasse
   * ohne Anmeldung - sonst waere der erste Start eine Sackgasse.
   */
  const loginRequired = useMemo(() => users.some((item) => !!item.pinHash), [users]);
  const locked = loginRequired && user === null;

  const load = useCallback(async (handle: Db) => {
    const [loadedTenant, loadedStore, loadedDevice, loadedUsers, loadedCategories, loadedProducts, pending] =
      await Promise.all([
        getTenant(handle),
        getStore(handle),
        getDevice(handle),
        listUsers(handle),
        listCategories(handle),
        listProducts(handle),
        countOutbox(handle),
      ]);
    setTenant(loadedTenant);
    setStore(loadedStore);
    setDevice(loadedDevice);
    setUsers(loadedUsers);
    setCategories(loadedCategories);
    setProducts(loadedProducts);
    setOutboxPending(pending);

    if (loadedDevice) {
      setParked(sortParkedSales(await listParkedSales(handle, loadedDevice.id)));
      setCashMovements(await listOpenCashMovements(handle, loadedDevice.id));
    }

    // Der angemeldete Bediener wird nachgeladen: seine Rechte koennen sich
    // geaendert haben, waehrend er angemeldet ist.
    setUser((current) => {
      if (!current) {
        // Ohne vergebene PIN gibt es keine Anmeldung - dann arbeitet die Kasse
        // unter dem ersten Bediener, damit sie ueberhaupt benutzbar ist.
        return loadedUsers.some((item) => item.pinHash) ? null : loadedUsers[0] ?? null;
      }
      const fresh = loadedUsers.find((item) => item.id === current.id);
      // Wurde er inzwischen deaktiviert, ist er abgemeldet. Genau dafuer ist
      // das Deaktivieren da.
      return fresh ?? null;
    });

    if (loadedTenant) {
      setCart((current) => (current.tenantId === loadedTenant.id ? current : emptyCart(loadedTenant.id, "TAKEAWAY")));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const handle = await openDb();
        await ensureSeeded(handle, isoWithOffset(new Date(), "Europe/Berlin"), newId);
        if (cancelled) return;
        setDb(handle);
        await load(handle);
        setTseOnline(await tseClient.isAvailable());
        if (!cancelled) setReady(true);
      } catch (issue) {
        if (!cancelled) {
          setError((issue as Error).message);
          setReady(true);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [load, tseClient]);

  /** Erreichbarkeit der TSE regelmaessig pruefen, damit der Status stimmt. */
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      void tseClient.isAvailable().then(setTseOnline);
    }, 30_000);
    return () => clearInterval(timer);
  }, [ready, tseClient]);

  const nowIso = useCallback(() => clock.now(), [clock]);

  /** Protokolleintrag schreiben. */
  const writeAudit = useCallback(
    async (
      handle: Db,
      actor: User | null,
      event: AuditEvent,
      details: { subject?: string | null; detail?: string | null; amount?: number | null } = {},
    ): Promise<void> => {
      if (!tenant || !device) return;
      try {
        await appendAudit(
          handle,
          buildAuditEntry({
            id: newId(),
            tenantId: tenant.id,
            deviceId: device.id,
            userId: actor?.id ?? null,
            userName: actor?.name ?? null,
            event,
            subject: details.subject ?? null,
            detail: details.detail ?? null,
            amount: details.amount ?? null,
            createdAt: nowIso(),
          }),
        );
      } catch (issue) {
        // Ein fehlgeschlagener Protokolleintrag darf den Vorgang nicht
        // abbrechen: der Verkauf ist wichtiger als seine Protokollzeile. Er
        // wird aber gemeldet, damit es nicht unbemerkt bleibt.
        setError(`Protokolleintrag fehlgeschlagen: ${(issue as Error).message}`);
      }
    },
    [device, nowIso, tenant],
  );

  /**
   * Sperre pruefen und bei Bedarf abmelden.
   *
   * Wird beim Aufwachen aus dem Hintergrund und beim Wechsel der Seite
   * aufgerufen - nicht von einem Zeitgeber, der im Hintergrund stillsteht.
   */
  const evaluateLock = useCallback(
    (status: AppStateStatus | "foreground") => {
      if (!loginRequired || !user) return;
      const state: LockState = { ...activity.current, hasOpenCart: cart.lines.length > 0 };
      const transition = status === "background" || status === "inactive" ? "background" : "foreground";
      const decision = shouldLock(state, DEFAULT_LOCK_POLICY, nowIso(), transition);
      if (!decision.lock) return;

      activity.current = { ...state, locked: true };
      setUser(null);
      setLockNotice(
        decision.reason === "BACKGROUND"
          ? "Die Kasse wurde beim Wechsel in den Hintergrund gesperrt."
          : "Die Kasse wurde nach Inaktivitaet gesperrt.",
      );
      if (db) void writeAudit(db, user, "DEVICE_LOCKED", { detail: decision.reason });
    },
    [cart.lines.length, db, loginRequired, nowIso, user, writeAudit],
  );

  /**
   * Auf den Wechsel in den Hintergrund und zurueck hoeren.
   *
   * Der Punkt ist das Zurueckkommen: dort wird gerechnet, wie lange die App
   * weg war. Ein Tablet, das drei Stunden auf dem Tisch lag, muss die PIN
   * verlangen.
   */
  useEffect(() => {
    if (!ready) return;
    const subscription = AppState.addEventListener("change", (status) => {
      evaluateLock(status === "active" ? "foreground" : status);
    });
    return () => subscription.remove();
  }, [evaluateLock, ready]);

  /** Vorgang eroeffnen, sobald etwas erfasst wird. */
  const ensureTransaction = useCallback(async () => {
    if (openTransaction.current) return;
    if (!tenant || !store || !device || !user) return;
    openTransaction.current = await beginTransaction({
      tenant, store, device, user, clock, newId, tse: tseClient,
    });
  }, [clock, device, store, tenant, tseClient, user]);

  /**
   * Bestandsbewegungen eines Belegs buchen.
   *
   * Bewusst **nach** dem Speichern des Belegs und bewusst so, dass ein Fehler
   * hier den Beleg nicht zurueckrollt: der Verkauf hat stattgefunden, der
   * Beleg ist der Geschaeftsvorfall. Ein Bestand, der um eine Flasche
   * danebenliegt, ist ein Aergernis - ein verlorener Beleg ist ein Verstoss
   * gegen die Aufzeichnungspflicht.
   */
  const bookStock = useCallback(
    async (handle: Db, order: Order, userId: string): Promise<void> => {
      const relevant = products.filter((product) => product.trackStock);
      if (relevant.length === 0) return;
      try {
        const movements = movementsForOrder(order, products, { newId, userId });
        for (const result of movements) {
          await applyStockMovement(handle, result.movement satisfies StockMovement);
        }
      } catch (issue) {
        setError(`Bestand konnte nicht fortgeschrieben werden: ${(issue as Error).message}`);
      }
    },
    [products],
  );

  const actions = useMemo<KasseActions>(() => {
    const requireDb = (): Db => {
      if (!db) throw new Error("Die Datenbank ist noch nicht bereit");
      return db;
    };

    /** Angemeldeter Bediener oder Abbruch mit einer Meldung, die weiterhilft. */
    const requireUser = (): User => {
      if (!user) throw new Error("Bitte zuerst anmelden.");
      return user;
    };

    const requireSetup = (): { tenant: Tenant; store: Store; device: Device; user: User } => {
      if (!tenant || !store || !device) throw new Error("Die Kasse ist nicht vollstaendig eingerichtet");
      return { tenant, store, device, user: requireUser() };
    };

    /** Recht pruefen und die Verweigerung protokollieren. */
    const gate = (capability: Capability, attempted: string): User => {
      const actor = requireUser();
      if (!userCan(actor, capability)) {
        if (db) void writeAudit(db, actor, "ACCESS_DENIED", { subject: attempted, detail: `Fehlendes Recht: ${capability}` });
        requireCapability(actor, capability);
      }
      return actor;
    };

    const markActivity = (): void => {
      activity.current = touchActivity(activity.current, nowIso());
    };

    /** Beleg speichern, in die Outbox legen und den Bestand fortschreiben. */
    const persistOrder = async (handle: Db, order: Order, actor: User): Promise<void> => {
      await saveOrder(handle, order);
      await upsertOutboxEntry(handle, {
        key: outboxKey("order", order.id),
        kind: "order",
        entityId: order.id,
        tenantId: order.tenantId,
        payload: JSON.stringify(order),
        createdAt: order.paidAt ?? order.startedAt,
        attempts: 0,
        nextAttemptAt: order.paidAt ?? order.startedAt,
        lastError: null,
      });
      await bookStock(handle, order, actor.id);
    };

    return {
      // --- Anmeldung -----------------------------------------------------
      async login(userId, pin) {
        const handle = requireDb();
        if (!device) return { ok: false, message: "Die Kasse ist nicht eingerichtet." };
        const candidate = users.find((item) => item.id === userId);
        if (!candidate) return { ok: false, message: "Dieser Bediener ist nicht vorhanden." };

        const now = nowIso();
        const state = await getLoginAttempts(handle, candidate.id, device.id);
        const outcome = attemptLogin(candidate, pin, state, now);
        await saveLoginAttempts(handle, candidate.id, device.id, outcome.state, now);

        if (outcome.result === "OK" || outcome.result === "NO_PIN_SET") {
          activity.current = { lastActivityAt: now, locked: false, hasOpenCart: false };
          setUser(candidate);
          setLockNotice(null);
          await writeAudit(handle, candidate, "LOGIN_OK");

          // Die Rundenzahl steht im Hash. Wurde sie seit dem Setzen der PIN
          // erhoeht, wird beim naechsten erfolgreichen Anmelden neu gehasht -
          // der einzige Zeitpunkt, an dem die PIN im Klartext vorliegt.
          if (outcome.result === "OK" && outcome.needsRehash) {
            await saveUser(handle, { ...candidate, pinHash: hashPin(pin) }, { pinSetAt: now });
            await load(handle);
          }
          return { ok: true, message: "" };
        }

        await writeAudit(
          handle,
          candidate,
          outcome.result === "LOCKED" ? "LOGIN_LOCKED" : "LOGIN_FAILED",
          { subject: candidate.name },
        );
        return { ok: false, message: describeLoginOutcome(outcome) };
      },

      async logout() {
        const handle = db;
        const actor = user;
        // Ein offener Warenkorb geht beim Bedienerwechsel nicht verloren: er
        // wird verworfen, und das wird protokolliert. Alles andere waere ein
        // Beleg, der einem falschen Bediener zugeordnet wird.
        if (handle && actor) {
          if (cart.lines.length > 0) {
            await writeAudit(handle, actor, "SALE_DISCARDED", {
              detail: `${cart.lines.length} Positionen beim Abmelden verworfen`,
              amount: totals.total,
            });
          }
          await writeAudit(handle, actor, "LOGOUT");
        }
        openTransaction.current = null;
        if (tenant) setCart(emptyCart(tenant.id, cart.serviceMode));
        activity.current = { ...activity.current, locked: true };
        setUser(null);
        setLockNotice(null);
      },

      async lock() {
        const handle = db;
        const actor = user;
        if (handle && actor) await writeAudit(handle, actor, "DEVICE_LOCKED", { detail: "MANUAL" });
        activity.current = { ...activity.current, locked: true };
        setUser(null);
        setLockNotice("Die Kasse wurde gesperrt.");
      },

      touch() {
        markActivity();
      },

      can(capability) {
        return user ? userCan(user, capability) : false;
      },

      capabilities() {
        return user ? effectiveCapabilities(user) : [];
      },

      async setPin(userId, pin) {
        const handle = requireDb();
        const actor = gate("MANAGE_USERS", "PIN setzen");
        const target = users.find((item) => item.id === userId);
        if (!target) throw new Error("Dieser Bediener ist nicht vorhanden.");

        await saveUser(
          handle,
          { ...target, pinHash: pin === null ? null : hashPin(pin, { iterations: PIN_ITERATIONS }) },
          { pinSetAt: nowIso() },
        );
        // Im Protokoll steht, **dass** eine PIN gesetzt wurde - nie der Hash
        // und schon gar nicht die PIN.
        await writeAudit(handle, actor, "USER_CHANGED", {
          subject: target.name,
          detail: pin === null ? "PIN entfernt" : "PIN neu gesetzt",
        });
        await load(handle);
      },

      async saveOperator(operator) {
        const handle = requireDb();
        const actor = gate("MANAGE_USERS", `Bediener ${operator.name}`);
        const before = users.find((item) => item.id === operator.id);
        await saveUser(handle, operator);

        if (before && before.role !== operator.role) {
          await writeAudit(handle, actor, "ROLE_CHANGED", {
            subject: operator.name,
            detail: `${before.role} -> ${operator.role}`,
          });
        } else if (before && JSON.stringify(before.permissionOverrides ?? {}) !== JSON.stringify(operator.permissionOverrides ?? {})) {
          await writeAudit(handle, actor, "PERMISSION_CHANGED", { subject: operator.name });
        } else {
          await writeAudit(handle, actor, "USER_CHANGED", {
            subject: operator.name,
            detail: before ? (operator.active ? "geaendert" : "deaktiviert") : "angelegt",
          });
        }
        await load(handle);
      },

      // --- Erfassung -----------------------------------------------------
      addProduct(product, options = {}) {
        markActivity();
        void ensureTransaction();
        setCart((current) =>
          addProductToCart(current, product, {
            id: newId(),
            ...(options.quantity !== undefined ? { quantity: options.quantity } : {}),
            ...(options.price !== undefined ? { price: options.price } : {}),
            ...(options.note !== undefined ? { note: options.note } : {}),
          }),
        );
      },
      addOpenAmount(name, price, taxKey) {
        markActivity();
        void ensureTransaction();
        setCart((current) => addFreeLine(current, { id: newId(), name, price, taxKey }));
      },
      setQuantity(lineId, quantity) {
        markActivity();
        setCart((current) => setQuantity(current, lineId, quantity));
      },
      changeQuantity(lineId, delta) {
        markActivity();
        setCart((current) => changeQuantity(current, lineId, delta));
      },
      removeLine(lineId) {
        markActivity();
        setCart((current) => removeCartLine(current, lineId));
      },
      clear() {
        markActivity();
        if (db && user && cart.lines.length > 0) {
          void writeAudit(db, user, "SALE_DISCARDED", {
            detail: `${cart.lines.length} Positionen verworfen`,
            amount: totals.total,
          });
        }
        setCart((current) => clearLines(current));
        // Ein abgebrochener Vorgang laesst die TSE-Transaktion offen. Sie
        // wird beim naechsten Verkauf nicht weiterverwendet, sondern neu
        // begonnen - eine begonnene Transaktion ohne Abschluss ist in der TSE
        // zulaessig und wird dort protokolliert.
        openTransaction.current = null;
      },
      setServiceMode(mode) {
        markActivity();
        setCart((current) => setCartServiceMode(current, mode));
      },
      waiveDeposit(lineId, waive) {
        markActivity();
        setCart((current) => setWaiveDeposit(current, lineId, waive));
      },
      returnDeposit(item, quantity = ONE) {
        markActivity();
        gate("REFUND_DEPOSIT", `Pfandrueckgabe ${item.name}`);
        void ensureTransaction();
        setCart((current) => addDepositReturn(current, item, { id: newId(), quantity }));
      },
      discountLine(lineId, amount) {
        markActivity();
        gate("DISCOUNT", "Positionsrabatt");
        setCart((current) => setLineDiscount(current, lineId, amount));
      },
      discountOrder(amount) {
        markActivity();
        gate("DISCOUNT", "Belegrabatt");
        setCart((current) => setOrderDiscount(current, amount));
      },

      // --- Abschluss -----------------------------------------------------
      async pay(payments, options = {}) {
        const handle = requireDb();
        const setup = requireSetup();
        gate("SELL", "Bezahlen");
        markActivity();
        setBusy(true);
        try {
          await ensureTransaction();
          const open = openTransaction.current;
          if (!open) throw new Error("Kein laufender Vorgang");

          const sequence = await nextSequence(handle, setup.device.id, "receipt");
          const { order } = await finishTransaction(
            { ...setup, clock, newId, tse: tseClient },
            open,
            cart,
            payments,
            {
              sequence,
              deposits,
              smallBusiness: setup.tenant.smallBusiness,
              ...(options.customerName ? { customerName: options.customerName } : {}),
            },
          );

          await persistOrder(handle, order, setup.user);
          if (order.tse?.failureReason) {
            await writeAudit(handle, setup.user, "TSE_FAILURE", {
              subject: order.receiptNumber,
              detail: order.tse.failureReason,
              amount: order.total,
            });
          }

          openTransaction.current = null;
          setCart(emptyCart(setup.tenant.id, cart.serviceMode));
          setLastOrder(order);
          setOutboxPending(await countOutbox(handle));
          // Der Bestand hat sich geaendert - die Kacheln muessen es zeigen.
          await load(handle);
          return order;
        } finally {
          setBusy(false);
        }
      },

      async voidOrder(order, reason) {
        const handle = requireDb();
        const setup = requireSetup();
        const actor = gate("VOID_RECEIPT", `Storno ${order.receiptNumber}`);
        markActivity();
        setBusy(true);
        try {
          const context = { ...setup, clock, newId, tse: tseClient };
          const voidCart = buildVoidCart(order);
          const open = await beginTransaction(context);
          const sequence = await nextSequence(handle, setup.device.id, "receipt");
          const { order: created } = await finishTransaction(
            context,
            open,
            voidCart,
            // Der Storno wird auf demselben Weg zurueckgegeben, auf dem
            // bezahlt wurde. Bei geteilter Zahlung auf dem ersten.
            [{ method: order.payments[0]?.method ?? "CASH", amount: -order.total }],
            { sequence, note: `Storno zu ${order.receiptNumber}: ${reason}` },
          );
          const stored: Order = { ...created, voidsOrderId: order.id };
          await persistOrder(handle, stored, actor);
          await writeAudit(handle, actor, "RECEIPT_VOIDED", {
            subject: order.receiptNumber,
            detail: `Vollstorno: ${reason}`,
            amount: stored.total,
          });
          setLastOrder(stored);
          setOutboxPending(await countOutbox(handle));
          await load(handle);
          return stored;
        } finally {
          setBusy(false);
        }
      },

      async partialVoid(order, selections, reason) {
        const handle = requireDb();
        const setup = requireSetup();
        const actor = gate("VOID_RECEIPT", `Teilstorno ${order.receiptNumber}`);
        markActivity();
        setBusy(true);
        try {
          const context = { ...setup, clock, newId, tse: tseClient };
          // Der Kern rechnet den anteiligen Betrag aus; hier wird nichts
          // ueberschlagen - ein um einen Cent falscher Teilstorno ist eine
          // Kassendifferenz.
          const voidCart = buildPartialVoidCart(order, selections);
          const amount = cartTotals(voidCart, { smallBusiness: setup.tenant.smallBusiness }).total;
          const open = await beginTransaction(context);
          const sequence = await nextSequence(handle, setup.device.id, "receipt");
          const { order: created } = await finishTransaction(
            context,
            open,
            voidCart,
            [{ method: order.payments[0]?.method ?? "CASH", amount }],
            { sequence, note: `Teilstorno zu ${order.receiptNumber}: ${reason}` },
          );
          const stored: Order = { ...created, voidsOrderId: order.id };
          await persistOrder(handle, stored, actor);
          await writeAudit(handle, actor, "RECEIPT_VOIDED", {
            subject: order.receiptNumber,
            detail: `Teilstorno (${selections.length} Positionen): ${reason}`,
            amount: stored.total,
          });
          setLastOrder(stored);
          setOutboxPending(await countOutbox(handle));
          await load(handle);
          return stored;
        } finally {
          setBusy(false);
        }
      },

      // --- Parken --------------------------------------------------------
      async park(label) {
        const handle = requireDb();
        const setup = requireSetup();
        gate("SELL", "Vorgang parken");
        markActivity();
        setBusy(true);
        try {
          await ensureTransaction();
          const open = openTransaction.current;
          if (!open) throw new Error("Kein laufender Vorgang");

          const sale = await parkSale({
            id: newId(),
            tenantId: setup.tenant.id,
            storeId: setup.store.id,
            deviceId: setup.device.id,
            userId: setup.user.id,
            label,
            cart,
            open,
            parkedAt: nowIso(),
            total: totals.total,
            existing: parked,
            tse: tseClient,
            tseClientId: setup.device.tseClientId,
          });
          await saveParkedSale(handle, sale);

          // Der Bildschirm ist wieder frei fuer den naechsten Kunden.
          openTransaction.current = null;
          setCart(emptyCart(setup.tenant.id, cart.serviceMode));
          setParked(sortParkedSales(await listParkedSales(handle, setup.device.id)));
          return sale;
        } finally {
          setBusy(false);
        }
      },

      async resume(sale) {
        const handle = requireDb();
        const setup = requireSetup();
        gate("SELL", `Vorgang ${sale.label} fortsetzen`);
        markActivity();
        if (cart.lines.length > 0) {
          throw new Error("Erst den laufenden Vorgang abschliessen oder parken - sonst vermischen sich zwei Kunden.");
        }
        const restored = resumeSale(sale);
        openTransaction.current = restored.open;
        setCart(restored.cart);
        // Aus der Liste erst entfernen, wenn er wirklich auf dem Bildschirm
        // liegt: sonst ist er bei einem Fehler dazwischen verloren.
        await deleteParkedSale(handle, sale.id);
        setParked(sortParkedSales(await listParkedSales(handle, setup.device.id)));
      },

      async discardParked(sale) {
        const handle = requireDb();
        const setup = requireSetup();
        const actor = gate("VOID_RECEIPT", `Geparkten Vorgang ${sale.label} verwerfen`);
        await deleteParkedSale(handle, sale.id);
        await writeAudit(handle, actor, "SALE_DISCARDED", {
          subject: sale.label,
          detail: `${sale.lineCount} Positionen`,
          amount: sale.total,
        });
        setParked(sortParkedSales(await listParkedSales(handle, setup.device.id)));
      },

      // --- Kassenbuch ----------------------------------------------------
      async addCashMovement(type, amount, reason) {
        const handle = requireDb();
        const setup = requireSetup();
        const actor = gate(type === "OPENING" ? "OPEN_DAY" : "CASH_MOVEMENT", "Kassenbewegung");
        markActivity();
        const movement = buildCashMovement({
          id: newId(),
          tenantId: setup.tenant.id,
          storeId: setup.store.id,
          deviceId: setup.device.id,
          type,
          amount,
          reason,
          userId: actor.id,
          createdAt: nowIso(),
        });
        await appendCashMovement(handle, movement);
        await writeAudit(handle, actor, "CASH_MOVEMENT", {
          subject: type,
          detail: reason,
          amount: movement.amount,
        });
        setCashMovements(await listOpenCashMovements(handle, setup.device.id));
        return movement;
      },

      async openCashDay(cashCount) {
        const handle = requireDb();
        const setup = requireSetup();
        const actor = gate("OPEN_DAY", "Tageseroeffnung");
        markActivity();
        const movement = openDay({
          id: newId(),
          tenantId: setup.tenant.id,
          storeId: setup.store.id,
          deviceId: setup.device.id,
          cashCount,
          userId: actor.id,
          createdAt: nowIso(),
        });
        await appendCashMovement(handle, movement);
        await writeAudit(handle, actor, "CASH_MOVEMENT", {
          subject: "OPENING",
          detail: movement.reason,
          amount: movement.amount,
        });
        setCashMovements(await listOpenCashMovements(handle, setup.device.id));
        return movement;
      },

      // --- Bonversand ----------------------------------------------------
      async sendReceipt(order, channel, contact, open) {
        const handle = requireDb();
        const setup = requireSetup();
        markActivity();
        const view = buildReceiptView(order, {
          tenant: setup.tenant,
          store: setup.store,
          device: setup.device,
        });
        // Die Nachricht wird gebaut und geprueft, **bevor** irgendetwas
        // geoeffnet wird: eine Mail-App, die sich mit einer unbrauchbaren
        // Adresse oeffnet, hinterlaesst einen ratlosen Bediener.
        const message = prepareDelivery(channel, setup.tenant, view, contact);

        let ok = false;
        let failure: string | null = null;
        try {
          ok = await open(message.url);
          if (!ok) failure = "Auf diesem Geraet ist keine App fuer diesen Weg eingerichtet.";
        } catch (issue) {
          failure = (issue as Error).message;
        }

        await appendDelivery(
          handle,
          newId(),
          setup.tenant.id,
          recordDelivery(order, message, { sentAt: nowIso(), via: "device", ok, error: failure }),
        );
        if (!ok) throw new Error(failure ?? "Der Beleg konnte nicht uebergeben werden.");
      },

      async audit(event, details = {}) {
        const handle = requireDb();
        await writeAudit(handle, user, event, details);
      },

      async reload() {
        if (db) await load(db);
      },
      db: requireDb,
      now: nowIso,
    };
  }, [
    bookStock, cart, clock, db, deposits, device, ensureTransaction, load, nowIso, parked,
    store, tenant, totals.total, tseClient, user, users, writeAudit,
  ]);

  const value = useMemo<KasseState & KasseActions>(
    () => ({
      ready,
      error,
      tenant,
      store,
      device,
      user,
      users,
      loginRequired,
      locked,
      lockNotice,
      categories,
      products,
      deposits,
      cart,
      totals,
      parked,
      cashMovements,
      needsSetup: tenant ? isPlaceholderTenant(tenant) : true,
      tseOnline,
      outboxPending,
      lastOrder,
      busy,
      ...actions,
    }),
    [
      actions, busy, cart, cashMovements, categories, deposits, device, error, lastOrder, locked,
      lockNotice, loginRequired, outboxPending, parked, products, ready, store, tenant, totals,
      tseOnline, user, users,
    ],
  );

  return <KasseContext.Provider value={value}>{children}</KasseContext.Provider>;
}
