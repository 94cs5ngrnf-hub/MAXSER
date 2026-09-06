# Zentrale Portal-Konfiguration

Die eigentliche Konfiguration lebt als `PORTAL_CONFIG`-Objekt in
[`../core/portal-access-core.js`](../core/portal-access-core.js). Diese Tabelle
ist die Referenz-/Pflege-Übersicht dazu.

| key | domain (best guess) | verified | requiresAuth | requiresBrowser | parserName |
|---|---|---|---|---|---|
| EVERGABE | *(white-label, variiert)* | ❌ | ❌ | ❌ | genericHtml |
| EVERGABE_ONLINE | evergabe-online.de | ❌ | ❌ | ❌ | genericHtml |
| DEUTSCHE_EVERGABE | deutsche-evergabe.de | ❌ | ❌ | ❌ | genericHtml |
| BERLIN_VERGABE | vergabe.berlin.de | ❌ | ❌ | ❌ | genericHtml |
| BRANDENBURG_VERGABE | vergabemarktplatz.brandenburg.de | ❌ | ❌ | ❌ | genericHtml |
| SACHSEN_ANHALT_VERGABE | evergabe.sachsen-anhalt.de | ❌ | ❌ | ❌ | genericHtml |
| SACHSEN_VERGABE | evergabe.sachsen.de | ❌ | ❌ | ❌ | genericHtml |
| MV_LAND_VERGABE | *(unbekannt)* | ❌ | ❌ | ❌ | genericHtml |
| MV_EVERGABE | *(unbekannt)* | ❌ | ❌ | ❌ | genericHtml |
| BAYERN_VERGABE | vergabe.bayern.de | ❌ | ❌ | ❌ | genericHtml |
| **MUENCHEN_VERGABE** | **vergabe.muenchen.de** | ✅ | ❌ | ❌ | **vergabeMuenchen** |
| BADEN_WUERTTEMBERG_VERGABE | *(unbekannt, z.B. vergabe24.de)* | ❌ | ❌ | ❌ | genericHtml |
| DTVP | dtvp.de | ❌ | ❌ | ❌ | genericHtml |
| VMP_RHEINLAND | *(unbekannt)* | ❌ | ❌ | ❌ | genericHtml |
| SUBREPORT | subreport.de | ❌ | ❌ | ❌ | genericHtml |
| BREMEN_VERGABE | vergabe.bremen.de | ❌ | ❌ | ❌ | genericHtml |
| METROPOLE_RUHR | vergabe.metropoleruhr.de | ❌ | ❌ | ❌ | genericHtml |
| AUMASS | *(unbekannt)* | ❌ | ❌ | ❌ | genericHtml |
| HAD_HESSEN | had.de | ❌ | ❌ | ❌ | genericHtml |
| TED | ted.europa.eu | ❌ | ❌ | ❌ | genericHtml |
| ANDERES_PORTAL | *(Fallback)* | – | – | – | genericHtml |

**"verified: ❌" bedeutet nicht "funktioniert nicht"** – es bedeutet, dass die
Domain/Strategie noch nicht gegen die echte Zielseite verifiziert wurde.
Der Universal Response Classifier bestimmt das tatsächliche Verhalten in
jedem Fall live aus der HTTP-Antwort (siehe `docs/architecture.md`,
Abschnitt O). Diese Tabelle dient nur dazu, für bereits bestätigte Portale
(aktuell: München) eine schnellere, spezifischere Extraktion
(`parserName`) zu verwenden, statt immer auf den generischen HTML-Adapter
zurückzufallen.

## Einen neuen Adapter ergänzen

1. In `PORTAL_CONFIG` (in `portal-access-core.js`) den bestehenden Eintrag
   für den Portal-Key um die reale `domain` ergänzen und `verified: true`
   setzen, sobald du das Portal einmal erfolgreich getestet hast.
2. Falls der generische `<a href>`-Adapter (`genericHtml`) die
   Download-Links nicht zuverlässig findet (z.B. weil Links nur über
   JavaScript-Klick-Handler, spezielle `data-*`-Attribute oder eine
   Portal-eigene API erzeugt werden): eine neue Funktion
   `function <portalName>Adapter(html, baseUrl) { ... return { documentUrls, latestVersion, adapterUsed }; }`
   direkt unterhalb der bestehenden Adapter in `portal-access-core.js`
   ergänzen und in das `ADAPTERS`-Objekt eintragen.
3. `parserName` im `PORTAL_CONFIG`-Eintrag auf den neuen Adapter-Namen
   setzen.
4. Braucht das Portal echten Login: Credential-Namen in
   `LOGIN_CREDENTIAL_BY_PORTAL` in `auth-browser-orchestrator.js`
   ergänzen und die zugehörige n8n-Credential mit den echten
   Firmen-Zugangsdaten anlegen.

Kein neuer n8n-Node, kein neuer Workflow – nur ein neuer Eintrag in diesen
beiden Objekten.
