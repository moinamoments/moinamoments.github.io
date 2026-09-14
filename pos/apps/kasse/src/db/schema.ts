/**
 * Datenbankschema der Kasse.
 *
 * SQLite auf dem Geraet ist die *fuehrende* Datenhaltung, nicht ein Cache:
 * die Kasse muss vollstaendig offline arbeiten, und ein Beleg ist gueltig,
 * sobald er hier steht. Der Server bekommt ihn spaeter ueber die Outbox.
 *
 * Zwei Regeln, die das Schema durchsetzt:
 *
 *   1. Abgeschlossene Belege sind unveraenderlich (§ 146 Abs. 4 AO). Es gibt
 *      kein UPDATE und kein DELETE darauf - Korrekturen sind neue Belege.
 *      Die Anwendung haelt sich daran; zusaetzlich verhindern Trigger das
 *      Aendern und Loeschen, damit auch ein Fehler im Code es nicht kann.
 *   2. Jede Zeile traegt `tenant_id`. Auch wenn auf einem Geraet praktisch
 *      immer nur ein Mandant liegt: derselbe Code laeuft spaeter im Server,
 *      und dort ist die Trennung die Grundlage von allem.
 *
 * Migrationen laufen ueber `user_version`. Jede Migration ist unteilbar und
 * laeuft genau einmal - nach vorne. Ein Rueckwaertsweg ist bewusst nicht
 * vorgesehen: eine Kasse mit Belegen wird nicht zurueckgerollt.
 *
 * Solange die App nicht ausgeliefert ist, wird Migration 1 fortgeschrieben -
 * ein Schema, das aus zwanzig Aenderungsschritten an eine noch nie benutzte
 * Tabelle besteht, liest niemand mehr. **Ab der ersten Auslieferung gilt das
 * nicht mehr:** dann bekommt jede Aenderung ihre eigene Migration, weil auf
 * den Geraeten Belege liegen, die zehn Jahre lesbar bleiben muessen.
 */

export interface Migration {
  readonly version: number;
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    statements: [
      `CREATE TABLE tenant (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        legal_name TEXT NOT NULL,
        street TEXT NOT NULL,
        postal_code TEXT NOT NULL,
        city TEXT NOT NULL,
        country_code TEXT NOT NULL DEFAULT 'DE',
        tax_number TEXT,
        vat_id TEXT,
        email TEXT,
        phone TEXT,
        small_business INTEGER NOT NULL DEFAULT 0,
        receipt_footer TEXT,
        currency TEXT NOT NULL DEFAULT 'EUR',
        time_zone TEXT NOT NULL DEFAULT 'Europe/Berlin',
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE store (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        name TEXT NOT NULL,
        street TEXT,
        postal_code TEXT,
        city TEXT,
        active INTEGER NOT NULL DEFAULT 1
      )`,

      `CREATE TABLE device (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        store_id TEXT NOT NULL REFERENCES store(id),
        name TEXT NOT NULL,
        serial_number TEXT NOT NULL,
        tse_client_id TEXT,
        receipt_prefix TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 1
      )`,

      `CREATE TABLE app_user (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        -- Abweichungen von der Rolle als JSON-Objekt Recht -> true/false.
        -- Als JSON und nicht als Tabelle, weil die Rechteliste im Code steht
        -- (permissions.ts) und eine Tabelle mit Fremdschluessel darauf bei
        -- jeder neuen Faehigkeit eine Migration braeuchte.
        permission_overrides TEXT NOT NULL DEFAULT '{}',
        pin_hash TEXT,
        -- Wann die PIN gesetzt wurde. Nicht fuer einen Zwang zum Wechsel,
        -- sondern fuer den Hinweis "PIN seit zwei Jahren unveraendert".
        pin_set_at TEXT,
        active INTEGER NOT NULL DEFAULT 1
      )`,

      // Fehlversuche je Bediener **und Geraet**. Getrennt je Geraet, weil eine
      // Sperre sonst von jeder Kasse aus ausgeloest werden koennte - und dann
      // legt ein falsch getippter PIN am Nebenstand den Hauptstand still.
      // Diese Tabelle ist Zustand, nicht Protokoll: sie wird ueberschrieben.
      // Der Nachweis der Fehlversuche steht im Pruefprotokoll.
      `CREATE TABLE login_attempt (
        user_id TEXT NOT NULL REFERENCES app_user(id),
        device_id TEXT NOT NULL,
        failed_attempts INTEGER NOT NULL DEFAULT 0,
        lock_count INTEGER NOT NULL DEFAULT 0,
        locked_until TEXT,
        last_attempt_at TEXT,
        PRIMARY KEY (user_id, device_id)
      )`,

      // Pruefprotokoll: wer hat was am System getan. Nur anfuegen - die
      // Trigger weiter unten verhindern Aendern und Loeschen. Ohne diese
      // Tabelle ist "wer hat storniert" nach zwei Wochen nicht mehr zu
      // beantworten.
      `CREATE TABLE audit_log (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        user_id TEXT,
        -- Name als Kopie zum Zeitpunkt des Ereignisses: ein umbenannter oder
        -- deaktivierter Bediener darf das Protokoll nicht unlesbar machen.
        user_name TEXT,
        event TEXT NOT NULL,
        subject TEXT,
        detail TEXT,
        amount INTEGER,
        created_at TEXT NOT NULL
      )`,

      // Geparkte Vorgaenge. Der Warenkorb liegt als JSON darin: er ist noch
      // kein Beleg, also gibt es nichts zu normalisieren - und beim
      // Fortsetzen wird er unveraendert zurueckgegeben.
      `CREATE TABLE parked_sale (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        store_id TEXT NOT NULL REFERENCES store(id),
        device_id TEXT NOT NULL REFERENCES device(id),
        user_id TEXT NOT NULL,
        label TEXT NOT NULL,
        cart_json TEXT NOT NULL,
        started_at TEXT NOT NULL,
        parked_at TEXT NOT NULL,
        tse_transaction_number INTEGER,
        tse_failure TEXT,
        total INTEGER NOT NULL,
        line_count INTEGER NOT NULL
      )`,

      // Kassenbuch: Tageseroeffnung, Einlage, Entnahme, Transit, Trinkgeld.
      // Nur anfuegen, wie die Belege - eine nachtraeglich geaenderte Entnahme
      // ist bei einer Kassennachschau der erste Verdacht.
      `CREATE TABLE cash_movement (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        store_id TEXT NOT NULL REFERENCES store(id),
        device_id TEXT NOT NULL REFERENCES device(id),
        type TEXT NOT NULL,
        amount INTEGER NOT NULL,
        reason TEXT NOT NULL,
        cash_count_json TEXT NOT NULL DEFAULT '[]',
        user_id TEXT NOT NULL,
        closing_id TEXT,
        created_at TEXT NOT NULL
      )`,

      // Nachweis der Belegausgabe. Gespeichert wird der **verkuerzte**
      // Empfaenger (anonymizeContact): nachweisbar bleiben muss, dass ein
      // Beleg herausgegeben wurde, nicht an welche Adresse. Damit entsteht
      // auch kein Kundenstamm, den niemand bestellt hat.
      `CREATE TABLE receipt_delivery (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        order_id TEXT NOT NULL REFERENCES sales_order(id),
        channel TEXT NOT NULL,
        recipient TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        via TEXT NOT NULL,
        ok INTEGER NOT NULL,
        error TEXT
      )`,

      // Warengruppen bilden einen Baum. Die Tiefe begrenzt die Anwendung
      // (limits.ts), nicht die Datenbank: SQLite kann eine Tiefe nicht
      // pruefen, und ein Zyklus in den Daten darf den Kassenbildschirm
      // trotzdem nicht lahmlegen - darum kuemmert sich buildCategoryTree.
      `CREATE TABLE category (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        parent_id TEXT REFERENCES category(id),
        name TEXT NOT NULL,
        color TEXT,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1
      )`,

      `CREATE TABLE product (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        category_id TEXT NOT NULL REFERENCES category(id),
        name TEXT NOT NULL,
        description TEXT,
        price INTEGER,
        tax_key INTEGER NOT NULL,
        tax_key_dine_in INTEGER,
        sku TEXT,
        unit TEXT NOT NULL DEFAULT 'PIECE',
        is_deposit INTEGER NOT NULL DEFAULT 0,
        color TEXT,
        image_url TEXT,
        image_license TEXT,
        image_license_url TEXT,
        image_creator TEXT,
        image_source_url TEXT,
        image_provider TEXT,
        track_stock INTEGER NOT NULL DEFAULT 0,
        stock INTEGER NOT NULL DEFAULT 0,
        low_stock_threshold INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        -- Ein Bild ohne Lizenzangabe darf nicht in den Stamm gelangen: die
        -- Namensnennung ist bei CC-Lizenzen Pflicht, und nachtraeglich
        -- herausfinden, woher ein Bild kam, kann niemand.
        CHECK (image_url IS NULL OR (image_license IS NOT NULL AND TRIM(image_license) <> ''))
      )`,

      // Pfandzuordnung als eigene Tabelle: ein Artikel kann mehrere
      // Pfandartikel mitbringen (Becher und Deckel), und die Reihenfolge
      // bestimmt, wie sie auf dem Bon stehen.
      `CREATE TABLE product_deposit (
        product_id TEXT NOT NULL REFERENCES product(id) ON DELETE CASCADE,
        deposit_product_id TEXT NOT NULL REFERENCES product(id),
        sort_order INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (product_id, deposit_product_id)
      )`,

      `CREATE TABLE sales_order (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        store_id TEXT NOT NULL REFERENCES store(id),
        device_id TEXT NOT NULL REFERENCES device(id),
        user_id TEXT NOT NULL,
        receipt_number TEXT NOT NULL,
        state TEXT NOT NULL,
        service_mode TEXT NOT NULL,
        total INTEGER NOT NULL,
        order_discount INTEGER NOT NULL DEFAULT 0,
        started_at TEXT NOT NULL,
        paid_at TEXT,
        voids_order_id TEXT,
        closing_id TEXT,
        customer_name TEXT,
        note TEXT,
        tse_json TEXT,
        UNIQUE (device_id, receipt_number)
      )`,

      `CREATE TABLE order_line (
        id TEXT NOT NULL,
        order_id TEXT NOT NULL REFERENCES sales_order(id),
        position INTEGER NOT NULL,
        product_id TEXT,
        name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price INTEGER NOT NULL,
        gross INTEGER NOT NULL,
        tax_key INTEGER NOT NULL,
        business_case_type TEXT NOT NULL,
        discount INTEGER NOT NULL DEFAULT 0,
        allocated_discount INTEGER NOT NULL DEFAULT 0,
        deposit_for_line_id TEXT,
        modifiers_json TEXT NOT NULL DEFAULT '[]',
        note TEXT,
        PRIMARY KEY (order_id, position)
      )`,

      `CREATE TABLE order_payment (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL REFERENCES sales_order(id),
        method TEXT NOT NULL,
        amount INTEGER NOT NULL,
        tendered INTEGER NOT NULL,
        change INTEGER NOT NULL,
        label TEXT NOT NULL,
        reference TEXT,
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE closing (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        store_id TEXT NOT NULL REFERENCES store(id),
        device_id TEXT NOT NULL REFERENCES device(id),
        number INTEGER NOT NULL,
        from_at TEXT NOT NULL,
        to_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        user_id TEXT NOT NULL,
        opening_cash INTEGER NOT NULL DEFAULT 0,
        cash_count_json TEXT NOT NULL DEFAULT '[]',
        report_json TEXT NOT NULL,
        UNIQUE (device_id, number)
      )`,

      // Nummernkreise je Geraet. Eine eigene Tabelle statt MAX(...)+1, damit
      // die Nummer auch dann lueckenlos weiterlaeuft, wenn ein Beleg beim
      // Speichern scheitert.
      `CREATE TABLE sequence (
        device_id TEXT NOT NULL,
        name TEXT NOT NULL,
        value INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, name)
      )`,

      // Bestandsbewegungen. Der Bestand am Artikel ist die Summe dieser
      // Zeilen; die Zeilen selbst werden nie veraendert, nur ergaenzt. Nur so
      // ist hinterher zu klaeren, warum von zwanzig Flaschen zwoelf uebrig
      // sind.
      `CREATE TABLE stock_movement (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL REFERENCES tenant(id),
        store_id TEXT NOT NULL REFERENCES store(id),
        product_id TEXT NOT NULL REFERENCES product(id),
        quantity INTEGER NOT NULL,
        resulting_stock INTEGER NOT NULL,
        reason TEXT NOT NULL,
        order_id TEXT,
        user_id TEXT NOT NULL,
        note TEXT,
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE outbox (
        key TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        tenant_id TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        last_error TEXT
      )`,

      // Protokoll der TSE-Ausfaelle. § 146a AO verlangt, dass Ausfaelle
      // dokumentiert werden - nicht nur auf dem einzelnen Bon.
      `CREATE TABLE tse_incident (
        id TEXT PRIMARY KEY,
        tenant_id TEXT NOT NULL,
        device_id TEXT NOT NULL,
        order_id TEXT,
        occurred_at TEXT NOT NULL,
        reason TEXT NOT NULL
      )`,

      `CREATE INDEX idx_order_device_state ON sales_order (device_id, state, closing_id)`,
      `CREATE INDEX idx_order_paid_at ON sales_order (paid_at)`,
      `CREATE INDEX idx_line_order ON order_line (order_id)`,
      `CREATE INDEX idx_payment_order ON order_payment (order_id)`,
      `CREATE INDEX idx_product_category ON product (tenant_id, category_id, sort_order)`,
      `CREATE INDEX idx_outbox_next ON outbox (next_attempt_at)`,
      `CREATE INDEX idx_category_parent ON category (tenant_id, parent_id, sort_order)`,
      `CREATE INDEX idx_stock_product ON stock_movement (product_id, created_at)`,
      `CREATE INDEX idx_stock_created ON stock_movement (created_at)`,
      // Ohne `rowid` in der Spaltenliste: SQLite laesst das nicht zu, und es
      // waere auch ueberfluessig - innerhalb eines Indexschluessels stehen die
      // Eintraege schon in rowid-Reihenfolge, und genau danach wird sortiert.
      `CREATE INDEX idx_audit_device ON audit_log (device_id)`,
      `CREATE INDEX idx_audit_event ON audit_log (event)`,
      `CREATE INDEX idx_cash_device ON cash_movement (device_id, closing_id)`,
      `CREATE INDEX idx_delivery_order ON receipt_delivery (order_id)`,
      // Die Bezeichnung eines geparkten Vorgangs muss je Kasse eindeutig sein,
      // und zwar ohne Ruecksicht auf Gross- und Kleinschreibung: "Tisch 4" und
      // "tisch 4" waeren in der Liste nicht auseinanderzuhalten.
      `CREATE UNIQUE INDEX idx_parked_label ON parked_sale (device_id, label COLLATE NOCASE)`,

      // Unveraenderbarkeit bezahlter Belege, auf Datenbankebene.
      `CREATE TRIGGER trg_order_no_update
        BEFORE UPDATE ON sales_order
        FOR EACH ROW WHEN OLD.state = 'PAID'
          AND (NEW.total <> OLD.total
            OR NEW.receipt_number <> OLD.receipt_number
            OR NEW.state <> OLD.state
            OR IFNULL(NEW.paid_at, '') <> IFNULL(OLD.paid_at, '')
            OR IFNULL(NEW.tse_json, '') <> IFNULL(OLD.tse_json, ''))
        BEGIN
          SELECT RAISE(ABORT, 'Ein bezahlter Beleg darf nicht geaendert werden - Korrektur nur per Storno');
        END`,

      `CREATE TRIGGER trg_order_no_delete
        BEFORE DELETE ON sales_order
        FOR EACH ROW WHEN OLD.state = 'PAID'
        BEGIN
          SELECT RAISE(ABORT, 'Ein bezahlter Beleg darf nicht geloescht werden');
        END`,

      `CREATE TRIGGER trg_stock_no_change
        BEFORE UPDATE ON stock_movement
        BEGIN
          SELECT RAISE(ABORT, 'Eine Bestandsbewegung wird nicht geaendert - Korrektur nur als neue Bewegung');
        END`,

      `CREATE TRIGGER trg_stock_no_delete
        BEFORE DELETE ON stock_movement
        BEGIN
          SELECT RAISE(ABORT, 'Eine Bestandsbewegung wird nicht geloescht');
        END`,

      // Das Pruefprotokoll ist nur anfuegbar. Ein Protokoll, das sich aendern
      // laesst, beweist nichts - und genau dann wird es gebraucht, wenn
      // jemand einen Grund haette, es zu aendern.
      `CREATE TRIGGER trg_audit_no_update
        BEFORE UPDATE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'Das Pruefprotokoll wird nicht geaendert');
        END`,

      `CREATE TRIGGER trg_audit_no_delete
        BEFORE DELETE ON audit_log
        BEGIN
          SELECT RAISE(ABORT, 'Das Pruefprotokoll wird nicht geloescht');
        END`,

      // Bargeldbewegungen sind unveraenderlich - mit einer Ausnahme: die
      // Zuordnung zum Kassenabschluss wird nachgetragen, genau wie beim Beleg.
      `CREATE TRIGGER trg_cash_no_update
        BEFORE UPDATE ON cash_movement
        FOR EACH ROW WHEN NEW.amount <> OLD.amount
          OR NEW.type <> OLD.type
          OR NEW.reason <> OLD.reason
          OR NEW.user_id <> OLD.user_id
          OR NEW.created_at <> OLD.created_at
        BEGIN
          SELECT RAISE(ABORT, 'Eine Kassenbewegung wird nicht geaendert - Korrektur nur als neue Bewegung');
        END`,

      `CREATE TRIGGER trg_cash_no_delete
        BEFORE DELETE ON cash_movement
        BEGIN
          SELECT RAISE(ABORT, 'Eine Kassenbewegung wird nicht geloescht');
        END`,

      `CREATE TRIGGER trg_line_no_delete
        BEFORE DELETE ON order_line
        FOR EACH ROW WHEN (SELECT state FROM sales_order WHERE id = OLD.order_id) = 'PAID'
        BEGIN
          SELECT RAISE(ABORT, 'Positionen eines bezahlten Belegs duerfen nicht geloescht werden');
        END`,
    ],
  },
];

export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]?.version ?? 0;
