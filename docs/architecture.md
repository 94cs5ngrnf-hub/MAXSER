# Zielarchitektur – Portal-Access-Layer

## 1. Zielarchitektur (Überblick)

Statt 20 separater Portal-Workflows: **ein** Hauptworkflow + **ein**
wiederverwendbarer Sub-Workflow ("Core"), der per `Execute Workflow`
aufgerufen wird. Portal-Spezifika stecken **nicht** in eigenen n8n-Nodes,
sondern als Einträge in einer JS-Objekt-Registry (`PORTAL_CONFIG` +
`ADAPTERS`) innerhalb des Core-Codes. Ein neues Portal = ein neuer
Objekt-Eintrag, kein neuer Workflow-Zweig.

```
Telegram Trigger
→ Auth & Extract
→ Code in JavaScript1
→ HTTP Request TED API
→ Split Out
→ Code in JavaScript Deadline
→ Filter abgelaufen
→ IF Dokument-Link vorhanden?
   FALSE → Code in JavaScript4 → Telegram
   TRUE  → Code in JavaScript2 (documentUrls/firstDocumentUrl/procurementPortal)
         → Code in JavaScript3 (nummerierte Liste)
         → Telegram "Send and Wait for Response"
         → Code in JavaScript5 (Auswahl-Parsing)
         → Execute Workflow: "MAXSER – Portal Access Core"   ← NEU (ersetzt HTTP Request1 + Switch nach procurementPortal)
         → IF: portalAccessStatus IN (AUTH_REQUIRED, BROWSER_REQUIRED)?
              TRUE  → Code: Auth/Browser Orchestrator          ← NEU
                    → (Telegram Send-and-Wait bei MFA, falls nötig)
                    → Execute Workflow: "MAXSER – Portal Access Core" (2. Versuch, mit Session)
              FALSE → weiter
         → Code: Dokument-Normalisierung & Pre-AI-Gate         ← NEU
         → IF: documentAccessStatus == OK?
              TRUE  → Merge → AI Agent (Claude)
              FALSE → Code: Telegram-Fehlermeldung             ← NEU → Telegram
```

Der "Universal Portal Access Layer", "Response Classifier", "Portal Adapter
Router", "Public Download Resolver", "Auth/Session Resolver", "Downloader"
aus der gewünschten Architektur sind **alle innerhalb des einen Core-Codes**
implementiert (Funktionen, kein separater Node pro Schritt) – das ist die
"möglichst wenig Nodes"-Vorgabe (V). Die einzige echte Verzweigung im
n8n-Graph ist die IF-Node für "braucht Login/Browser" und die IF-Node für
"Dokumente vollständig".

## 2. Nodes: behalten / löschen / neu

**Behalten (unverändert):**
Telegram Trigger, Auth & Extract, Code in JavaScript1, HTTP Request TED API,
Split Out, Code in JavaScript Deadline, Filter abgelaufen,
IF Dokument-Link vorhanden?, Code in JavaScript4, Telegram (No-Link-Zweig),
Code in JavaScript2, Code in JavaScript3, Telegram "Send and Wait for
Response", Code in JavaScript5.

**Löschen:**
- `HTTP Request1` (der eine gemeinsame GET-Request ohne Klassifizierung) →
  ersetzt durch den Core (macht Request + Klassifizierung + Download in
  einem Rutsch, inkl. Retry/Backoff/Cookies).
- `Switch nach procurementPortal` (falls als n8n-Switch-Node mit 20
  Ausgängen gebaut) → ersetzt durch die `PORTAL_CONFIG`/`ADAPTERS`-Registry
  im Core-Code. Kein 20-Wege-Switch mehr nötig.
- Jegliche bereits begonnenen portal-spezifischen Einzel-Workflows/Branches
  → Logik wandert als Adapter-Eintrag in den Core.

**Neu:**
1. `Execute Workflow: MAXSER – Portal Access Core` (ruft Sub-Workflow mit
   dem Code aus `n8n/core/portal-access-core.js` auf).
2. `IF: Login/Browser nötig?` (prüft `portalAccessStatus`).
3. `Code: Auth/Browser Orchestrator` (`n8n/core/auth-browser-orchestrator.js`).
4. `Code: Dokument-Normalisierung & Pre-AI-Gate`
   (`n8n/core/document-gate-and-normalization.js`).
5. `IF: documentAccessStatus == OK?`
6. `Code: Telegram-Fehlermeldung` (`n8n/core/telegram-error-messages.js`).
7. Der Sub-Workflow selbst: `Execute Workflow Trigger` → 1 Code-Node
   (Core-Logik) → `NoOp`/Return.

Damit kommen zum bestehenden Workflow **6 neue Nodes im Hauptworkflow**
plus **1 kleiner Sub-Workflow mit 2 Nodes** dazu – nicht 20 neue Workflows.

## 3. Klassifizierung → `portalAccessStatus`

Reihenfolge der Prüfung im Core (erste zutreffende gewinnt):

1. Netzwerkfehler / Timeout ohne Response → `MANUAL_REVIEW` (Grund: `NETWORK_ERROR`)
2. HTTP 429 → `RATE_LIMITED` (Retry-After respektieren, s. Abschnitt G)
3. HTTP 401/403 oder erkannte Bot-/Security-Challenge (z. B. Cloudflare
   Interstitial, "Access Denied", CAPTCHA-Marker im HTML) → `BLOCKED`
   (bzw. `AUTH_REQUIRED`, wenn ein Login-Formular erkannt wird) – **niemals
   umgangen**, nur gemeldet.
4. HTTP 2xx + Content-Type/Magic-Bytes = echte Datei (PDF/ZIP/DOCX/XLSX/
   CSV/XML/…) → `DIRECT_FILE`
5. HTTP 2xx + HTML, und HTML enthält ein Login-Formular / "Anmelden"-Marker
   aus `PORTAL_CONFIG` → `AUTH_REQUIRED`
6. HTTP 2xx + HTML, öffentlich erreichbar, Download-Links im HTML per
   Adapter erkennbar → `PUBLIC_HTML_WITH_DOWNLOADS`
7. HTTP 2xx + HTML, aber Downloadlinks erst nach Cookie/Redirect-Zyklus
   erreichbar (z. B. Session-Cookie wird gesetzt, danach 2. Request nötig)
   → `SESSION_REQUIRED`
8. HTML, das laut `PORTAL_CONFIG.requiresBrowser = true` oder laut
   Heuristik (fast leerer `<body>`, aber viel `<script>`, SPA-Marker wie
   `id="app"`/`ng-version`/`__NEXT_DATA__`) nur per echtem Browser nutzbar
   ist → `BROWSER_REQUIRED`
9. Alles andere / nicht eindeutig bestimmbar → `MANUAL_REVIEW`

Der vollständige Code steht in `n8n/core/portal-access-core.js`
(`classifyResponse()`).

## H. Cookie-Jar & Session-Persistenz

- Innerhalb **eines** Item-Durchlaufs: Cookies werden aus jedem
  `set-cookie`-Response-Header geparst und in einem einfachen
  `{name: value}`-Objekt (`sessionCookies`) gesammelt und bei jedem
  Folge-Request als `Cookie:`-Header mitgeschickt (Funktion
  `mergeCookies()` / `cookiesToHeader()` im Core).
- Über mehrere Ausführungen/Items hinweg (Wiederverwendung pro Portal):
  Ablage in `$getWorkflowStaticData('global')` unter dem Portal-Domain-Namen,
  mit `expiresAt`-Zeitstempel. Vor jedem Request wird geprüft, ob eine
  gültige Session existiert – wenn ja, wird sie verwendet, statt neu zu
  authentifizieren.
- Abgelaufene/ungültige Sessions (z. B. erneuter 401/302-auf-Login nach
  Cookie-Nutzung) führen zu `sessionExpired = true` → Re-Login über den
  Auth/Browser-Orchestrator, danach Cache-Eintrag überschreiben.
- **Nichts wird verschlüsselt im Static-Data-Store abgelegt außer
  Session-Cookies (keine Passwörter!).** Zugangsdaten liegen ausschließlich
  im n8n Credential Store.

## I. Legitime Browser-Automation bei Login-Portalen

1. Zugangsdaten kommen **ausschließlich** aus einer n8n Credential
   (`Generic Credential Type` oder eigener Credential-Typ pro Firma/Portal,
   z. B. `MAXSER_<PORTALNAME>_LOGIN`). Sie werden nie im Code oder in
   Klartext-Feldern eines Items gespeichert.
2. Login läuft über eine echte Browser-Automation (Playwright/Puppeteer),
   die als **eigener kleiner HTTP-Microservice** (z. B. Browserless oder
   ein selbst gehosteter Playwright-Service) aufgerufen wird – n8n selbst
   hat keinen eingebauten Browser. Der Core ruft diesen Service per HTTP
   Request mit `{portal, username, password, loginUrl}` auf (Credentials
   werden per n8n Credential in den HTTP-Request-Header/-Body injiziert,
   nie hart codiert).
3. Login-Ablauf im Microservice: Seite laden → auf Login-Formular warten →
   Felder ausfüllen → absenden → auf erfolgreiche Weiterleitung/DOM-Zustand
   warten → Cookies extrahieren → an n8n zurückgeben.
4. n8n speichert die zurückgegebenen Session-Cookies (siehe H) und
   verwendet sie für nachfolgende Downloads – **kein** erneuter Login pro
   Dokument.
5. Session-Ablauf-Erkennung: Wenn ein Download mit gespeicherter Session
   erneut auf eine Login-Seite umleitet oder 401/403 liefert →
   `sessionExpired = true` → automatisch neuer Login-Versuch (max. 1x pro
   Item, danach `MANUAL_REVIEW`, um Sperren durch wiederholte
   Login-Versuche zu vermeiden).

## J. Multi-Factor-Authentication (MFA)

1. Erkennt der Browser-Microservice nach dem Login ein MFA-Formular
   (TOTP-Feld, SMS-Code-Feld, Push-Bestätigung), gibt er
   `status: "MFA_REQUIRED"` + einen `sessionToken` (Zwischenzustand)
   zurück, **ohne** zu raten oder etwas zu umgehen.
2. n8n markiert das Item `portalAccessStatus = AUTH_REQUIRED`,
   `portalAccessReason = "MFA_REQUIRED"` und schickt per Telegram
   "Send and Wait for Response" (Free Text) eine Nachricht an den
   verantwortlichen Menschen: *"MFA für Portal X nötig – bitte Code
   eingeben"*.
3. Antwortet der Mensch mit dem Code, ruft n8n den Microservice erneut mit
   `{sessionToken, mfaCode}` auf, der den Code im echten Browser einträgt
   und abschließt.
4. Bei Erfolg: Session-Cookies wie unter H speichern und Download
   fortsetzen. Bei Timeout/Fehleingabe: `MANUAL_REVIEW`, kein Retry-Loop
   ohne menschliches Zutun.

## K. Downloads hinter JavaScript-Seiten (SPA)

1. Klassifizierung liefert `BROWSER_REQUIRED` (siehe Abschnitt 3, Punkt 8).
2. Derselbe Browser-Microservice wie unter I wird verwendet, diesmal ohne
   Login: Seite normal laden, auf Netzwerk-Idle/DOM-Ready warten.
3. Der Microservice beobachtet die tatsächlichen Netzwerk-Requests der
   Seite (z. B. via Playwright `page.on('response', ...)`) und filtert auf
   Requests, deren Content-Type/Dateiendung einem Dokument entspricht
   (PDF/ZIP/DOCX/…) – das sind die "echten" Download-URLs, die die SPA im
   Hintergrund lädt.
4. Diese URLs werden inkl. der zu diesem Zeitpunkt gültigen Session-Cookies
   an n8n zurückgegeben; der Core lädt sie dann ganz normal (wie bei
   `DIRECT_FILE`) über `$helpers.httpRequest` mit den übergebenen Cookies.
5. Es wird **nichts** an Schutzmechanismen umgangen – nur eine normale,
   vom Menschen initiierte Seiten-Navigation nachgebildet, wie sie ein
   Browser sowieso ausführen würde.

## O. Zentrale Portal-Konfiguration

Siehe `n8n/adapters/portal-config.md` für die vollständige Tabelle. Struktur
pro Eintrag:

```js
{
  key: "MUENCHEN_VERGABE",
  domain: "vergabe.muenchen.de",
  verified: true,              // wurde real getestet
  requiresAuth: false,
  requiresBrowser: false,
  supportsPublicDownload: true,
  downloadStrategy: "OID_TOKEN",   // Name der Strategie/Adapter-Funktion
  loginStrategy: null,
  parserName: "vergabeMuenchen"
}
```

**Wichtig:** Für alle Portale, die noch nicht real gegen die Zielseite
getestet wurden (`verified: false`), erzwingt der Core **keine** feste
Annahme über `requiresAuth`/`requiresBrowser` – die Klassifizierung erfolgt
live aus der tatsächlichen HTTP-Antwort. Der Konfig-Eintrag ist nur ein
Beschleuniger/Cache für bereits bestätigtes Verhalten, nie eine Garantie.
So wird nie geraten (siehe X).

## P. Sichere Übergabe an Claude/Anthropic

- Nur Items mit `documentAccessStatus == "OK"` und mindestens einem
  erfolgreich heruntergeladenen Binärdokument erreichen den AI-Agent-Node.
- Binärdaten werden 1:1 aus dem n8n-Binary-Objekt an den Anthropic-Node/
  HTTP-Request (Files API bzw. Messages API mit Dokument-Content-Block)
  übergeben – keine Zwischenspeicherung als Klartext, keine Weitergabe von
  Zugangsdaten oder Cookies an Claude.
- Der Prompt an Claude enthält explizit: *"Nutze ausschließlich die
  beigefügten Dokumente. Wenn kein Dokument beigefügt ist, antworte NICHT
  mit einer Einschätzung, sondern melde `documentAccessStatus=PRÜFEN`."*
  Das ist eine zusätzliche Absicherung zur harten Gate-Logik unter R.

## Q. Binärdaten-Handling in n8n

- Mehrere Dateien pro Ausschreibung werden als mehrere Binary-Properties
  am selben Item abgelegt: `binary.doc_0`, `binary.doc_1`, … (nicht als
  mehrere Items), damit ein Item = eine Ausschreibung bleibt.
- Dateiname und Content-Type werden aus (in Prioritätsreihenfolge)
  `Content-Disposition`-Header → URL-Pfad-Segment → Adapter-Metadaten
  ermittelt und in `binary.doc_N.fileName` / `.mimeType` geschrieben.
- ZIP-Dateien werden **nicht** automatisch entpackt (Vermeidung von
  Zip-Bomb-/Pfad-Traversal-Risiken); sie werden als ein Dokument an Claude
  übergeben bzw. bei Bedarf über einen separaten, expliziten
  "Entpacken"-Schritt mit Größen-/Dateianzahl-Limit behandelt.
- Details und vollständiger Code: `n8n/core/document-gate-and-normalization.js`.

## R. Verhindern vorzeitiger Analyse

Der Node "Dokument-Normalisierung & Pre-AI-Gate" prüft **vor** dem
AI-Agent-Node für jedes Item:

```
documentsFound > 0
UND documentsDownloaded == documentsFound   (oder: alle als "relevant" markierten Dokumente)
UND jedes erwartete Binary-Property ist tatsächlich vorhanden und > 0 Bytes
UND kein offener AUTH_REQUIRED/BROWSER_REQUIRED/RATE_LIMITED-Zustand
```

Nur wenn **alle** Bedingungen erfüllt sind, wird `documentAccessStatus =
"OK"` gesetzt und das Item darf zum Merge/AI-Agent weiterlaufen. Sonst
`documentAccessStatus = "PRÜFEN"` und das Item wird über die
IF-Node auf den Telegram-Fehlerzweig geleitet – **es erreicht den
AI-Agent-Node nie**.

## S. / T. `documentAccessStatus` setzen

- **S – OK:** ausschließlich am Ende von "Dokument-Normalisierung &
  Pre-AI-Gate", nachdem alle Downloads verifiziert wurden (siehe R).
  Nirgendwo sonst im Workflow wird dieses Feld auf `OK` gesetzt.
- **T – PRÜFEN:** als Default-Wert bereits beim Erzeugen des Items gesetzt
  (fail-safe: lieber PRÜFEN vergessen zurückzusetzen als OK zu Unrecht
  stehen zu lassen) und explizit bei jedem Fehlerpfad (BLOCKED,
  MANUAL_REVIEW, AUTH_REQUIRED ohne erfolgreichen Retry,
  BROWSER_REQUIRED ohne Ergebnis, Download-Exception, unvollständige
  Dokumente).

## U. Telegram-Fehlermeldungen

Zentral in `n8n/core/telegram-error-messages.js`. Eine Funktion
`buildTelegramMessage(item)` liefert je nach `portalAccessStatus` /
`portalAccessReason` einen fertigen, deutschsprachigen Text für:
Login nötig, MFA nötig, Download fehlgeschlagen, Portal blockiert,
Dokumente unvollständig, manuelle Prüfung nötig – jeweils mit
TED-Nummer, Portal, Link und konkretem Grund, damit ein Mensch ohne
Rückfrage direkt eingreifen kann.

## V. Node-Sparsamkeit

Ergebnis: **6 neue Nodes** im Hauptworkflow + **1 Sub-Workflow mit 2
Nodes**, statt 20 Portal-Workflows oder 20 Switch-Zweigen. Die gesamte
Portal-Intelligenz steckt in Datenstrukturen (`PORTAL_CONFIG`, `ADAPTERS`)
innerhalb eines einzigen Code-Files.

## X. Bei Unsicherheit

Jede Stelle im Core, an der Verhalten nicht eindeutig aus der Antwort
ableitbar ist (unbekannter Content-Type, nicht erkennbares HTML-Muster,
unbestätigter Domain-Eintrag, mehrdeutige Datei-Signatur), setzt
`portalAccessStatus = "MANUAL_REVIEW"` mit einem sprechenden
`portalAccessReason` (z. B. `"UNKNOWN_CONTENT_TYPE:application/x-foo"`) –
es wird an keiner Stelle geraten.

## Y. Priorität

Die Architektur ist entlang der vorgegebenen Priorität gebaut:
Zuverlässigkeit (live-Klassifizierung statt harter Annahmen) →
Portalabdeckung (generischer HTML-Adapter als Fallback für unbekannte
`PUBLIC_HTML_WITH_DOWNLOADS`-Portale) → wenig manuelle Arbeit
(Session-Reuse, Auto-Retry bei 429/5xx) → sichere Sessions (Credential
Store, keine Klartext-Passwörter) → geringe Claude-Kosten (Gate verhindert
Aufrufe ohne Dokumente) → Wartbarkeit (ein Core-File statt 20 Workflows).
