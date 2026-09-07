/**
 * MAXSER – Portal Access Core (Revision 4 – reine Klassifizierung, kein Netzwerk-$helpers)
 * ============================================================================================
 * WICHTIG: Dieser Node macht KEINE eigenen HTTP-Requests und ruft NICHT
 * $helpers.httpRequest / $helpers.prepareBinaryData / this.getCredentials
 * auf (diese APIs sind je nach n8n-Version/Instanz nicht sicher
 * verfügbar). Er läuft IMMER DIREKT NACH einem normalen "HTTP Request"-Node
 * im selben Workflow und klassifiziert nur dessen Ergebnis. Alle
 * Netzwerk-Calls übernehmen echte HTTP-Request-Nodes.
 *
 * EINZIGE AUSNAHME, bewusst und feature-detected: Zum Lesen des bereits
 * vorhandenen Binärdaten-Bodys wird, falls zur Laufzeit vorhanden,
 * `$helpers.getBinaryDataBuffer()` genutzt (korrekt in JEDEM n8n-Binary-
 * Data-Modus, auch filesystem/S3) – mit garantiertem Base64-Fallback,
 * falls diese Methode in deiner Instanz nicht existiert. Siehe
 * `readBinaryBuffer()` weiter unten für die genaue Begründung.
 *
 * Node-Modus: "Run Once for All Items"
 *
 * Erwartete Eingabe je Item (kommt vom vorgeschalteten HTTP Request Node):
 *   - $json.statusCode        (Number – HTTP Request Node: "Full Response"/
 *                               "Include Response Headers and Status" AN)
 *   - $json.headers           (Object)
 *   - $json.requestUrl        (String – die tatsächlich angefragte URL;
 *                               VOR dem HTTP Request Node selbst setzen,
 *                               z.B. per Set-Node aus firstDocumentUrl)
 *   - $json.procurementPortal (String)
 *   - $json.sessionCookiesHeader (String, optional – von einem vorherigen Durchlauf)
 *   - $json.retryCount        (Number, optional, Default 0)
 *   - $json.docIndex          (Number, optional – nur bei Einzel-Dokument-
 *                               Downloads im "isDocumentSubFetch"-Zweig)
 *   - $json.isDocumentSubFetch (Boolean, optional – true = dies ist der
 *                               Download EINES bereits bekannten Dokument-
 *                               Links, nicht die erste Sondierung der Seite)
 *   - $json.error             (String, optional – von der "error output"-
 *                               Verzweigung des HTTP Request Node bei
 *                               echten Netzwerkfehlern/Timeouts)
 *   - item.binary.data        (die vom HTTP Request Node geladene Antwort,
 *                               Response Format "File")
 *
 * Erzeugte Ausgabe je Item (json):
 *   portalAccessStatus, portalAccessReason, sourceUrl, finalUrl, httpStatus,
 *   contentType, isDirectFile, isHtmlPage, authRequired, sessionRequired,
 *   browserRequired, mfaRequired, rateLimited, downloadResolverRequired,
 *   downloadResolverMetadata, documentsFound, documentUrls, documentNames,
 *   documentMimeTypes, manualReviewRequired, loginRequired,
 *   portalAdapterUsed, latestVersionDetected, processingErrors,
 *   sessionCookiesHeader, needsRetry, retryCount, backoffMs
 * Binärdaten: bei DIRECT_FILE / isDocumentSubFetch wird das vorhandene
 * item.binary.data 1:1 nach item.binary.doc_<docIndex> umbenannt
 * (KEIN prepareBinaryData nötig – reine Objekt-Zuweisung).
 *
 * documentsDownloaded / downloadSucceeded / documentAccessStatus werden
 * HIER NICHT final gesetzt – das erfolgt erst im nachgelagerten
 * Aggregations-/Gate-Node, der die Einzel-Downloads mehrerer Dokumente
 * (mehrere Durchläufe dieses Nodes) wieder zu einem Ausschreibungs-Item
 * zusammenführt.
 */

// =====================================================================
// 0. LIMITS
// =====================================================================
const MIN_PLAUSIBLE_FILE_BYTES = 16; // 0-Byte-/abgeschnittene Antworten nie als Datei durchwinken
const MAX_RETRY_COUNT = 3; // 408/429/5xx – braucht öfter mal mehrere Versuche
const MAX_SESSION_HANDSHAKE_RETRIES = 2; // Cookie-Handshake braucht praktisch nie mehr als 1 Versuch
const INLINE_RETRY_MAX_WAIT_MS = 15000; // > 15s Wartezeit -> nicht mehr automatisch retryen, sondern RATE_LIMITED melden

// =====================================================================
// 1. ZENTRALE PORTAL-KONFIGURATION (Teil O)
// =====================================================================
// verified:false => Klassifizierung erfolgt IMMER live aus der echten
// HTTP-Antwort. Die Flags hier sind nur ein Beschleuniger/Cache für
// bereits real getestete Portale (siehe docs/architecture.md, Abschnitt O).
const PORTAL_CONFIG = {
  EVERGABE: { domain: null, verified: false, requiresBrowser: false, parserName: "genericHtml" },
  EVERGABE_ONLINE: { domain: "evergabe-online.de", verified: false, requiresBrowser: false, parserName: "evergabeOnline" },
  DEUTSCHE_EVERGABE: { domain: "deutsche-evergabe.de", verified: false, requiresBrowser: false, parserName: "deutscheEvergabe" },
  BERLIN_VERGABE: { domain: "vergabe.berlin.de", verified: false, requiresBrowser: false, parserName: "berlinVergabe" },
  BRANDENBURG_VERGABE: { domain: "vergabemarktplatz.brandenburg.de", verified: false, requiresBrowser: false, parserName: "brandenburgVergabe" },
  SACHSEN_ANHALT_VERGABE: { domain: "evergabe.sachsen-anhalt.de", verified: false, requiresBrowser: false, parserName: "sachsenAnhaltVergabe" },
  SACHSEN_VERGABE: { domain: "evergabe.sachsen.de", verified: false, requiresBrowser: false, parserName: "sachsenVergabe" },
  MV_LAND_VERGABE: { domain: null, verified: false, requiresBrowser: false, parserName: "genericHtml" },
  MV_EVERGABE: { domain: null, verified: false, requiresBrowser: false, parserName: "genericHtml" },
  BAYERN_VERGABE: { domain: "vergabe.bayern.de", verified: false, requiresBrowser: false, parserName: "bayernVergabe" },
  MUENCHEN_VERGABE: { domain: "vergabe.muenchen.de", verified: true, requiresBrowser: false, parserName: "vergabeMuenchen" },
  BADEN_WUERTTEMBERG_VERGABE: { domain: null, verified: false, requiresBrowser: false, parserName: "genericHtml" },
  DTVP: { domain: "dtvp.de", verified: false, requiresBrowser: false, parserName: "dtvp" },
  VMP_RHEINLAND: { domain: null, verified: false, requiresBrowser: false, parserName: "genericHtml" },
  SUBREPORT: { domain: "subreport.de", verified: false, requiresBrowser: false, parserName: "subreport" },
  BREMEN_VERGABE: { domain: "vergabe.bremen.de", verified: false, requiresBrowser: false, parserName: "bremenVergabe" },
  METROPOLE_RUHR: { domain: "vergabe.metropoleruhr.de", verified: false, requiresBrowser: false, parserName: "genericHtml" },
  AUMASS: { domain: null, verified: false, requiresBrowser: false, parserName: "genericHtml" },
  HAD_HESSEN: { domain: "had.de", verified: false, requiresBrowser: false, parserName: "hadHessen" },
  TED: { domain: "ted.europa.eu", verified: false, requiresBrowser: false, parserName: "genericHtml" },
  ANDERES_PORTAL: { domain: null, verified: false, requiresBrowser: false, parserName: "genericHtml" },
};

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
//    statt UTF-8 – wichtig für HTML-Sniffing/Adapter). Reine JS-Funktionen,
//    kein n8n-spezifisches API nötig.
// =====================================================================
function detectDeclaredCharset(contentTypeHeader, buffer) {
  const ctMatch = (contentTypeHeader || "").match(/charset\s*=\s*"?([\w-]+)"?/i);
  if (ctMatch) return ctMatch[1].toLowerCase();
  const head = buffer.slice(0, 1024).toString("latin1");
  const metaCharset = head.match(/<meta[^>]+charset=["']?([\w-]+)/i);
  if (metaCharset) return metaCharset[1].toLowerCase();
  return null;
}

function decodeBody(buffer, contentTypeHeader) {
  const declared = detectDeclaredCharset(contentTypeHeader, buffer);
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
  // Legacy .doc/.xls (OLE Compound File Binary Format) – Sub-Typ NUR über
  // Extension/Content-Type unterscheidbar, Magic Bytes sind identisch.
  { type: "OLE_COMPOUND", check: (b) => b.length >= 8 &&
      b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 &&
      b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1 },
];

const EXTENSION_MIME_MAP = {
  pdf: "application/pdf", zip: "application/zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  doc: "application/msword", xls: "application/vnd.ms-excel",
  csv: "text/csv", xml: "application/xml", html: "text/html", htm: "text/html",
};

function sniffTextKind(buffer, contentTypeHeader) {
  const sample = decodeBody(buffer.slice(0, 2048), contentTypeHeader).trim();
  if (/^<\?xml/i.test(sample)) return "XML";
  if (/^<!doctype html/i.test(sample) || /<html[\s>]/i.test(sample.slice(0, 500))) return "HTML";
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

  if (!buffer || buffer.length < MIN_PLAUSIBLE_FILE_BYTES) {
    return { kind: "UNKNOWN", mime: ctHeader || null, ext: declaredExt || null, isFile: false, source: "none", reason: `EMPTY_OR_TOO_SMALL_BODY:${buffer ? buffer.length : 0}bytes` };
  }

  let magicType = null;
  for (const sig of MAGIC_SIGNATURES) {
    if (sig.check(buffer)) { magicType = sig.type; break; }
  }
  if (!magicType) magicType = sniffTextKind(buffer, contentTypeHeader);

  if (magicType === "PDF") {
    return { kind: "PDF", mime: "application/pdf", ext: "pdf", isFile: true, source: "magic" };
  }

  if (magicType === "ZIP_FAMILY") {
    if (declaredExt === "docx" || ctHeader.includes("wordprocessingml")) {
      return { kind: "DOCX", mime: EXTENSION_MIME_MAP.docx, ext: "docx", isFile: true, source: "magic+header" };
    }
    if (declaredExt === "xlsx" || ctHeader.includes("spreadsheetml")) {
      return { kind: "XLSX", mime: EXTENSION_MIME_MAP.xlsx, ext: "xlsx", isFile: true, source: "magic+header" };
    }
    return { kind: "ZIP", mime: "application/zip", ext: "zip", isFile: true, source: "magic" };
  }

  if (magicType === "OLE_COMPOUND") {
    if (declaredExt === "xls" || ctHeader === "application/vnd.ms-excel") {
      return { kind: "XLS", mime: EXTENSION_MIME_MAP.xls, ext: "xls", isFile: true, source: "magic+header" };
    }
    if (declaredExt === "doc" || ctHeader === "application/msword") {
      return { kind: "DOC", mime: EXTENSION_MIME_MAP.doc, ext: "doc", isFile: true, source: "magic+header" };
    }
    return { kind: "OLE_DOCUMENT", mime: "application/octet-stream", ext: declaredExt || "doc", isFile: true, source: "magic-ambiguous-subtype" };
  }

  if (magicType === "XML" || magicType === "HTML" || magicType === "CSV") {
    return { kind: magicType, mime: EXTENSION_MIME_MAP[magicType.toLowerCase()] || null, ext: magicType.toLowerCase(), isFile: magicType !== "HTML", source: "sniff" };
  }

  if (ctHeader === "application/pdf") return { kind: "PDF", mime: ctHeader, ext: "pdf", isFile: true, source: "header" };
  if (ctHeader === "application/zip" || ctHeader === "application/x-zip-compressed") return { kind: "ZIP", mime: ctHeader, ext: "zip", isFile: true, source: "header" };
  if (ctHeader.includes("wordprocessingml")) return { kind: "DOCX", mime: ctHeader, ext: "docx", isFile: true, source: "header" };
  if (ctHeader.includes("spreadsheetml")) return { kind: "XLSX", mime: ctHeader, ext: "xlsx", isFile: true, source: "header" };
  if (ctHeader === "application/msword") return { kind: "DOC", mime: ctHeader, ext: "doc", isFile: true, source: "header" };
  if (ctHeader === "application/vnd.ms-excel") return { kind: "XLS", mime: ctHeader, ext: "xls", isFile: true, source: "header" };
  if (ctHeader === "text/csv") return { kind: "CSV", mime: ctHeader, ext: "csv", isFile: true, source: "header" };
  if (ctHeader === "application/xml" || ctHeader === "text/xml") return { kind: "XML", mime: ctHeader, ext: "xml", isFile: true, source: "header" };
  if (ctHeader === "text/html") return { kind: "HTML", mime: ctHeader, ext: "html", isFile: false, source: "header" };

  return { kind: "UNKNOWN", mime: ctHeader || null, ext: declaredExt || null, isFile: false, source: "none", reason: `UNKNOWN_CONTENT_TYPE:${ctHeader || "n/a"}` };
}

// =====================================================================
// 5. COOKIES (Teil H) – reines String-/Objekt-Parsing, kein Netzwerk
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

function parseCookieHeader(headerStr) {
  const jar = {};
  if (!headerStr) return jar;
  for (const pair of headerStr.split(";")) {
    const idx = pair.indexOf("=");
    if (idx > 0) jar[pair.slice(0, idx).trim()] = pair.slice(idx + 1).trim();
  }
  return jar;
}

function cookiesToHeader(jar) {
  if (!jar || !Object.keys(jar).length) return "";
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join("; ");
}

// Cross-Execution-Wiederverwendung (Teil H). $getWorkflowStaticData ist ein
// eigenständiges, seit Langem stabiles Code-Node-Feature (unabhängig von
// $helpers) und in jeder n8n-Version verfügbar.
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
// 6. FEHLERHANDLER (Teil F) – reine Zuordnung, KEIN Sleep/Retry hier.
// Retry/Backoff läuft als echte Graph-Schleife: dieser Node liefert nur
// `needsRetry` + `backoffMs`, die IF/Wait-Nodes im Hauptworkflow werten
// das aus (siehe Antwort-Text, Punkt 6 / docs/architecture.md Abschnitt G).
// =====================================================================
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function parseRetryAfter(headers) {
  const val = headers && (headers["retry-after"] || headers["Retry-After"]);
  if (!val) return null;
  const asInt = parseInt(val, 10);
  if (!Number.isNaN(asInt) && String(asInt) === String(val).trim()) return asInt * 1000;
  const asDate = Date.parse(val);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

function classifyHttpError(status, headers) {
  switch (status) {
    case 401: return { portalAccessStatus: "AUTH_REQUIRED", portalAccessReason: "HTTP_401_UNAUTHORIZED", retryable: false };
    case 403: return { portalAccessStatus: "BLOCKED", portalAccessReason: "HTTP_403_FORBIDDEN", retryable: false };
    case 404: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_404_NOT_FOUND", retryable: false };
    case 408: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_408_TIMEOUT", retryable: true };
    case 429: return { portalAccessStatus: "RATE_LIMITED", portalAccessReason: `HTTP_429_RATE_LIMITED:${parseRetryAfter(headers) || "n/a"}`, retryable: true };
    case 500: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_500_SERVER_ERROR", retryable: true };
    case 502: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_502_BAD_GATEWAY", retryable: true };
    case 503: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_503_UNAVAILABLE", retryable: true };
    case 504: return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: "HTTP_504_GATEWAY_TIMEOUT", retryable: true };
    default: return null;
  }
}

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

// Zusätzliche Absicherung gegen False-Positive AUTH_REQUIRED: Seiten mit
// diesen Markern behandeln erkennbar ein Vergabeverfahren (auch wenn der
// generische Linkscanner zufällig 0 Links fand, z.B. weil Downloads über
// eine noch nicht erkannte Struktur eingebunden sind) – dann lieber
// MANUAL_REVIEW statt fälschlich AUTH_REQUIRED zu melden.
const TENDER_MARKER_RE = /tenderingproceduredetails|tenderoid|vergabeunterlagen|vergabeverfahren|ausschreibung|leistungsverzeichnis|data-oid|data-token|specificationversion|download/i;
function hasTenderMarkers(bodyText) {
  return TENDER_MARKER_RE.test(bodyText || "");
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
const DOC_EXT_RE = /\.(pdf|zip|docx?|xlsx?|csv|xml)(\?[^"'>\s]*)?$/i;

// M) Klassischer HTML-Adapter mit normalen <a href> Downloadlinks.
// Dient auch als Fallback ("genericHtml") für alle noch nicht
// spezifisch implementierten Portale.
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
  const dataAttrRe = /data-(?:href|download-url|file-url|url)=["']([^"']+)["']/gi;
  while ((m = dataAttrRe.exec(html)) !== null) {
    if (DOC_EXT_RE.test(m[1])) links.push(m[1]);
  }
  // Auch src=/action= mit Datei-Endung erfassen (z.B. <iframe src="...pdf">,
  // <form action="...download.pdf">) – weiterhin nur echte, im HTML
  // vorhandene Werte, keine konstruierten URLs.
  const srcActionRe = /(?:src|action)=["']([^"']+)["']/gi;
  while ((m = srcActionRe.exec(html)) !== null) {
    if (DOC_EXT_RE.test(m[1])) links.push(m[1]);
  }
  const absoluteUrls = absolutizeAll(links, baseUrl);
  return { documentUrls: absoluteUrls, latestVersion: null, adapterUsed: "genericHtml" };
}

// L) Beispieladapter vergabe.muenchen.de.
//
// EHRLICHER HINWEIS ZUR GRENZE DIESES ADAPTERS: Bekannt sind nur die
// FELDNAMEN aus deinem Test (latestDocumentOid, latestDocumentToken,
// latestDocumentVersion, latestDocumentDate), nicht die tatsächliche
// HTML-Struktur. Es wird daher NICHT ein Downloadpfad geraten, sondern
// gezielt nach einem im HTML bereits vorhandenen href/src/action/data-*-
// Wert gesucht, der oid= UND token= zusammen enthält. Nur ein solcher
// realer Link wird verwendet. Ohne Treffer: sichtbar gekennzeichneter
// Fallback auf den generischen HTML-Adapter, keine geratene URL.
function vergabeMuenchenAdapter(html, baseUrl) {
  const versionMatches = [...html.matchAll(/data-version=["']?(\d+)["']?/gi)].map((mm) => parseInt(mm[1], 10));
  const latestVersion = versionMatches.length ? Math.max(...versionMatches) : null;

  const oidMatch = html.match(/[?&]oid=([A-Za-z0-9\-_]+)/i) || html.match(/data-oid=["']([A-Za-z0-9\-_]+)["']/i);
  const tokenMatch = html.match(/[?&]token=([A-Za-z0-9\-_.]+)/i) || html.match(/data-token=["']([A-Za-z0-9\-_.]+)["']/i);
  const dateMatch = html.match(/data-date=["']([^"']+)["']/i);

  const meta = {
    latestDocumentOid: oidMatch ? oidMatch[1] : null,
    latestDocumentToken: tokenMatch ? tokenMatch[1] : null,
    latestDocumentDate: dateMatch ? dateMatch[1] : null,
    latestDocumentVersion: latestVersion,
  };

  const attrValueRe = /(?:href|src|action|data-[\w-]+)\s*=\s*["']([^"']+)["']/gi;
  const combinedCandidates = [];
  let m;
  while ((m = attrValueRe.exec(html)) !== null) {
    const val = m[1];
    if (/oid=/i.test(val) && /token=/i.test(val)) combinedCandidates.push(val);
  }

  if (!combinedCandidates.length) {
    // Teil 8 ("nicht raten"): oid/token wurden gefunden, aber KEIN echter
    // Downloadlink dazu. Statt zu raten, wird die Metadaten strukturiert
    // ausgegeben und downloadResolverRequired=true gesetzt.
    return {
      ...genericHtmlAdapter(html, baseUrl),
      adapterUsed: "vergabeMuenchen->genericHtmlFallback:NO_COMBINED_OID_TOKEN_LINK_FOUND",
      meta, latestVersion,
      downloadResolverRequired: true,
      downloadResolverMetadata: meta,
    };
  }

  const downloadUrls = absolutizeAll(combinedCandidates, baseUrl);
  if (!downloadUrls.length) {
    return {
      ...genericHtmlAdapter(html, baseUrl),
      adapterUsed: "vergabeMuenchen->genericHtmlFallback:COMBINED_LINK_NOT_RESOLVABLE",
      meta, latestVersion,
      downloadResolverRequired: true,
      downloadResolverMetadata: meta,
    };
  }

  return { documentUrls: downloadUrls, latestVersion, adapterUsed: "vergabeMuenchen", meta };
}

// N) Beispieladapter für ein Portal mit Login und Session-Cookie: erkennt
// lediglich, OB ein Login nötig ist / eine Session bereits ausreicht.
function loginSessionPortalAdapter(html, baseUrl, hadValidSession) {
  if (looksLikeLoginForm(html) && !hadValidSession) {
    return { documentUrls: [], latestVersion: null, adapterUsed: "loginSessionPortal", requiresLogin: true };
  }
  return { ...genericHtmlAdapter(html, baseUrl), adapterUsed: "loginSessionPortal", requiresLogin: false };
}

// Benannte Adapter-Aliasse (Teil 7): Diese Portale haben noch KEINE
// verifizierte, abweichende HTML-Struktur bekannt – sie verhalten sich
// aktuell wie genericHtml, tragen aber schon ihren eigenen Namen in
// PORTAL_CONFIG/ADAPTERS, damit du sie später (sobald du die reale
// Struktur kennst) einzeln durch eine eigene Extraktionsfunktion
// ersetzen kannst, ohne PORTAL_CONFIG oder den Router anfassen zu
// müssen. Ehrlich gekennzeichnet über adapterUsed-Suffix ":generic".
function makeNamedGenericAdapter(name) {
  return function namedAdapter(html, baseUrl) {
    return { ...genericHtmlAdapter(html, baseUrl), adapterUsed: `${name}:generic` };
  };
}

const ADAPTERS = {
  vergabeMuenchen: vergabeMuenchenAdapter,
  genericHtml: genericHtmlAdapter,
  loginSessionPortal: loginSessionPortalAdapter,
  evergabeOnline: makeNamedGenericAdapter("evergabeOnline"),
  deutscheEvergabe: makeNamedGenericAdapter("deutscheEvergabe"),
  berlinVergabe: makeNamedGenericAdapter("berlinVergabe"),
  brandenburgVergabe: makeNamedGenericAdapter("brandenburgVergabe"),
  sachsenVergabe: makeNamedGenericAdapter("sachsenVergabe"),
  sachsenAnhaltVergabe: makeNamedGenericAdapter("sachsenAnhaltVergabe"),
  bayernVergabe: makeNamedGenericAdapter("bayernVergabe"),
  dtvp: makeNamedGenericAdapter("dtvp"),
  subreport: makeNamedGenericAdapter("subreport"),
  bremenVergabe: makeNamedGenericAdapter("bremenVergabe"),
  hadHessen: makeNamedGenericAdapter("hadHessen"),
};

// Portal Adapter Router (Teil C) – reine Objekt-Lookup-Dispatch, KEIN
// n8n-Switch-Node nötig. Neues Portal = neuer Eintrag, kein neuer Node.
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
function classifyResponse({ statusCode, headers, buffer, finalUrl, networkError, portalCfg, hadValidSession }) {
  const contentType = (headers && (headers["content-type"] || headers["Content-Type"])) || "";
  const contentDisposition = headers && (headers["content-disposition"] || headers["Content-Disposition"]);

  if (networkError || statusCode == null) {
    return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: `NETWORK_ERROR:${networkError || "NO_STATUS_CODE"}`, retryable: true, fileType: null, contentType };
  }

  const httpErrorClass = classifyHttpError(statusCode, headers);
  if (httpErrorClass) return { ...httpErrorClass, fileType: null, contentType };

  if (statusCode < 200 || statusCode >= 300) {
    return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: `UNEXPECTED_HTTP_STATUS:${statusCode}`, retryable: false, fileType: null, contentType };
  }

  const fileType = detectFileType({ buffer, contentTypeHeader: contentType, url: finalUrl, contentDisposition });

  if (fileType.isFile) {
    return { portalAccessStatus: "DIRECT_FILE", portalAccessReason: `FILE_DETECTED:${fileType.kind}`, retryable: false, fileType, contentType };
  }

  if (fileType.kind === "HTML") {
    const bodyText = decodeBody(buffer, contentType);
    if (looksLikeBotChallenge(bodyText)) {
      return { portalAccessStatus: "BLOCKED", portalAccessReason: "BOT_CHALLENGE_DETECTED", retryable: false, fileType, contentType, bodyText };
    }
    if (portalCfg.requiresBrowser || looksLikeSpaShell(bodyText)) {
      return { portalAccessStatus: "BROWSER_REQUIRED", portalAccessReason: "SPA_OR_CONFIG_FLAG", retryable: false, fileType, contentType, bodyText };
    }
    // Login-Formular NICHT sofort als AUTH_REQUIRED werten: manche Portale
    // zeigen ein optionales "Bieter-Login" (z.B. Sidebar/Header) auf einer
    // ansonsten öffentlichen Seite mit echten Downloadlinks. Ob wirklich
    // ein Login nötig ist, entscheidet sich erst NACHDEM der Adapter nach
    // echten Dokumentlinks gesucht hat (siehe processItem: Login-Check nur
    // wenn Passwortfeld vorhanden UND der Adapter 0 Dokumente fand).
    const hasLoginForm = looksLikeLoginForm(bodyText) && !hadValidSession;
    return { portalAccessStatus: "PUBLIC_HTML_WITH_DOWNLOADS", portalAccessReason: "HTML_PAGE_OK", retryable: false, fileType, contentType, bodyText, hasLoginForm };
  }

  return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: fileType.reason || "UNCLASSIFIABLE_RESPONSE", retryable: false, fileType, contentType };
}

/**
 * Liest die Binärdaten des Response-Bodys als Buffer.
 *
 * Bevorzugt (falls verfügbar): `$helpers.getBinaryDataBuffer(index, "data")`
 * – das ist die EINZIGE Methode, die in JEDEM n8n-Binary-Data-Modus korrekt
 * liest (inline/base64 UND filesystem UND S3, je nach
 * N8N_DEFAULT_BINARY_DATA_MODE der Instanz). Diese Methode ist aber NICHT
 * in jeder n8n-Version/Instanz als Code-Node-API garantiert – deshalb wird
 * sie nur verwendet, wenn sie zur Laufzeit tatsächlich als Funktion
 * vorhanden ist (Feature Detection, kein Raten).
 *
 * Fallback (funktioniert IMMER, in jeder Version): rohes Base64-Feld
 * `binaryProp.data` dekodieren. Das ist korrekt im n8n-Standardmodus
 * ("default", inline gespeichert). Läuft deine Instanz mit
 * N8N_DEFAULT_BINARY_DATA_MODE=filesystem oder =s3, enthält `binaryProp.data`
 * KEINEN Base64-String mehr, sondern eine interne Referenz-ID – dann liefert
 * dieser Fallback falsche Bytes. Prüfe im Zweifel einmal mit einem
 * `console.log(typeof $helpers?.getBinaryDataBuffer)`-Testlauf, ob der
 * bevorzugte Pfad in deiner Instanz greift.
 */
async function readBinaryBuffer(binaryProp, index) {
  if (!binaryProp) return { buffer: Buffer.alloc(0), error: null };

  if (typeof $helpers !== "undefined" && $helpers && typeof $helpers.getBinaryDataBuffer === "function") {
    try {
      const buffer = await $helpers.getBinaryDataBuffer(index, "data");
      return { buffer, error: null };
    } catch (err) {
      // fällt durch auf den garantierten Fallback unten – Fehler wird
      // trotzdem gemeldet, damit er im Item sichtbar bleibt, aber die
      // Ausführung nicht abbricht.
      try {
        return { buffer: Buffer.from(binaryProp.data, "base64"), error: `getBinaryDataBuffer fehlgeschlagen (Fallback auf Base64 genutzt): ${err.message}` };
      } catch (fallbackErr) {
        return { buffer: Buffer.alloc(0), error: `Binary-Lesefehler (beide Wege fehlgeschlagen): ${err.message} / ${fallbackErr.message}` };
      }
    }
  }

  try {
    return { buffer: Buffer.from(binaryProp.data, "base64"), error: null };
  } catch (err) {
    return { buffer: Buffer.alloc(0), error: `Binary-Lesefehler (Base64): ${err.message}` };
  }
}

// =====================================================================
// 9. HAUPTABLAUF: ein bereits abgeholtes HTTP-Ergebnis klassifizieren
// =====================================================================
async function processItem(item, index, staticData) {
  const json = item.json || {};
  const procurementPortal = json.procurementPortal || "ANDERES_PORTAL";
  const requestUrl = json.requestUrl || json.firstDocumentUrl || json.sourceUrl;
  const processingErrors = [];
  const retryCountIn = Number(json.retryCount) || 0;

  const out = {
    ...json,
    portalAccessStatus: "MANUAL_REVIEW",
    portalAccessReason: "NOT_PROCESSED",
    sourceUrl: requestUrl,
    finalUrl: requestUrl,
    httpStatus: json.statusCode ?? null,
    contentType: null,
    isDirectFile: false,
    isHtmlPage: false,
    authRequired: false,
    sessionRequired: false,
    browserRequired: false,
    mfaRequired: false, // wird von diesem Core-Node nie auf true gesetzt (keine Login-Versuche hier) – reserviert für einen späteren Login/Browser-Automation-Baustein, siehe Punkt L
    rateLimited: false,
    downloadResolverRequired: false,
    downloadResolverMetadata: null,
    documentsFound: 0,
    documentUrls: [],
    documentNames: [],
    documentMimeTypes: [],
    manualReviewRequired: true,
    loginRequired: false,
    portalAdapterUsed: null,
    latestVersionDetected: null,
    processingErrors,
    sessionCookiesHeader: json.sessionCookiesHeader || "",
    needsRetry: false,
    retryCount: retryCountIn,
    backoffMs: 0,
  };

  if (!requestUrl) {
    out.portalAccessReason = "NO_REQUEST_URL";
    processingErrors.push("requestUrl/firstDocumentUrl fehlt");
    return { json: out, pairedItem: { item: index } };
  }

  const portalCfg = getPortalConfig(procurementPortal, requestUrl);
  const domain = portalCfg.resolvedDomain || "unknown";
  const persistedCookies = json.sessionCookiesHeader ? null : loadPersistedSession(staticData, domain);
  const existingCookies = parseCookieHeader(json.sessionCookiesHeader) || {};
  if (persistedCookies) Object.assign(existingCookies, persistedCookies);
  const hadValidSession = Object.keys(existingCookies).length > 0;

  // Ergebnis des VORGESCHALTETEN HTTP Request Node (keine eigenen Requests hier).
  const networkError = json.error || null;
  const statusCode = json.statusCode ?? null;
  const headers = json.headers || {};
  const binaryProp = (item.binary && item.binary.data) || null;
  const { buffer, error: binaryReadError } = await readBinaryBuffer(binaryProp, index);
  if (binaryReadError) processingErrors.push(binaryReadError);

  const freshCookies = parseSetCookies(headers);
  const mergedCookies = { ...existingCookies, ...freshCookies };
  out.sessionCookiesHeader = cookiesToHeader(mergedCookies);
  if (Object.keys(mergedCookies).length) persistSession(staticData, domain, mergedCookies);

  const classification = classifyResponse({ statusCode, headers, buffer, finalUrl: requestUrl, networkError, portalCfg, hadValidSession });
  out.portalAccessStatus = classification.portalAccessStatus;
  out.portalAccessReason = classification.portalAccessReason;
  out.contentType = classification.contentType || null;

  // --- SESSION_REQUIRED-Handshake (Teil 10/3) ---
  // Erste Anfrage OHNE Session, Antwort ist eine normale (nicht Login-,
  // nicht Bot-Challenge-) HTML-Seite, ABER der Server hat gerade erst ein
  // technisches Session-Cookie gesetzt: viele Portale liefern die echten
  // Downloadlinks erst, wenn dieses Cookie im NÄCHSTEN Request mitgeschickt
  // wird. Statt die Seite jetzt (ohne Cookie) nach Links zu durchsuchen,
  // wird EIN sofortiger erneuter Abruf über denselben Retry-Loop-Mechanismus
  // erzwungen (backoffMs=0 – kein Warten nötig, nur ein neuer Request mit
  // Cookie). Beim zweiten Durchlauf ist hadValidSession=true, dieser Zweig
  // greift dann nicht mehr erneut.
  const gotFreshCookieThisRequest = Object.keys(freshCookies).length > 0;
  const wantsSessionHandshake =
    classification.portalAccessStatus === "PUBLIC_HTML_WITH_DOWNLOADS" &&
    !hadValidSession &&
    gotFreshCookieThisRequest &&
    !json.isDocumentSubFetch;

  if (wantsSessionHandshake) {
    if (retryCountIn >= MAX_SESSION_HANDSHAKE_RETRIES) {
      // Cap erreicht: nicht endlos weiter SESSION_REQUIRED zurückgeben,
      // sondern sauber auf MANUAL_REVIEW gehen statt in eine Schleife zu laufen.
      out.portalAccessStatus = "MANUAL_REVIEW";
      out.portalAccessReason = "SESSION_HANDSHAKE_RETRY_LIMIT_REACHED";
      out.manualReviewRequired = true;
      return { json: out, pairedItem: { item: index } };
    }
    out.portalAccessStatus = "SESSION_REQUIRED";
    out.portalAccessReason = "SESSION_COOKIE_JUST_ISSUED_RETRYING_WITH_COOKIE";
    out.sessionRequired = true;
    out.needsRetry = true;
    out.backoffMs = 0;
    out.retryCount = retryCountIn + 1;
    out.manualReviewRequired = false;
    return { json: out, pairedItem: { item: index } };
  }

  out.authRequired = classification.portalAccessStatus === "AUTH_REQUIRED";
  out.loginRequired = out.authRequired;
  out.browserRequired = classification.portalAccessStatus === "BROWSER_REQUIRED";
  out.rateLimited = classification.portalAccessStatus === "RATE_LIMITED";
  out.manualReviewRequired = ["MANUAL_REVIEW", "BLOCKED"].includes(classification.portalAccessStatus);

  // --- Retry-Entscheidung (reine Berechnung, KEIN Sleep/HTTP hier) ---
  if (classification.retryable && retryCountIn < MAX_RETRY_COUNT) {
    const retryAfterMs = statusCode === 429 ? parseRetryAfter(headers) : null;
    const computedBackoff = retryAfterMs != null ? retryAfterMs : Math.min(2000 * 2 ** retryCountIn, 20000);
    if (computedBackoff <= INLINE_RETRY_MAX_WAIT_MS || statusCode !== 429) {
      out.needsRetry = true;
      out.backoffMs = computedBackoff;
      out.retryCount = retryCountIn + 1;
      // Status bleibt wie klassifiziert (z.B. RATE_LIMITED/MANUAL_REVIEW) UND
      // needsRetry=true – die IF-Node im Hauptworkflow entscheidet anhand
      // von needsRetry, ob zurück zum HTTP Request Node geloopt wird,
      // bevor Telegram/Gate den Status final auswerten.
    }
  }

  // --- DIRECT_FILE: vorhandenes Binary nur umbenennen (KEIN prepareBinaryData) ---
  if (classification.portalAccessStatus === "DIRECT_FILE") {
    out.isDirectFile = true;
    out.documentUrls = [requestUrl];
    out.documentsFound = 1;
    out.portalAdapterUsed = "direct";
    const docIndex = Number.isInteger(json.docIndex) ? json.docIndex : 0;
    const filename = getFilenameFromContentDisposition(headers["content-disposition"]) || `document_${docIndex}.${classification.fileType.ext}`;

    const resultItem = { json: out, pairedItem: { item: index } };
    if (binaryProp) {
      resultItem.binary = { [`doc_${docIndex}`]: { ...binaryProp, fileName: binaryProp.fileName || filename, mimeType: classification.fileType.mime || binaryProp.mimeType } };
    }
    out.documentNames = [filename];
    out.documentMimeTypes = [classification.fileType.mime];
    return resultItem;
  }

  // --- HTML: Adapter zur Linkextraktion aufrufen (nur im Sondierungs-Schritt,
  // nicht wenn wir bereits einen einzelnen Dokumentlink abrufen) ---
  if (!json.isDocumentSubFetch && (classification.portalAccessStatus === "PUBLIC_HTML_WITH_DOWNLOADS" || classification.portalAccessStatus === "SESSION_REQUIRED")) {
    out.isHtmlPage = true;
    const adapterResult = routeToAdapter(portalCfg.parserName, classification.bodyText, requestUrl, hadValidSession);
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

    if (adapterResult.downloadResolverRequired) {
      out.downloadResolverRequired = true;
      out.downloadResolverMetadata = adapterResult.downloadResolverMetadata || null;
    }

    const docUrls = adapterResult.documentUrls || [];
    out.documentUrls = docUrls;
    out.documentsFound = docUrls.length;

    if (!docUrls.length) {
      // Login-Check erst JETZT, mit dem echten Ergebnis der Dokumentensuche:
      // nur wenn ein Passwortfeld erkannt wurde UND der Adapter wirklich
      // NICHTS gefunden hat UND die Seite keine Vergabe-/Tender-Marker
      // enthält, gilt sie als Login-geschützt. Das vermeidet False-Positives
      // bei Seiten mit optionalem Bieter-Login neben öffentlichen Downloads
      // ODER bei Vergabeseiten, deren Downloadstruktur der generische
      // Linkscanner (noch) nicht erkennt – dann lieber MANUAL_REVIEW als
      // fälschlich AUTH_REQUIRED.
      if (classification.hasLoginForm && !hasTenderMarkers(classification.bodyText)) {
        out.portalAccessStatus = "AUTH_REQUIRED";
        out.portalAccessReason = "LOGIN_FORM_DETECTED_NO_DOCUMENTS_FOUND";
        out.authRequired = true;
        out.loginRequired = true;
        out.manualReviewRequired = false;
        return { json: out, pairedItem: { item: index } };
      }
      out.portalAccessStatus = "MANUAL_REVIEW";
      out.portalAccessReason = out.downloadResolverRequired ? "DOWNLOAD_RESOLVER_REQUIRED_NO_DIRECT_LINK" : "NO_DOWNLOAD_LINKS_FOUND_IN_HTML";
      out.manualReviewRequired = true;
    }
    // WICHTIG: Das eigentliche Herunterladen jedes Eintrags in `documentUrls`
    // übernehmen separate HTTP-Request-Nodes im Hauptworkflow (siehe
    // Antwort-Text Punkt 6) – dieser Node lädt hier nichts nach.
    return { json: out, pairedItem: { item: index } };
  }

  // --- isDocumentSubFetch, aber kein DIRECT_FILE (z.B. Session doch
  // abgelaufen -> Login-Seite statt Dokument) ---
  if (json.isDocumentSubFetch) {
    processingErrors.push(`Dokument-Download lieferte keine Datei: ${classification.portalAccessReason}`);
  }

  // --- AUTH_REQUIRED / BROWSER_REQUIRED / RATE_LIMITED / BLOCKED / MANUAL_REVIEW ---
  return { json: out, pairedItem: { item: index } };
}

// =====================================================================
// ENTRY POINT
// =====================================================================
const staticData = $getWorkflowStaticData("global");
const items = $input.all();
const results = [];
for (let i = 0; i < items.length; i++) {
  results.push(await processItem(items[i], i, staticData));
}
return results;
