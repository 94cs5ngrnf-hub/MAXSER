# MAXSER – n8n Ausschreibungs-Bot (Gebäudereinigung)

Bundesweiter Vergabe-/Ausschreibungs-Bot auf n8n-Basis. Findet Ausschreibungen
über die TED-API, lässt den Nutzer per Telegram auswählen, lädt die
zugehörigen Vergabeunterlagen automatisiert von möglichst vielen
Vergabeplattformen herunter und lässt sie anschließend von Claude
(Anthropic) analysieren.

Dieses Repository enthält **keinen** kompletten n8n-Export, sondern die
Architektur-Dokumentation und den vollständigen, copy-paste-fertigen
JavaScript-Code für die zentralen Code-Nodes, die du in deinen bestehenden
Workflow einfügst.

## Inhalt

- [`docs/architecture.md`](docs/architecture.md) – Zielarchitektur, Node-Reihenfolge
  (behalten/löschen/neu), Klassifizierung, alle Strategien (Session, Login,
  MFA, Browser, Retry, Binärdaten, Claude-Übergabe, Fehlermeldungen).
- [`n8n/core/portal-access-core.js`](n8n/core/portal-access-core.js) – **Universal Classifier +
  Adapter Router**: Datei-Erkennung (Content-Type + Magic Bytes), URL-Resolver,
  Fehlerhandler, Retry-Berechnung, Cookie-Parsing/Session-Reuse, Portal-Adapter-
  Registry. Macht KEINE eigenen HTTP-Requests – läuft direkt nach einem
  normalen `HTTP Request`-Node (zweimal im Sub-Workflow eingesetzt: nach der
  Sondierung und nach jedem Einzeldokument-Download).
- [`n8n/core/prepare-request.js`](n8n/core/prepare-request.js) – setzt
  `requestUrl`/`_tenderKey`/Startwerte vor der ersten Sondierung.
- [`n8n/core/add-doc-index.js`](n8n/core/add-doc-index.js) – vergibt
  eindeutige `docIndex`-Werte nach `Split Out`, vor `Loop Over Items`.
- [`n8n/core/document-aggregation-and-gate.js`](n8n/core/document-aggregation-and-gate.js) –
  fasst die Einzeldokument-Downloads aus der Loop-Over-Items-Schleife wieder
  zu einem Ausschreibungs-Item zusammen und setzt `documentAccessStatus`
  OK/PRÜFEN (Pre-AI-Gate).
- [`n8n/core/telegram-error-messages.js`](n8n/core/telegram-error-messages.js) –
  Alle Telegram-Fehler-/Statusmeldungen an einer Stelle.
- [`n8n/adapters/portal-config.md`](n8n/adapters/portal-config.md) – Zentrale
  Portal-Konfiguration (Tabelle) + Anleitung, wie ein neuer Adapter ergänzt
  wird.

## Leitplanken (nicht verhandelbar)

- Keine CAPTCHA-Umgehung, keine Umgehung von Login-/Zugriffsschutz, keine
  Tarnung als Mensch, keine fremden Zugangsdaten.
- Login nur mit echten, autorisierten Firmenzugängen aus dem n8n Credential
  Store – niemals im Klartext im Code.
- Ist ein Zugang nicht rechtssicher automatisierbar, wird sauber
  `MANUAL_REVIEW` / `PRÜFEN` gesetzt statt geraten.
- Claude darf nur dann behaupten, Unterlagen geprüft zu haben, wenn sie
  tatsächlich heruntergeladen und verarbeitet wurden.
