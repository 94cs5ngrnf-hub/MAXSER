/**
 * MAXSER – Portal Access Core (Revision 2 – produktionsgeprüft)
 * ================================================================
 * Einziger Code-Node im Sub-Workflow "MAXSER – Portal Access Core".
 * Wird per "Execute Workflow" aus dem Hauptworkflow aufgerufen.
 *
 * Node-Modus: "Run Once for All Items"
 * Sub-Workflow-Aufbau: [Execute Workflow Trigger] -> [dieser Code-Node] -> [NoOp]
 *
 * VORAUSSETZUNG (bitte vor Produktivbetrieb einmal verifizieren):
 * n8n-Version mit `$helpers.httpRequest` / `$helpers.prepareBinaryData`
 * im Code-Node (n8n ≥ ~1.19, self-hosted oder Cloud). Prüfen:
 * in einem leeren Code-Node `return [{json:{ok: typeof $helpers}}]`
 * ausführen – muss "object" liefern, nicht "undefined".
 *
 * Erwartete Eingabe je Item (json):
 *   - procurementPortal   (z.B. "MUENCHEN_VERGABE", "TED", "ANDERES_PORTAL", ...)
 *   - firstDocumentUrl    (String, URL)
 *   - documentUrls        (Array<String>, optional – weitere bekannte Links)
 *   - tedNumber / noticeNumber / id (irgendein Ausschreibungs-Identifier, für Logging)
 *
 * Erzeugte Ausgabe je Item (json), zusätzlich zu allen Eingabefeldern:
 *   portalAccessStatus, portalAccessReason, sourceUrl, finalUrl, httpStatus,
 *   contentType, isDirectFile, isHtmlPage, authRequired, sessionRequired,
 *   browserRequired, rateLimited, documentsFound, documentsDownloaded,
 *   documentNames, documentUrls, documentMimeTypes, downloadSucceeded,
 *   manualReviewRequired, loginRequired, portalAdapterUsed,
 *   latestVersionDetected, processingErrors, sessionCookies
 * Binärdaten: item.binary.doc_0, doc_1, ...
 *
 * Dieser Node setzt NIEMALS documentAccessStatus (das macht ausschließlich
 * der separate "Dokument-Normalisierung & Pre-AI-Gate"-Node danach). Er
 * liefert dafür aber die Rohdaten (documentsFound/documentsDownloaded/
 * downloadSucceeded/binary), auf denen dieses Gate aufbaut – siehe R/S/T
 * in docs/architecture.md.
 */

// =====================================================================
// 0. SICHERHEITS-/RESSOURCEN-LIMITS
// =====================================================================
const MAX_RETRIES = 3; // + 1 Erstversuch = max. 4 Requests pro URL
const MAX_REDIRECTS = 8;
const MAX_DOWNLOAD_BYTES = 60 * 1024 * 1024; // 60 MB – realistische Obergrenze für Vergabeunterlagen
const INLINE_RETRY_MAX_WAIT_MS = 15000; // längere Wartezeiten NICHT im Code-Node blockieren (siehe G)
const REQUEST_TIMEOUT_MS = 30000;
const MIN_PLAUSIBLE_FILE_BYTES = 16; // 0-Byte-/Trunkierte Antworten nicht als Datei durchwinken

// =====================================================================
// 1. ZENTRALE PORTAL-KONFIGURATION (Teil O)
// =====================================================================
// verified:false => Klassifizierung erfolgt IMMER live aus der echten
// HTTP-Antwort. Die Flags hier sind nur ein Beschleuniger/Cache für
// bereits real getestete Portale (siehe docs/architecture.md, Abschnitt O).
const PORTAL_CONFIG = {
  EVERGABE: { domain: null, verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  EVERGABE_ONLINE: { domain: "evergabe-online.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  DEUTSCHE_EVERGABE: { domain: "deutsche-evergabe.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  BERLIN_VERGABE: { domain: "vergabe.berlin.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  BRANDENBURG_VERGABE: { domain: "vergabemarktplatz.brandenburg.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  SACHSEN_ANHALT_VERGABE: { domain: "evergabe.sachsen-anhalt.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  SACHSEN_VERGABE: { domain: "evergabe.sachsen.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  MV_LAND_VERGABE: { domain: null, verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  MV_EVERGABE: { domain: null, verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  BAYERN_VERGABE: { domain: "vergabe.bayern.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  MUENCHEN_VERGABE: { domain: "vergabe.muenchen.de", verified: true, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "OID_TOKEN", loginStrategy: null, parserName: "vergabeMuenchen" },
  BADEN_WUERTTEMBERG_VERGABE: { domain: null, verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  DTVP: { domain: "dtvp.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  VMP_RHEINLAND: { domain: null, verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  SUBREPORT: { domain: "subreport.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  BREMEN_VERGABE: { domain: "vergabe.bremen.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  METROPOLE_RUHR: { domain: "vergabe.metropoleruhr.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  AUMASS: { domain: null, verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  HAD_HESSEN: { domain: "had.de", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  TED: { domain: "ted.europa.eu", verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
  ANDERES_PORTAL: { domain: null, verified: false, requiresAuth: false, requiresBrowser: false, supportsPublicDownload: true, downloadStrategy: "AUTO", loginStrategy: null, parserName: "genericHtml" },
};
// Hinweis: Nicht als "domain" markierte bzw. verified:false Einträge sind
// unbestätigte Best-Guess-Domains. Vor Produktivbetrieb je Portal einmal
// real testen und dann verified:true + passende downloadStrategy setzen.

function getPortalConfig(procurementPortal, url) {
  const cfg = PORTAL_CONFIG[procurementPortal] || PORTAL_CONFIG.ANDERES_PORTAL;
  const host = safeHostname(url);
  return { ...cfg, resolvedDomain: host || cfg.domain, portalKey: procurementPortal || "ANDERES_PORTAL" };
}

function safeHostname(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return null; }
}

// =====================================================================
// 2. URL-RESOLVER (Teil E) – relative Links absolut machen
// =====================================================================
function resolveUrl(maybeRelativeUrl, baseUrl) {
  if (!maybeRelativeUrl) return null;
  const trimmed = String(maybeRelativeUrl).trim();
  if (!trimmed || /^(javascript|mailto|tel):/i.test(trimmed) || trimmed.startsWith("#")) return null;
  try {
    // new URL() löst protokollrelative ("//host/..."), absolute und
    // relative ("../x", "x/y.pdf") Pfade gegen baseUrl korrekt auf.
    const resolved = new URL(trimmed, baseUrl);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return resolved.toString();
  } catch (e) {
    return null;
  }
}

function absolutizeAll(urls, baseUrl) {
  const out = [];
  const seen = new Set();
  for (const u of urls || []) {
    const abs = resolveUrl(u, baseUrl);
    if (abs && !seen.has(abs)) { seen.add(abs); out.push(abs); }
  }
  return out;
}

// =====================================================================
// 3. TEXT-DEKODIERUNG (deutsche Portale liefern oft ISO-8859-1/CP-1252
//    statt UTF-8 – wichtig für die HTML-Sniffing-/Adapter-Logik)
// =====================================================================
function detectDeclaredCharset(contentTypeHeader, buffer) {
  const ctMatch = (contentTypeHeader || "").match(/charset\s*=\s*"?([\w-]+)"?/i);
  if (ctMatch) return ctMatch[1].toLowerCase();
  // <meta charset> / <meta http-equiv content=".."> nur in den ersten Bytes suchen,
  // dabei als latin1 lesen, damit ASCII-Marker unabhängig von der echten
  // Kodierung sicher erkannt werden.
  const head = buffer.slice(0, 1024).toString("latin1");
  const metaCharset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (metaCharset) return metaCharset[1].toLowerCase();
  return null;
}

function decodeBody(buffer, contentTypeHeader) {
  const declared = detectDeclaredCharset(contentTypeHeader, buffer);
  // Node kennt "latin1" nativ als Alias für ISO-8859-1. Das ist für
  // Windows-1252 nicht byte-exakt (Bereich 0x80-0x9F unterscheidet sich),
  // reicht aber für Muster-/Keyword-Erkennung in diesem Node aus.
  if (declared && /iso-8859-1|latin1|windows-1252|cp1252/i.test(declared)) {
    return buffer.toString("latin1");
  }
  return buffer.toString("utf8");
}

// =====================================================================
// 4. DATEI-ERKENNUNG: Content-Type + Magic Bytes (Teil D)
// =====================================================================
const MAGIC_SIGNATURES = [
  { type: "PDF", check: (b) => b.length >= 4 && b.slice(0, 4).toString("latin1") === "%PDF" },
  { type: "ZIP_FAMILY", check: (b) => b.length >= 4 && (
      (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) ||
      (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x05 && b[3] === 0x06) ||
      (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x07 && b[3] === 0x08)
    ) },
  // Legacy .doc/.xls (OLE Compound File Binary Format) – gemeinsame Signatur,
  // Sub-Typ NUR über Extension/Content-Type unterscheidbar (siehe unten).
  { type: "OLE_COMPOUND", check: (b) => b.length >= 8 &&
      b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
      b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1 },
];

const EXTENSION_MIME_MAP = {
  pdf: "application/pdf",
  zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword",
  xls: "application/vnd.ms-excel",
  csv: "text/csv",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
};

function sniffTextKind(buffer, contentTypeHeader) {
  const sample = decodeBody(buffer.slice(0, 2048), contentTypeHeader).trim();
  if (/^<\?xml/i.test(sample)) return "XML";
  if (/^<!doctype html/i.test(sample) || /<html[\s>]/i.test(sample.slice(0, 500))) return "HTML";
  // sehr einfache CSV-Heuristik: mind. 2 Zeilen mit übereinstimmender Trennzeichen-Anzahl
  const lines = sample.split(/\r?\n/).filter(Boolean).slice(0, 5);
  if (lines.length >= 2) {
    const counts = lines.map((l) => (l.match(/[;,]/g) || []).length);
    if (counts[0] > 0 && counts.every((c) => c === counts[0])) return "CSV";
  }
  return null;
}

function getExtensionFromUrl(url) {
  try {
    const path = new URL(url).pathname;
    const m = path.match(/\.([a-zA-Z0-9]{2,5})$/);
    return m ? m[1].toLowerCase() : null;
  } catch (e) { return null; }
}

function getFilenameFromContentDisposition(headerValue) {
  if (!headerValue) return null;
  const star = headerValue.match(/filename\*\s*=\s*[^']*''([^;]+)/i);
  if (star) { try { return decodeURIComponent(star[1].trim().replace(/["']/g, "")); } catch (e) { /* fallthrough */ } }
  const plain = headerValue.match(/filename\s*=\s*"?([^";]+)"?/i);
  return plain ? plain[1].trim() : null;
}

/**
 * Kombinierte Datei-Erkennung. Ergebnis ist entweder eine sichere
 * Klassifizierung oder { kind: "UNKNOWN", reason: "..." } – dann NICHT
 * raten, sondern MANUAL_REVIEW auslösen (Teil X).
 */
function detectFileType({ buffer, contentTypeHeader, url, contentDisposition }) {
  const ctHeader = (contentTypeHeader || "").split(";")[0].trim().toLowerCase();
  const extFromUrl = getExtensionFromUrl(url);
  const filenameFromCd = getFilenameFromContentDisposition(contentDisposition);
  const extFromCd = filenameFromCd ? (filenameFromCd.match(/\.([a-zA-Z0-9]{2,5})$/) || [])[1] : null;
  const declaredExt = (extFromCd || extFromUrl || "").toLowerCase();

  // Leere oder verdächtig kleine Antworten nie als echte Datei durchwinken,
  // selbst wenn der Content-Type-Header etwas anderes behauptet.
  if (!buffer || buffer.length < MIN_PLAUSIBLE_FILE_BYTES) {
    return { kind: "UNKNOWN", mime: ctHeader || null, ext: declaredExt || null, isFile: false, source: "none", reason: `EMPTY_OR_TOO_SMALL_BODY:${buffer ? buffer.length : 0}bytes` };
  }

  let magicType = null;
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.check(buffer)) { magicType = sig.type; break; }
  }
  if (!magicType) {
    magicType = sniffTextKind(buffer, contentTypeHeader);
  }

  // Fall 1: Magic Bytes sagen eindeutig PDF -> vertrauen, unabhängig vom Header.
  if (magicType === "PDF") {
    return { kind: "PDF", mime: "application/pdf", ext: "pdf", isFile: true, source: "magic" };
  }

  // Fall 2: ZIP-Familie per Magic Bytes bestätigt -> Feinunterscheidung über Header/Extension.
  if (magicType === "ZIP_FAMILY") {
    if (declaredExt === "docx" || ctHeader.includes("wordprocessingml")) {
      return { kind: "DOCX", mime: EXTENSION_MIME_MAP.docx, ext: "docx", isFile: true, source: "magic+header" };
    }
    if (declaredExt === "xlsx" || ctHeader.includes("spreadsheetml")) {
      return { kind: "XLSX", mime: EXTENSION_MIME_MAP.xlsx, ext: "xlsx", isFile: true, source: "magic+header" };
    }
    return { kind: "ZIP", mime: "application/zip", ext: "zip", isFile: true, source: "magic" };
  }

  // Fall 3: Legacy OLE-Container (.doc/.xls) -> Feinunterscheidung nur über
  // Extension/Content-Type möglich (Magic Bytes sind für beide identisch).
  if (magicType === "OLE_COMPOUND") {
    if (declaredExt === "xls" || ctHeader === "application/vnd.ms-excel") {
      return { kind: "XLS", mime: EXTENSION_MIME_MAP.xls, ext: "xls", isFile: true, source: "magic+header" };
    }
    if (declaredExt === "doc" || ctHeader === "application/msword") {
      return { kind: "DOC", mime: EXTENSION_MIME_MAP.doc, ext: "doc", isFile: true, source: "magic+header" };
    }
    // Sub-Typ unklar, aber es ist zweifelsfrei ein echtes Office-Binärdokument
    // -> als Datei behandeln (nicht MANUAL_REVIEW), nur der genaue Typ bleibt offen.
    return { kind: "OLE_DOCUMENT", mime: "application/octet-stream", ext: declaredExt || "doc", isFile: true, source: "magic-ambiguous-subtype" };
  }

  // Fall 4: Text-artige Formate per Sniff (XML/HTML/CSV).
  if (magicType === "XML" || magicType === "HTML" || magicType === "CSV") {
    return { kind: magicType, mime: EXTENSION_MIME_MAP[magicType.toLowerCase()] || null, ext: magicType.toLowerCase(), isFile: magicType !== "HTML", source: "sniff" };
  }

  // Fall 5: Kein Sniff-Treffer -> auf Content-Type-Header zurückfallen, wenn eindeutig.
  if (ctHeader === "application/pdf") return { kind: "PDF", mime: ctHeader, ext: "pdf", isFile: true, source: "header" };
  if (ctHeader === "application/zip" || ctHeader === "application/x-zip-compressed") return { kind: "ZIP", mime: ctHeader, ext: "zip", isFile: true, source: "header" };
  if (ctHeader.includes("wordprocessingml")) return { kind: "DOCX", mime: ctHeader, ext: "docx", isFile: true, source: "header" };
  if (ctHeader.includes("spreadsheetml")) return { kind: "XLSX", mime: ctHeader, ext: "xlsx", isFile: true, source: "header" };
  if (ctHeader === "application/msword") return { kind: "DOC", mime: ctHeader, ext: "doc", isFile: true, source: "header" };
  if (ctHeader === "application/vnd.ms-excel") return { kind: "XLS", mime: ctHeader, ext: "xls", isFile: true, source: "header" };
  if (ctHeader === "text/csv") return { kind: "CSV", mime: ctHeader, ext: "csv", isFile: true, source: "header" };
  if (ctHeader === "application/xml" || ctHeader === "text/xml") return { kind: "XML", mime: ctHeader, ext: "xml", isFile: true, source: "header" };
  if (ctHeader === "text/html") return { kind: "HTML", mime: ctHeader, ext: "html", isFile: false, source: "header" };

  // Fall 6: gar nichts Eindeutiges -> nicht raten.
  return { kind: "UNKNOWN", mime: ctHeader || null, ext: declaredExt || null, isFile: false, source: "none", reason: `UNKNOWN_CONTENT_TYPE:${ctHeader || "n/a"}` };
}

// =====================================================================
// 5. COOKIE-JAR / SESSION-PERSISTENZ (Teil H)
// =====================================================================
function parseSetCookies(headers) {
  const raw = headers && (headers["set-cookie"] || headers["Set-Cookie"]);
  if (!raw) return {};
  const list = Array.isArray(raw) ? raw : [raw];
  const jar = {};
  for (const line of list) {
    const kv = line.split(";")[0];
    const idx = kv.indexOf("=");
    if (idx > 0) jar[kv.slice(0, idx).trim()] = kv.slice(idx + 1).trim();
  }
  return jar;
}

function mergeCookies(existing, fresh) {
  return { ...(existing || {}), ...(fresh || {}) };
}

function cookiesToHeader(jar) {
  if (!jar || !Object.keys(jar).length) return undefined;
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

function loadPersistedSession(staticData, domain) {
  const store = staticData.sessions || {};
  const entry = store[domain];
  if (entry && entry.expiresAt && entry.expiresAt > Date.now()) return entry.cookies;
  return null;
}

function persistSession(staticData, domain, cookies, ttlMs = 25 * 60 * 1000) {
  if (!staticData.sessions) staticData.sessions = {};
  staticData.sessions[domain] = { cookies, expiresAt: Date.now() + ttlMs };
}

// =====================================================================
// 6. HTTP-KERN: manueller Redirect-Walk (damit Cookies aus Zwischen-Hops
//    NICHT verloren gehen) + Retry/Backoff + Fehlerhandler (Teile F, G, H)
// =====================================================================
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseRetryAfter(headers) {
  const val = headers && (headers["retry-after"] || headers["Retry-After"]);
  if (!val) return null;
  const asInt = parseInt(val, 10);
  if (!Number.isNaN(asInt) && String(asInt) === String(val).trim()) return asInt * 1000;
  const asDate = Date.parse(val);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Führt EINEN logischen "Seitenbesuch" aus: folgt 3xx-Redirects manuell
 * (statt der eingebauten Auto-Redirect-Funktion), damit Set-Cookie-Header
 * aus Zwischen-Hops nicht verloren gehen (n8n/axios würde sie sonst
 * stillschweigend verwerfen). Wirft NICHT bei HTTP-Fehlerstatus.
 *
 * WICHTIG: `disableFollowRedirect` ist das dokumentierte n8n-Feld, um das
 * automatische Redirect-Following von $helpers.httpRequest abzuschalten.
 * Ohne diese manuelle Schleife würde n8n selbst folgen, aber die dabei
 * gesetzten Cookies wären für uns unsichtbar.
 */
async function followRedirectsManually(helpers, { startUrl, cookieJar }) {
  let currentUrl = startUrl;
  let jar = { ...(cookieJar || {}) };
  let hops = 0;

  while (true) {
    let response;
    try {
      response = await helpers.httpRequest({
        url: currentUrl,
        method: "GET",
        headers: cookiesToHeader(jar) ? { Cookie: cookiesToHeader(jar) } : {},
        encoding: "arraybuffer",
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        disableFollowRedirect: true,
        timeout: REQUEST_TIMEOUT_MS,
      });
    } catch (err) {
      // Manche n8n-Versionen werfen trotz ignoreHttpStatusErrors bei echten
      // Netzwerkfehlern; manche legen die reale Response unter err.response ab.
      if (err && err.response && (err.response.statusCode || err.response.status)) {
        response = err.response;
      } else {
        return { status: null, headers: {}, body: Buffer.alloc(0), finalUrl: currentUrl, cookieJar: jar, error: err.message || String(err) };
      }
    }

    const status = response.statusCode ?? response.status ?? null;
    const headers = response.headers || {};
    const fresh = parseSetCookies(headers);
    if (Object.keys(fresh).length) jar = mergeCookies(jar, fresh);

    if (status == null) {
      return { status: null, headers, body: Buffer.alloc(0), finalUrl: currentUrl, cookieJar: jar, error: "NO_STATUS_CODE_IN_RESPONSE" };
    }

    if (REDIRECT_STATUS.has(status)) {
      const location = headers.location || headers.Location;
      const nextUrl = resolveUrl(location, currentUrl);
      hops += 1;
      if (!nextUrl || hops > MAX_REDIRECTS) {
        return { status, headers, body: Buffer.alloc(0), finalUrl: currentUrl, cookieJar: jar, error: nextUrl ? "TOO_MANY_REDIRECTS" : "REDIRECT_WITHOUT_LOCATION" };
      }
      currentUrl = nextUrl;
      continue; // wir nutzen ausschließlich GET, daher kein Methodenwechsel nötig
    }

    let bodyRaw = response.body;
    const body = Buffer.isBuffer(bodyRaw) ? bodyRaw : Buffer.from(bodyRaw || new Uint8Array());

    if (body.length > MAX_DOWNLOAD_BYTES) {
      return { status, headers, body: Buffer.alloc(0), finalUrl: currentUrl, cookieJar: jar, error: `FILE_TOO_LARGE:${body.length}bytes` };
    }

    return { status, headers, body, finalUrl: currentUrl, cookieJar: jar, error: null };
  }
}

/**
 * Wrappt followRedirectsManually mit Retry/Backoff für 408/429/5xx.
 * Kurze, transiente Fehler werden IM Code-Node mit kurzem Backoff erneut
 * versucht. Ist die nötige Wartezeit lang (z.B. Retry-After > 15s), wird
 * NICHT im Node geschlafen (Blockiert sonst den Worker-Slot und riskiert
 * das n8n Execution-Timeout) – stattdessen wird der Status unverändert
 * als RATE_LIMITED zurückgegeben, damit der Hauptworkflow einen echten
 * "Wait"-Node verwenden kann (siehe docs/architecture.md, Abschnitt G).
 */
async function robustRequest(helpers, { url, cookieHeader }) {
  const initialJar = {};
  if (cookieHeader) {
    for (const pair of cookieHeader.split(";")) {
      const idx = pair.indexOf("=");
      if (idx > 0) initialJar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
    }
  }

  let jar = initialJar;
  let lastResult = null;

  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    const result = await followRedirectsManually(helpers, { startUrl: url, cookieJar: jar });
    jar = result.cookieJar;
    lastResult = result;

    const isLastAttempt = attempt === MAX_RETRIES + 1;
    if (isLastAttempt) return lastResult;

    if (result.status == null) {
      // Netzwerkfehler: kurzer Backoff, dann erneut.
      await sleep(Math.min(1500 * 2 ** (attempt - 1), 8000));
      continue;
    }

    if (RETRYABLE_STATUS.has(result.status)) {
      if (result.status === 429) {
        const retryAfterMs = parseRetryAfter(result.headers);
        if (retryAfterMs != null && retryAfterMs > INLINE_RETRY_MAX_WAIT_MS) {
          return lastResult; // lange Wartezeit -> an den Aufrufer/Graph-Ebene delegieren
        }
        await sleep(retryAfterMs != null ? retryAfterMs : Math.min(2000 * 2 ** (attempt - 1), 8000));
        continue;
      }
      await sleep(Math.min(2000 * 2 ** (attempt - 1), 8000));
      continue;
    }

    return lastResult; // kein retryable Status -> sofort zurückgeben
  }
  return lastResult;
}

/**
 * Übersetzt einen HTTP-Status in (status, reason) für portalAccessStatus.
 * Deckt explizit 401,403,404,408,429,500,502,503,504 ab (Teil F).
 */
function classifyHttpError(status, headers) {
  switch (status) {
    case 401: return { portalAccessStatus: "AUTH_REQUIRED", portalAccessReason: "HTTP_401_UNAUTHORIZED" };
    case 403: return { portalAccessStatus: "BLOCKED", portalAccessReason: "HTTP_403_FORBIDDEN" };
    case 404: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_404_NOT_FOUND" };
    case 408: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_408_TIMEOUT_AFTER_RETRIES" };
    case 429: return { portalAccessStatus: "RATE_LIMITED", portalAccessReason: `HTTP_429_RATE_LIMITED:${parseRetryAfter(headers) || "n/a"}` };
    case 500: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_500_SERVER_ERROR_AFTER_RETRIES" };
    case 502: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_502_BAD_GATEWAY_AFTER_RETRIES" };
    case 503: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_503_UNAVAILABLE_AFTER_RETRIES" };
    case 504: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_504_GATEWAY_TIMEOUT_AFTER_RETRIES" };
    default: return null;
  }
}

// Sehr einfache, konservative Bot-/Challenge-Erkennung. Erkennt NUR
// offensichtliche Marker, um zu melden – niemals um sie zu umgehen.
function looksLikeBotChallenge(bodyText) {
  const t = (bodyText || "").toLowerCase();
  return (
    t.includes("captcha") ||
    t.includes("cf-browser-verification") ||
    t.includes("attention required! | cloudflare") ||
    (t.includes("access denied") && t.includes("reference #"))
  );
}

function looksLikeLoginForm(bodyText) {
  const t = (bodyText || "").toLowerCase();
  return /<input[^>]*type=["']password["']/i.test(t) || (t.includes("benutzername") && t.includes("passwort")) || (t.includes("username") && t.includes("password"));
}

function looksLikeSpaShell(bodyText) {
  const t = bodyText || "";
  const strippedLength = t.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, "").trim().length;
  const hasSpaMarkers = /id=["']app["']|ng-version|__next_data__|window\.__nuxt__|data-reactroot/i.test(t);
  return hasSpaMarkers && strippedLength < 300;
}

// =====================================================================
// 7. PORTAL-ADAPTER (Teil C – Router) + Beispiel-Adapter (L, M, N)
// =====================================================================

// M) Klassischer HTML-Adapter mit normalen <a href> Downloadlinks.
// Dient auch als Fallback ("genericHtml") für alle noch nicht
// spezifisch implementierten Portale.
const DOC_EXT_RE = /\.(pdf|zip|docx?|xlsx?|csv|xml)(\?[^"'>\s]*)?$/i;
function genericHtmlAdapter(html, baseUrl) {
  const links = [];
  const aTagRe = /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aTagRe.exec(html)) !== null) {
    const href = m[1];
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (DOC_EXT_RE.test(href) || /download|dokument|anlage|unterlage|vergabeunterlage/i.test(text)) {
      links.push(href);
    }
  }
  // Zusätzlich data-* Attribute mit Datei-Endungen erfassen (z.B. data-href, data-download-url).
  const dataAttrRe = /data-(?:href|download-url|file-url|url)=["']([^"']+)["']/gi;
  while ((m = dataAttrRe.exec(html)) !== null) {
    if (DOC_EXT_RE.test(m[1])) links.push(m[1]);
  }
  const absoluteUrls = absolutizeAll(links, baseUrl);
  return { documentUrls: absoluteUrls, latestVersion: null, adapterUsed: "genericHtml" };
}

// L) Beispieladapter vergabe.muenchen.de.
//
// EHRLICHER HINWEIS ZUR GRENZE DIESES ADAPTERS:
// Dieser Adapter kennt aus deinem Test nur die FELDNAMEN
// (latestDocumentOid, latestDocumentToken, latestDocumentVersion,
// latestDocumentDate), nicht die tatsächliche HTML-Struktur der Seite.
// Deshalb wird hier NICHT wie in der Vorversion ein Download-URL-Pfad
// geraten, sondern gezielt nach einem echten href/src/action/data-*-Wert
// gesucht, der oid= UND token= zusammen enthält (also einem Link, den die
// Seite selbst schon fertig ausliefert). Nur dieser reale Link wird
// verwendet. Wird kein solcher kombinierter Link gefunden, fällt der
// Adapter auf den generischen HTML-Adapter zurück UND markiert das
// Ergebnis so, dass es sichtbar bleibt, dass die München-Spezifik nicht
// gegriffen hat (kein stiller Fallback ohne Kennzeichnung).
function vergabeMuenchenAdapter(html, baseUrl) {
  const versionMatches = [...html.matchAll(/data-version=["']?(\d+)["']?/gi)].map((mm) => parseInt(mm[1], 10));
  const latestVersion = versionMatches.length ? Math.max(...versionMatches) : null;

  const oidMatch = html.match(/[?&]oid=([A-Za-z0-9\-_]+)/i) || html.match(/data-oid=["']([A-Za-z0-9\-_]+)["']/i);
  const tokenMatch = html.match(/[?&]token=([A-Za-z0-9\-_.]+)/i) || html.match(/data-token=["']([A-Za-z0-9\-_.]+)["']/i);
  const dateMatch = html.match(/data-date=["']([^"']+)["']/i);

  const latestDocumentOid = oidMatch ? oidMatch[1] : null;
  const latestDocumentToken = tokenMatch ? tokenMatch[1] : null;
  const latestDocumentDate = dateMatch ? dateMatch[1] : null;
  const meta = { latestDocumentOid, latestDocumentToken, latestDocumentDate, latestDocumentVersion: latestVersion };

  // Suche nach einem bereits im HTML fertig ausgelieferten Link, der
  // sowohl "oid=" als auch "token=" enthält (href, src, action oder data-*).
  const attrValueRe = /(?:href|src|action|data-[\w-]+)\s*=\s*["']([^"']+)["']/gi;
  const combinedCandidates = [];
  let m;
  while ((m = attrValueRe.exec(html)) !== null) {
    const val = m[1];
    if (/oid=/i.test(val) && /token=/i.test(val)) combinedCandidates.push(val);
  }

  if (!combinedCandidates.length) {
    return {
      ...genericHtmlAdapter(html, baseUrl),
      adapterUsed: "vergabeMuenchen->genericHtmlFallback:NO_COMBINED_OID_TOKEN_LINK_FOUND",
      meta,
      latestVersion,
    };
  }

  const downloadUrls = absolutizeAll(combinedCandidates, baseUrl);
  if (!downloadUrls.length) {
    return {
      ...genericHtmlAdapter(html, baseUrl),
      adapterUsed: "vergabeMuenchen->genericHtmlFallback:COMBINED_LINK_NOT_RESOLVABLE",
      meta,
      latestVersion,
    };
  }

  return {
    documentUrls: downloadUrls,
    latestVersion,
    adapterUsed: "vergabeMuenchen",
    meta,
  };
}

// N) Beispieladapter für ein Portal mit Login und Session-Cookie:
// erkennt lediglich, OB ein Login nötig ist / eine Session bereits
// ausreicht – der eigentliche Login läuft über den
// Auth/Browser-Orchestrator (siehe n8n/core/auth-browser-orchestrator.js).
function loginSessionPortalAdapter(html, baseUrl, hadValidSession) {
  if (looksLikeLoginForm(html) && !hadValidSession) {
    return { documentUrls: [], latestVersion: null, adapterUsed: "loginSessionPortal", requiresLogin: true };
  }
  // Mit gültiger Session verhält sich das Portal wie ein normales HTML-Portal.
  return { ...genericHtmlAdapter(html, baseUrl), adapterUsed: "loginSessionPortal", requiresLogin: false };
}

const ADAPTERS = {
  vergabeMuenchen: vergabeMuenchenAdapter,
  genericHtml: genericHtmlAdapter,
  loginSessionPortal: loginSessionPortalAdapter,
};

// Portal Adapter Router (Teil C) – reine Objekt-Lookup-Dispatch, KEIN
// n8n-Switch-Node nötig. Neues Portal = neuer Eintrag in ADAPTERS +
// PORTAL_CONFIG, kein neuer Node/Workflow.
function routeToAdapter(parserName, html, baseUrl, hadValidSession) {
  const adapterFn = ADAPTERS[parserName] || ADAPTERS.genericHtml;
  try {
    if (adapterFn === loginSessionPortalAdapter) return adapterFn(html, baseUrl, hadValidSession);
    return adapterFn(html, baseUrl);
  } catch (err) {
    return { documentUrls: [], latestVersion: null, adapterUsed: `${parserName}:ADAPTER_THREW_ERROR`, error: err.message };
  }
}

// =====================================================================
// 8. UNIVERSAL RESPONSE CLASSIFIER (Teil B)
// =====================================================================
function classifyResponse({ result, portalCfg, hadValidSession }) {
  const { status, headers, body, error } = result;
  const contentType = headers["content-type"] || headers["Content-Type"] || "";
  const contentDisposition = headers["content-disposition"] || headers["Content-Disposition"];

  if (status == null) {
    return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: `NETWORK_ERROR:${error || "UNKNOWN"}`, fileType: null, contentType, isBotChallenge: false };
  }

  const httpErrorClass = classifyHttpError(status, headers);
  if (httpErrorClass) {
    return { ...httpErrorClass, fileType: null, contentType, isBotChallenge: status === 403 };
  }

  if (status < 200 || status >= 300) {
    return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: `UNEXPECTED_HTTP_STATUS:${status}`, fileType: null, contentType, isBotChallenge: false };
  }

  if (error === "FILE_TOO_LARGE" || (error && error.startsWith("FILE_TOO_LARGE"))) {
    return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: error, fileType: null, contentType, isBotChallenge: false };
  }

  const fileType = detectFileType({ buffer: body, contentTypeHeader: contentType, url: result.finalUrl, contentDisposition });

  if (fileType.isFile) {
    return { portalAccessStatus: "DIRECT_FILE", portalAccessReason: `FILE_DETECTED:${fileType.kind}`, fileType, contentType, isBotChallenge: false };
  }

  if (fileType.kind === "HTML") {
    const bodyText = decodeBody(body, contentType);
    if (looksLikeBotChallenge(bodyText)) {
      return { portalAccessStatus: "BLOCKED", portalAccessReason: "BOT_CHALLENGE_DETECTED", fileType, contentType, isBotChallenge: true, bodyText };
    }
    if (looksLikeLoginForm(bodyText) && !hadValidSession) {
      return { portalAccessStatus: "AUTH_REQUIRED", portalAccessReason: "LOGIN_FORM_DETECTED", fileType, contentType, isBotChallenge: false, bodyText };
    }
    if (portalCfg.requiresBrowser || looksLikeSpaShell(bodyText)) {
      return { portalAccessStatus: "BROWSER_REQUIRED", portalAccessReason: "SPA_OR_CONFIG_FLAG", fileType, contentType, isBotChallenge: false, bodyText };
    }
    return { portalAccessStatus: "PUBLIC_HTML_WITH_DOWNLOADS", portalAccessReason: "HTML_PAGE_OK", fileType, contentType, isBotChallenge: false, bodyText };
  }

  return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: fileType.reason || "UNCLASSIFIABLE_RESPONSE", fileType, contentType, isBotChallenge: false };
}

// =====================================================================
// 9. HAUPTABLAUF: pro Item verarbeiten
// =====================================================================
async function processItem(item, index, helpers, staticData) {
  const json = item.json;
  const procurementPortal = json.procurementPortal || "ANDERES_PORTAL";
  const sourceUrl = json.firstDocumentUrl;
  const processingErrors = [];

  const out = {
    ...json,
    portalAccessStatus: "MANUAL_REVIEW",
    portalAccessReason: "NOT_PROCESSED",
    sourceUrl,
    finalUrl: sourceUrl,
    httpStatus: null,
    contentType: null,
    isDirectFile: false,
    isHtmlPage: false,
    authRequired: false,
    sessionRequired: false,
    browserRequired: false,
    rateLimited: false,
    documentsFound: 0,
    documentsDownloaded: 0,
    documentNames: [],
    documentUrls: Array.isArray(json.documentUrls) ? json.documentUrls : [],
    documentMimeTypes: [],
    downloadSucceeded: false,
    manualReviewRequired: true,
    loginRequired: false,
    portalAdapterUsed: null,
    latestVersionDetected: null,
    processingErrors,
    sessionCookies: json.sessionCookies || null,
  };

  if (!sourceUrl) {
    out.portalAccessReason = "NO_DOCUMENT_URL";
    processingErrors.push("firstDocumentUrl fehlt");
    return { json: out, pairedItem: { item: index } };
  }

  const portalCfg = getPortalConfig(procurementPortal, sourceUrl);
  const domain = portalCfg.resolvedDomain || "unknown";

  const persistedCookies = json.sessionCookies || loadPersistedSession(staticData, domain);
  let cookieJar = persistedCookies || {};
  const hadValidSession = !!(persistedCookies && Object.keys(persistedCookies).length);

  // --- 1. Probe-Request (inkl. manuellem Redirect-Walk + Retry/Backoff) ---
  const result = await robustRequest(helpers, { url: sourceUrl, cookieHeader: cookiesToHeader(cookieJar) });
  out.finalUrl = result.finalUrl || sourceUrl;
  out.httpStatus = result.status;
  if (result.cookieJar && Object.keys(result.cookieJar).length) {
    cookieJar = mergeCookies(cookieJar, result.cookieJar);
    persistSession(staticData, domain, cookieJar);
  }

  const classification = classifyResponse({ result, portalCfg, hadValidSession });
  out.portalAccessStatus = classification.portalAccessStatus;
  out.portalAccessReason = classification.portalAccessReason;
  out.contentType = classification.contentType || null;
  out.sessionCookies = Object.keys(cookieJar).length ? cookieJar : null;

  out.authRequired = classification.portalAccessStatus === "AUTH_REQUIRED";
  out.loginRequired = out.authRequired;
  out.browserRequired = classification.portalAccessStatus === "BROWSER_REQUIRED";
  out.rateLimited = classification.portalAccessStatus === "RATE_LIMITED";
  out.manualReviewRequired = ["MANUAL_REVIEW", "BLOCKED"].includes(classification.portalAccessStatus);

  // --- 2. DIRECT_FILE: sofort als heruntergeladen verbuchen ---
  if (classification.portalAccessStatus === "DIRECT_FILE") {
    out.isDirectFile = true;
    out.documentUrls = [out.finalUrl];
    out.documentsFound = 1;
    out.portalAdapterUsed = "direct";
    const filename = getFilenameFromContentDisposition(result.headers["content-disposition"]) || `document.${classification.fileType.ext}`;
    item.binary = item.binary || {};
    item.binary.doc_0 = await helpers.prepareBinaryData(result.body, filename, classification.fileType.mime);
    out.documentNames = [filename];
    out.documentMimeTypes = [classification.fileType.mime];
    out.documentsDownloaded = 1;
    out.downloadSucceeded = true;
    out.manualReviewRequired = false;
    return { json: out, binary: item.binary, pairedItem: { item: index } };
  }

  // --- 3. HTML: Adapter zur Linkextraktion aufrufen ---
  if (classification.portalAccessStatus === "PUBLIC_HTML_WITH_DOWNLOADS" || classification.portalAccessStatus === "SESSION_REQUIRED") {
    out.isHtmlPage = true;
    const adapterResult = routeToAdapter(portalCfg.parserName, classification.bodyText, out.finalUrl, hadValidSession);
    out.portalAdapterUsed = adapterResult.adapterUsed;
    out.latestVersionDetected = adapterResult.latestVersion ?? adapterResult.meta?.latestDocumentVersion ?? null;

    if (adapterResult.requiresLogin) {
      out.portalAccessStatus = "AUTH_REQUIRED";
      out.portalAccessReason = "ADAPTER_DETECTED_LOGIN_REQUIRED";
      out.authRequired = true;
      out.loginRequired = true;
      out.manualReviewRequired = false;
      return { json: out, pairedItem: { item: index } };
    }

    const docUrls = adapterResult.documentUrls || [];
    out.documentUrls = docUrls;
    out.documentsFound = docUrls.length;

    if (!docUrls.length) {
      out.portalAccessStatus = "MANUAL_REVIEW";
      out.portalAccessReason = "NO_DOWNLOAD_LINKS_FOUND_IN_HTML";
      out.manualReviewRequired = true;
      return { json: out, pairedItem: { item: index } };
    }

    // --- 4. Alle gefundenen Dokumente herunterladen ---
    item.binary = item.binary || {};
    let idx = 0;
    for (const docUrl of docUrls) {
      const docResult = await robustRequest(helpers, { url: docUrl, cookieHeader: cookiesToHeader(cookieJar) });
      if (docResult.cookieJar && Object.keys(docResult.cookieJar).length) {
        cookieJar = mergeCookies(cookieJar, docResult.cookieJar);
        persistSession(staticData, domain, cookieJar);
      }

      const hasSessionNow = Object.keys(cookieJar).length > 0;
      const docClass = classifyResponse({ result: docResult, portalCfg, hadValidSession: hasSessionNow });
      if (docClass.portalAccessStatus !== "DIRECT_FILE") {
        processingErrors.push(`Download fehlgeschlagen für ${docUrl}: ${docClass.portalAccessReason}`);
        continue;
      }
      const filename = getFilenameFromContentDisposition(docResult.headers["content-disposition"]) || `document_${idx}.${docClass.fileType.ext}`;
      item.binary[`doc_${idx}`] = await helpers.prepareBinaryData(docResult.body, filename, docClass.fileType.mime);
      out.documentNames.push(filename);
      out.documentMimeTypes.push(docClass.fileType.mime);
      idx += 1;
    }

    out.documentsDownloaded = idx;
    out.downloadSucceeded = idx > 0 && idx === docUrls.length;
    out.sessionCookies = Object.keys(cookieJar).length ? cookieJar : null;

    if (idx === 0) {
      out.portalAccessStatus = "MANUAL_REVIEW";
      out.portalAccessReason = "ALL_DOCUMENT_DOWNLOADS_FAILED";
      out.manualReviewRequired = true;
    } else if (idx < docUrls.length) {
      out.portalAccessStatus = "MANUAL_REVIEW";
      out.portalAccessReason = `PARTIAL_DOWNLOAD:${idx}/${docUrls.length}`;
      out.manualReviewRequired = true;
    } else {
      out.manualReviewRequired = false;
    }
    return { json: out, binary: item.binary, pairedItem: { item: index } };
  }

  // --- 5. AUTH_REQUIRED / BROWSER_REQUIRED / RATE_LIMITED / BLOCKED / MANUAL_REVIEW ---
  // Wird unverändert an den Hauptworkflow zurückgegeben; dort entscheidet
  // die IF-Node über Auth/Browser-Orchestrator bzw. Telegram-Fehlermeldung.
  // documentAccessStatus wird HIER NIE gesetzt – das bleibt ausschließlich
  // dem Gate-Node vorbehalten (Teile R/S/T).
  return { json: out, pairedItem: { item: index } };
}

// =====================================================================
// ENTRY POINT
// =====================================================================
const staticData = $getWorkflowStaticData("global");
const items = $input.all();
const results = [];
for (let i = 0; i < items.length; i++) {
  results.push(await processItem(items[i], i, $helpers, staticData));
}
return results;
