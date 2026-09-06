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
- [`n8n/core/portal-access-core.js`](n8n/core/portal-access-core.js) – **Portal Access Core**:
  Universal Response Classifier, Portal Adapter Router, Datei-Erkennung
  (Content-Type + Magic Bytes), URL-Resolver, Fehlerhandler, Retry/Backoff,
  Cookie-Jar/Session-Reuse. Läuft als **ein** Code-Node in einem eigenen
  Sub-Workflow "MAXSER – Portal Access Core", der per `Execute Workflow`
  aus dem Hauptworkflow aufgerufen wird.
- [`n8n/core/auth-browser-orchestrator.js`](n8n/core/auth-browser-orchestrator.js) –
  Login/Session-/MFA-/Browser-Strategie für AUTH_REQUIRED und
  BROWSER_REQUIRED Portale.
- [`n8n/core/document-gate-and-normalization.js`](n8n/core/document-gate-and-normalization.js) –
  Binärdaten-Handling, Vollständigkeits-Gate vor der Claude-Analyse,
  `documentAccessStatus` OK/PRÜFEN.
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
