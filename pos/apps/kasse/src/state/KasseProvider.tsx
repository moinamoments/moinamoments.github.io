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
 */

import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import {
  type Cart,
  type Category,
  type Device,
  type DepositCatalog,
  type DepositItem,
  type Order,
  type PaymentIntent,
  type Product,
  type Quantity,
  type ServiceMode,
  type Store,
  type Tenant,
  type TseClient,
  type User,
  type CartTotals,
  MockTse,
  ONE,
  addDepositReturn,
  addFreeLine,
  addProduct as addProductToCart,
  beginTransaction,
  buildVoidCart,
  cartTotals,
  changeQuantity,
  clearLines,
  createDepositCatalog,
  emptyCart,
  finishTransaction,
  isoWithOffset,
  outboxKey,
  removeLine as removeCartLine,
  setLineDiscount,
  setOrderDiscount,
  setQuantity,
  setServiceMode as setCartServiceMode,
  setWaiveDeposit,
  systemClock,
  movementsForOrder,
  type OpenTransaction,
  type StockMovement,
} from "@kp/core";
import { type Db, openDb } from "../db/database.ts";
import {
  applyStockMovement,
  countOutbox,
  getDevice,
  getStore,
  getTenant,
  listCategories,
  listProducts,
  listUsers,
  nextSequence,
  saveOrder,
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

export interface KasseState {
  readonly ready: boolean;
  readonly error: string | null;
  readonly tenant: Tenant | null;
  readonly store: Store | null;
  readonly device: Device | null;
  readonly user: User | null;
  readonly categories: readonly Category[];
  readonly products: readonly Product[];
  readonly deposits: DepositCatalog;
  readonly cart: Cart;
  readonly totals: CartTotals;
  /** Ist die Kasse eingerichtet, oder stehen noch Platzhalterdaten drin? */
  readonly needsSetup: boolean;
  readonly tseOnline: boolean;
  readonly outboxPending: number;
  /** Der letzte abgeschlossene Beleg, fuer die Bonanzeige. */
  readonly lastOrder: Order | null;
  readonly busy: boolean;
}

export interface KasseActions {
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
  pay(payments: readonly PaymentIntent[]): Promise<Order>;
  voidOrder(order: Order): Promise<Order>;
  reload(): Promise<void>;
  /** Liefert die Datenbank fuer Seiten, die eigene Abfragen brauchen. */
  db(): Db;
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
  const [categories, setCategories] = useState<readonly Category[]>([]);
  const [products, setProducts] = useState<readonly Product[]>([]);
  const [cart, setCart] = useState<Cart>(() => emptyCart("", "TAKEAWAY"));
  const [tseOnline, setTseOnline] = useState(false);
  const [outboxPending, setOutboxPending] = useState(0);
  const [lastOrder, setLastOrder] = useState<Order | null>(null);
  const [busy, setBusy] = useState(false);

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

  const load = useCallback(async (handle: Db) => {
    const [loadedTenant, loadedStore, loadedDevice, users, loadedCategories, loadedProducts, pending] =
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
    setUser(users[0] ?? null);
    setCategories(loadedCategories);
    setProducts(loadedProducts);
    setOutboxPending(pending);
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

    return {
      addProduct(product, options = {}) {
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
        void ensureTransaction();
        setCart((current) => addFreeLine(current, { id: newId(), name, price, taxKey }));
      },
      setQuantity(lineId, quantity) {
        setCart((current) => setQuantity(current, lineId, quantity));
      },
      changeQuantity(lineId, delta) {
        setCart((current) => changeQuantity(current, lineId, delta));
      },
      removeLine(lineId) {
        setCart((current) => removeCartLine(current, lineId));
      },
      clear() {
        setCart((current) => clearLines(current));
        // Ein abgebrochener Vorgang laesst die TSE-Transaktion offen. Sie
        // wird beim naechsten Verkauf nicht weiterverwendet, sondern neu
        // begonnen - eine begonnene Transaktion ohne Abschluss ist in der TSE
        // zulaessig und wird dort protokolliert.
        openTransaction.current = null;
      },
      setServiceMode(mode) {
        setCart((current) => setCartServiceMode(current, mode));
      },
      waiveDeposit(lineId, waive) {
        setCart((current) => setWaiveDeposit(current, lineId, waive));
      },
      returnDeposit(item, quantity = ONE) {
        void ensureTransaction();
        setCart((current) => addDepositReturn(current, item, { id: newId(), quantity }));
      },
      discountLine(lineId, amount) {
        setCart((current) => setLineDiscount(current, lineId, amount));
      },
      discountOrder(amount) {
        setCart((current) => setOrderDiscount(current, amount));
      },

      async pay(payments) {
        const handle = requireDb();
        if (!tenant || !store || !device || !user) throw new Error("Die Kasse ist nicht vollstaendig eingerichtet");
        setBusy(true);
        try {
          await ensureTransaction();
          const open = openTransaction.current;
          if (!open) throw new Error("Kein laufender Vorgang");

          const sequence = await nextSequence(handle, device.id, "receipt");
          const { order } = await finishTransaction(
            { tenant, store, device, user, clock, newId, tse: tseClient },
            open,
            cart,
            payments,
            { sequence, deposits, smallBusiness: tenant.smallBusiness },
          );

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

          await bookStock(handle, order, user.id);

          openTransaction.current = null;
          setCart(emptyCart(tenant.id, cart.serviceMode));
          setLastOrder(order);
          setOutboxPending(await countOutbox(handle));
          // Der Bestand hat sich geaendert - die Kacheln muessen es zeigen.
          await load(handle);
          return order;
        } finally {
          setBusy(false);
        }
      },

      async voidOrder(order) {
        const handle = requireDb();
        if (!tenant || !store || !device || !user) throw new Error("Die Kasse ist nicht vollstaendig eingerichtet");
        setBusy(true);
        try {
          const voidCart = buildVoidCart(order);
          const context = { tenant, store, device, user, clock, newId, tse: tseClient };
          const open = await beginTransaction(context);
          const sequence = await nextSequence(handle, device.id, "receipt");
          const { order: voidOrder } = await finishTransaction(
            context,
            open,
            voidCart,
            // Der Storno wird auf demselben Weg zurueckgegeben, auf dem
            // bezahlt wurde. Bei geteilter Zahlung auf dem ersten.
            [{ method: order.payments[0]?.method ?? "CASH", amount: -order.total }],
            { sequence, note: `Storno zu ${order.receiptNumber}` },
          );
          const stored: Order = { ...voidOrder, voidsOrderId: order.id };
          await saveOrder(handle, stored);
          await upsertOutboxEntry(handle, {
            key: outboxKey("order", stored.id),
            kind: "order",
            entityId: stored.id,
            tenantId: stored.tenantId,
            payload: JSON.stringify(stored),
            createdAt: stored.paidAt ?? stored.startedAt,
            attempts: 0,
            nextAttemptAt: stored.paidAt ?? stored.startedAt,
            lastError: null,
          });
          await bookStock(handle, stored, user.id);
          setLastOrder(stored);
          setOutboxPending(await countOutbox(handle));
          await load(handle);
          return stored;
        } finally {
          setBusy(false);
        }
      },

      async reload() {
        if (db) await load(db);
      },
      db: requireDb,
    };
  }, [bookStock, cart, clock, db, deposits, ensureTransaction, load, store, tenant, tseClient, user, device]);

  const value = useMemo<KasseState & KasseActions>(
    () => ({
      ready,
      error,
      tenant,
      store,
      device,
      user,
      categories,
      products,
      deposits,
      cart,
      totals,
      needsSetup: tenant ? isPlaceholderTenant(tenant) : true,
      tseOnline,
      outboxPending,
      lastOrder,
      busy,
      ...actions,
    }),
    [actions, busy, cart, categories, deposits, device, error, lastOrder, outboxPending, products, ready, store, tenant, totals, tseOnline, user],
  );

  return <KasseContext.Provider value={value}>{children}</KasseContext.Provider>;
}
