# Zentrale Portal-Konfiguration

Die eigentliche Konfiguration lebt als `PORTAL_CONFIG`- und `ADAPTERS`-Objekt
in [`../core/portal-access-core.js`](../core/portal-access-core.js). Diese
Tabelle ist die Referenz-/Pflege-Übersicht dazu.

| key | domain (best guess) | verified | parserName | Adapter-Verhalten heute |
|---|---|---|---|---|
| EVERGABE | *(white-label, variiert je Betreiber)* | ❌ | genericHtml | generisch |
| EVERGABE_ONLINE | evergabe-online.de | ❌ | evergabeOnline | generisch, eigener Name |
| DEUTSCHE_EVERGABE | deutsche-evergabe.de | ❌ | deutscheEvergabe | generisch, eigener Name |
| BERLIN_VERGABE | vergabe.berlin.de | ❌ | berlinVergabe | generisch, eigener Name |
| BRANDENBURG_VERGABE | vergabemarktplatz.brandenburg.de | ❌ | brandenburgVergabe | generisch, eigener Name |
| SACHSEN_ANHALT_VERGABE | evergabe.sachsen-anhalt.de | ❌ | sachsenAnhaltVergabe | generisch, eigener Name |
| SACHSEN_VERGABE | evergabe.sachsen.de | ❌ | sachsenVergabe | generisch, eigener Name |
| MV_LAND_VERGABE | *(unbekannt)* | ❌ | genericHtml | generisch |
| MV_EVERGABE | *(unbekannt)* | ❌ | genericHtml | generisch |
| BAYERN_VERGABE | vergabe.bayern.de | ❌ | bayernVergabe | generisch, eigener Name |
| **MUENCHEN_VERGABE** | **vergabe.muenchen.de** | ✅ | **vergabeMuenchen** | **portalspezifisch (oid/token)** |
| BADEN_WUERTTEMBERG_VERGABE | *(unbekannt, z.B. vergabe24.de)* | ❌ | genericHtml | generisch |
| DTVP | dtvp.de | ❌ | dtvp | generisch, eigener Name |
| VMP_RHEINLAND | *(unbekannt)* | ❌ | genericHtml | generisch |
| SUBREPORT | subreport.de | ❌ | subreport | generisch, eigener Name |
| BREMEN_VERGABE | vergabe.bremen.de | ❌ | bremenVergabe | generisch, eigener Name |
| METROPOLE_RUHR | vergabe.metropoleruhr.de | ❌ | genericHtml | generisch |
| AUMASS | *(unbekannt)* | ❌ | genericHtml | generisch |
| HAD_HESSEN | had.de | ❌ | hadHessen | generisch, eigener Name |
| TED | ted.europa.eu | ❌ | genericHtml | generisch |
| ANDERES_PORTAL | *(Fallback)* | – | genericHtml | generisch |

**Wichtig, ehrlich:** Die "eigener Name"-Adapter (`evergabeOnline`,
`deutscheEvergabe`, `berlinVergabe`, `brandenburgVergabe`,
`sachsenVergabe`, `sachsenAnhaltVergabe`, `bayernVergabe`, `dtvp`,
`subreport`, `bremenVergabe`, `hadHessen`) verhalten sich **aktuell 1:1
wie `genericHtml`** (normale `<a href>`- und `data-*`-Linkerkennung). Ich
habe für diese Portale keine verifizierte, abweichende HTML-Struktur –
sie sind bewusst schon als eigene Funktionen im `ADAPTERS`-Objekt
angelegt, damit du sie **später**, sobald du die reale Struktur eines
Portals kennst, einzeln durch eine spezifische Extraktion ersetzen kannst
(genau wie `vergabeMuenchen`), ohne `PORTAL_CONFIG` oder den Router
anzufassen.

**"verified: ❌" bedeutet nicht "funktioniert nicht"** – der Universal
Classifier bestimmt `portalAccessStatus` in jedem Fall live aus der
tatsächlichen HTTP-Antwort, unabhängig vom `verified`-Flag. Die Tabelle
ist nur ein Beschleuniger-Cache für bereits bestätigtes Verhalten.

## Einen neuen/spezifischen Adapter ergänzen

1. In `PORTAL_CONFIG` (in `portal-access-core.js`) die reale `domain`
   ergänzen und `verified: true` setzen, sobald du das Portal einmal
   erfolgreich getestet hast.
2. Verhält sich ein Portal NICHT wie `genericHtml` (z.B. weil Links nur
   über JavaScript-Klick-Handler, spezielle `data-*`-Attribute oder eine
   Portal-eigene API mit IDs/Tokens erzeugt werden): die passende
   Platzhalter-Funktion im `ADAPTERS`-Objekt (z.B. `dtvp: makeNamedGenericAdapter("dtvp")`)
   durch eine echte, eigene Funktion ersetzen – Vorbild ist
   `vergabeMuenchenAdapter` (sucht nach real im HTML vorhandenen Links,
   erfindet nie eine URL; findet sie keine, setzt sie
   `downloadResolverRequired: true` + die extrahierten Metadaten statt zu
   raten).
3. `parserName` im `PORTAL_CONFIG`-Eintrag zeigt bereits auf den
   richtigen Namen – nichts weiter anzupassen.
4. Braucht das Portal echten Login: siehe `docs/architecture.md`,
   Abschnitt L (Generic-Credential-HTTP-Node für Basic/Header/OAuth-Auth,
   oder ein Browser-Automation-Community-Node für klassische
   Formular-Logins/MFA – niemals Zugangsdaten im Code).

Kein neuer n8n-Node, kein neuer Workflow – nur ein neuer/geänderter
Funktionskörper im `ADAPTERS`-Objekt.
