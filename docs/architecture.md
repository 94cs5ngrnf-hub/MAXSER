# Zielarchitektur – Portal-Access-Layer (Revision 2)

Diese Revision ersetzt die Sub-Workflow-Variante mit `$helpers.httpRequest`
vollständig durch echte n8n-Nodes (HTTP Request, IF, Wait, Split Out,
Loop Over Items). Kein Code-Node macht mehr eigene Netzwerk-Calls oder
erzeugt Binärdaten selbst – das übernehmen ausschließlich Standard-Nodes.

## A) Vollständige Node-Reihenfolge

### Hauptworkflow (bestehend, bis auf den letzten Schritt unverändert)

```
Telegram Trigger
→ Auth & Extract
→ Code in JavaScript1
→ HTTP Request TED API
→ Split Out
→ Code Deadline
→ Filter
→ IF Dokument-Link?
   FALSE → Code in JavaScript4 → Telegram (manuelle Prüfliste)
   TRUE  → Code in JavaScript2
         → Code in JavaScript3
         → Telegram Send and Wait for Response
         → Code in JavaScript5
         → Execute Workflow: "MAXSER – Portal Access Core"   ◄── NEU, einziger neuer Node im Hauptflow bis hierhin
         → IF: documentAccessStatus == "OK"?
              TRUE  → Merge (falls mehrere Quellen) → AI Agent (Claude)
              FALSE → Code: Telegram-Fehlermeldung → Telegram
```

Der Hauptworkflow bekommt dadurch nur **3 neue Nodes**: `Execute Workflow`,
die abschließende `IF`, und den `Code: Telegram-Fehlermeldung`-Zweig. Die
gesamte Portal-Komplexität steckt im Sub-Workflow.

### Sub-Workflow "MAXSER – Portal Access Core"

```
Execute Workflow Trigger
→ Code: Prepare Request                          (prepare-request.js)
→ HTTP Request: Probe                             [Loop-Ziel A]
→ Code: Universal Classifier + Adapter Router      (portal-access-core.js)
→ IF: needsRetry == true?
     TRUE  → Wait (amount = {{$json.backoffMs}} ms) → zurück zu [Loop-Ziel A]
     FALSE → weiter
→ IF: documentsFound > 1  UND  isDirectFile == false?
     TRUE  → Split Out (Feld: documentUrls → documentUrl)
           → Code: Add Doc Index                   (add-doc-index.js)
           → Loop Over Items (Batch-Größe 1)        [Loop-Ziel B]
                --loop--> HTTP Request: Download Dokument
                        → Code: Universal Classifier + Adapter Router (derselbe Code wie oben, isDocumentSubFetch=true)
                        → zurück zu [Loop-Ziel B] (Loop-Over-Items-Input)
                --done--> Code: Dokument-Aggregation & Gate  (document-aggregation-and-gate.js)
     FALSE → Code: Dokument-Aggregation & Gate  (derselbe Node – zweite eingehende Verbindung)
→ NoOp: Return to Main Workflow
```

**Beide Zweige der zweiten IF münden im selben "Dokument-Aggregation &
Gate"-Node** (zwei eingehende Verbindungen auf denselben Node-Input – in
n8n normal und kein eigener Merge-Node nötig, da pro Ausführung immer nur
einer der beiden Zweige tatsächlich Items liefert).

`AUTH_REQUIRED` / `BROWSER_REQUIRED` / `BLOCKED` / `MANUAL_REVIEW` (ohne
Downloadlinks) landen automatisch im FALSE-Zweig der zweiten IF (weil
`documentsFound` dort 0 ist) und laufen direkt in den Gate-Node, der sie
unverändert als `documentAccessStatus = PRÜFEN` weiterreicht.

## B) Welche alten Nodes du (nach erfolgreichem Paralleltest, siehe O) löschen kannst

- `HTTP Request1` (der bisherige gemeinsame GET-Node ohne Klassifizierung)
- Jeglicher bereits begonnene `Switch nach procurementPortal` mit vielen
  Ausgängen
- Alle bereits angefangenen Einzel-Portal-Branches/Workflows

**Nicht löschen:** alles bis einschließlich `Code in JavaScript5` bleibt
unverändert.

## C) Welche neuen Nodes du erstellen musst

**Hauptworkflow:**
1. `Execute Workflow` – "MAXSER – Portal Access Core"
2. `IF` – documentAccessStatus == "OK"
3. `Code` – Telegram-Fehlermeldung

**Sub-Workflow "MAXSER – Portal Access Core" (neu anlegen):**
4. `Execute Workflow Trigger`
5. `Code` – Prepare Request
6. `HTTP Request` – Probe
7. `Code` – Universal Classifier + Adapter Router (Instanz 1)
8. `IF` – needsRetry
9. `Wait` – Backoff
10. `IF` – documentsFound > 1 und nicht isDirectFile
11. `Split Out` – documentUrls → documentUrl
12. `Code` – Add Doc Index
13. `Loop Over Items` – Batch-Größe 1
14. `HTTP Request` – Download Dokument
15. `Code` – Universal Classifier + Adapter Router (Instanz 2, identischer Code, andere Position)
16. `Code` – Dokument-Aggregation & Gate
17. `NoOp` – Return to Main Workflow

Siehe Abschnitt D für die exakten Einstellungen jedes Nodes.

## D) Node-Einstellungen im Detail

### 1. `Execute Workflow` (Hauptworkflow)
- **Source**: Database (Workflow auswählen: "MAXSER – Portal Access Core")
- **Mode**: "Run Once for All Items" (falls die Node-Version das anbietet) bzw. Standard
- Eingabefelder werden 1:1 durchgereicht (firstDocumentUrl, procurementPortal,
  publication-number, selectedNumber, selectedForAnalysis, alle Tender-Felder)

### 5. `Code` – Prepare Request
- Sprache: JavaScript, Modus: "Run Once for All Items"
- Code: `n8n/core/prepare-request.js` (vollständig, siehe Antwort Abschnitt E/Repo)

### 6. `HTTP Request` – Probe
- Method: `GET`
- URL: `={{ $json.requestUrl }}`
- Authentication: None
- **Options → Response**:
  - Response Format: `File`
  - "Full Response" / "Include Response Headers and Status": **AN**
    (Label variiert je n8n-Version – wichtig ist: Ergebnis muss
    `statusCode` und `headers` im JSON enthalten, testen und prüfen)
- **Options → Redirects**: "Follow Redirects": AN (Standard)
- **Settings-Tab**:
  - "Always Output Data": AN (WICHTIG – sonst bricht die Ausführung bei
    z.B. 404 ab, obwohl "Never Error" das eigentlich verhindern soll)
  - "On Error": **Continue (using error output)** – so bekommt der
    Classifier auch bei echten Netzwerkfehlern (Timeout, DNS) ein Item
    mit `error`-Feld statt dass die ganze Ausführung abbricht
  - "Retry On Fail": AN, Max Tries: 3, Wait Between Tries: 2000 ms
    (deckt reine Netzwerkfehler ab; 429/5xx-Retry läuft separat über die
    IF+Wait-Schleife unten, weil dafür der Statuscode ausgewertet werden muss)
- **Header Parameters**:
  - `Cookie` = `={{ $json.sessionCookiesHeader }}`
- **Options**: "Never Error" / "Ignore Response Code": AN (Statuscode wird
  vom Classifier ausgewertet, nicht vom Node geworfen)

### 7. / 15. `Code` – Universal Classifier + Adapter Router
- Sprache: JavaScript, Modus: "Run Once for All Items"
- Code: `n8n/core/portal-access-core.js` (identisch an beiden Stellen einfügen)

### 8. `IF` – needsRetry
- Bedingung: `{{ $json.needsRetry }}` **is true** (Boolean)
- TRUE → `Wait`
- FALSE → weiter zur nächsten IF

### 9. `Wait` – Backoff
- Resume: "After Time Interval"
- Amount: `={{ $json.backoffMs }}`
- Unit: Milliseconds
- Ausgang verbindest du zurück auf den Eingang von `HTTP Request: Probe`
  (echte Schleife im Canvas – das ist in n8n normal und unterstützt)

### 10. `IF` – documentsFound > 1 und nicht isDirectFile
- Bedingung 1: `{{ $json.documentsFound }}` **larger than** `1`
- Bedingung 2 (AND): `{{ $json.isDirectFile }}` **is false**
- TRUE → `Split Out`
- FALSE → direkt zu `Code: Dokument-Aggregation & Gate`

### 11. `Split Out`
- Field to Split Out: `documentUrls`
- Destination Field Name: `documentUrl`
- (alle übrigen Felder werden von Split Out automatisch auf jedes neue
  Item kopiert – inkl. `_tenderKey`, `procurementPortal`,
  `sessionCookiesHeader`)

### 12. `Code` – Add Doc Index
- Modus: "Run Once for All Items"
- Code: `n8n/core/add-doc-index.js`

### 13. `Loop Over Items` (Split In Batches)
- Batch Size: `1`
- Ausgang "loop" → `HTTP Request: Download Dokument`
- Ausgang "done" → `Code: Dokument-Aggregation & Gate`

### 14. `HTTP Request` – Download Dokument
- Identische Einstellungen wie "HTTP Request: Probe" (Method GET, URL
  `={{ $json.requestUrl }}`, Response Format File, Full Response AN,
  Never Error AN, Header `Cookie` = `={{ $json.sessionCookiesHeader }}`,
  Retry On Fail AN)
- Ausgang → `Code: Universal Classifier + Adapter Router` (Instanz 2)
  → zurück auf den Eingang von `Loop Over Items`

### 16. `Code` – Dokument-Aggregation & Gate
- Modus: "Run Once for All Items"
- Code: `n8n/core/document-aggregation-and-gate.js`
- Zwei eingehende Verbindungen: von `IF (10)`-FALSE-Zweig UND von
  `Loop Over Items`-"done"-Ausgang

### 17. `NoOp` – Return to Main Workflow
- Reine Passthrough-Node, damit der Sub-Workflow einen klaren Endpunkt hat
  (n8n gibt bei "Execute Workflow" ohnehin die Items des letzten
  ausgeführten Nodes zurück – NoOp macht das im Canvas nur sichtbar/eindeutig)

### Hauptworkflow – Rest
- `IF: documentAccessStatus == "OK"` → Bedingung: `{{ $json.documentAccessStatus }}` **equals** `OK`
- `Code: Telegram-Fehlermeldung` → Code: `n8n/core/telegram-error-messages.js`
- Telegram-Node danach: Text = `={{ $json.telegramMessage }}`

## E)–L) Vollständiger Code

Siehe Chat-Antwort (Abschnitte E–L) sowie die Repo-Dateien:
- `n8n/core/portal-access-core.js` – E) Universal Classifier + F) Adapter Router + J) Cookie/Session + K) Retry-Berechnung
- `n8n/core/document-aggregation-and-gate.js` – G) Aggregation/Gate
- `n8n/core/telegram-error-messages.js` – H) Telegram-Fehlermeldungen
- `n8n/core/prepare-request.js`, `n8n/core/add-doc-index.js` – Hilfs-Nodes für I) die Download-Schleife

## L) Auth/MFA/Browser – ehrlicher Stand

Der Portal Access Core **erkennt** AUTH_REQUIRED/BROWSER_REQUIRED/
BLOCKED strukturell und versucht **bewusst keinen** automatischen Login –
das entspricht deiner ursprünglichen Vorgabe ("wenn Zugang nicht
rechtssicher automatisierbar ist: sauber auf MANUAL_REVIEW setzen").

Ein Code-Node kann `this.getCredentials(...)` NICHT garantiert nutzen und
soll es laut deiner Vorgabe auch nicht. Für einen **später** ergänzten
echten Login gibt es genau zwei mit Standard-Mitteln garantiert
funktionierende Wege – beide ohne Credentials im Code:

1. **HTTP Basic/Header/OAuth2/Digest/Query Auth**: Im `HTTP Request`-Node
   selbst unter "Authentication" → "Generic Credential Type" eine
   n8n-Credential auswählen. n8n injiziert die Zugangsdaten dann intern,
   ohne dass sie je im Code sichtbar werden. Funktioniert NUR, wenn das
   Portal einen dieser Standard-Auth-Mechanismen unterstützt (nicht bei
   klassischen HTML-Login-Formularen).
2. **Klassisches HTML-Formular-Login + MFA + SPA-Rendering**: Dafür gibt
   es keinen 100% garantierten Weg mit nur Bordmitteln – das ist eine
   ehrliche, strukturelle Grenze von n8n. Der reguläre, empfohlene Weg
   ist der **community node `n8n-nodes-puppeteer`** (ein echter,
   installierbarer n8n-Community-Node, keine theoretische API), der
   einen echten Browser steuert: Login-Formular ausfüllen (Zugangsdaten
   aus einer n8n-Credential, vom Node selbst geladen – nicht von deinem
   Code), auf MFA-Formular warten (→ Telegram-Pause, siehe Punkt 12),
   Session-Cookies auslesen und an den Portal Access Core zurückgeben.
   Das ist ein separates Vorhaben (Node installieren, Flow bauen) und
   bewusst nicht Teil dieser Lieferung, um keine ungeprüfte Lösung als
   fertig auszugeben.

Bis dahin: `AUTH_REQUIRED`/`BROWSER_REQUIRED`/`MFA_REQUIRED` (`mfaRequired`
ist im Core-Code als Feld reserviert, wird aber nie auf `true` gesetzt,
solange kein Login-Node existiert) laufen sauber in den Telegram-
Fehlerzweig statt in einen unfertigen Automatisierungsversuch.
