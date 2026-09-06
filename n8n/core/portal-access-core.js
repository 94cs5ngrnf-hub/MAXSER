/**
 * MAXSER – Portal Access Core
 * ============================
 * Einziger Code-Node im Sub-Workflow "MAXSER – Portal Access Core".
 * Wird per "Execute Workflow" aus dem Hauptworkflow aufgerufen.
 *
 * Node-Modus: "Run Once for All Items"
 * Sub-Workflow-Aufbau: [Execute Workflow Trigger] -> [dieser Code-Node] -> [NoOp]
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
 */

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
  try { return new URL(url).hostname.replace(/^www\./, ""); } catch (e) { return null; }
}

// =====================================================================
// 2. URL-RESOLVER (Teil E) – relative Links absolut machen
// =====================================================================
function resolveUrl(maybeRelativeUrl, baseUrl) {
  if (!maybeRelativeUrl) return null;
  const trimmed = String(maybeRelativeUrl).trim();
  if (!trimmed || trimmed.startsWith("javascript:") || trimmed.startsWith("#")) return null;
  try {
    // new URL() löst protokollrelative ("//host/..."), absolute und
    // relative ("../x", "x/y.pdf") Pfade gegen baseUrl korrekt auf.
    return new URL(trimmed, baseUrl).toString();
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
// 3. DATEI-ERKENNUNG: Content-Type + Magic Bytes (Teil D)
// =====================================================================
const MAGIC_SIGNATURES = [
  { type: "PDF", mime: "application/pdf", ext: "pdf", check: (b) => b.length >= 4 && b.slice(0, 4).toString("latin1") === "%PDF" },
  { type: "ZIP_FAMILY", mime: "application/zip", ext: "zip", check: (b) => b.length >= 4 && (
      (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) ||
      (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x05 && b[3] === 0x06) ||
      (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x07 && b[3] === 0x08)
    ) },
];

// ZIP-basierte Office-Formate (DOCX/XLSX) lassen sich ohne Entpacken der
// zentralen Verzeichnisstruktur nicht 100%ig von einem einfachen ZIP
// unterscheiden. Deshalb: Magic Bytes bestätigen nur "ZIP-Familie",
// die genaue Unterscheidung DOCX/XLSX/ZIP erfolgt über Content-Type und
// Dateiendung (URL / Content-Disposition). Bleibt das mehrdeutig, wird
// NICHT geraten (siehe X) – es bleibt bei "application/zip" + ext "zip".
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

function sniffTextKind(buffer) {
  const sample = buffer.slice(0, 2048).toString("utf8").trim();
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

  let magic = null;
  if (buffer && buffer.length) {
    for (const sig of MAGIC_SIGNATURES) {
      if (sig.check(buffer)) { magic = sig; break; }
    }
    if (!magic) {
      const textKind = sniffTextKind(buffer);
      if (textKind) magic = { type: textKind, mime: EXTENSION_MIME_MAP[textKind.toLowerCase()] || null, ext: textKind.toLowerCase() };
    }
  }

  // Fall 1: Magic Bytes sagen eindeutig PDF -> vertrauen, unabhängig vom Header.
  if (magic && magic.type === "PDF") {
    return { kind: "PDF", mime: "application/pdf", ext: "pdf", isFile: true, source: "magic" };
  }

  // Fall 2: ZIP-Familie per Magic Bytes bestätigt -> Feinunterscheidung über Header/Extension.
  if (magic && magic.type === "ZIP_FAMILY") {
    if (declaredExt === "docx" || ctHeader.includes("wordprocessingml")) {
      return { kind: "DOCX", mime: EXTENSION_MIME_MAP.docx, ext: "docx", isFile: true, source: "magic+header" };
    }
    if (declaredExt === "xlsx" || ctHeader.includes("spreadsheetml")) {
      return { kind: "XLSX", mime: EXTENSION_MIME_MAP.xlsx, ext: "xlsx", isFile: true, source: "magic+header" };
    }
    return { kind: "ZIP", mime: "application/zip", ext: "zip", isFile: true, source: "magic" };
  }

  // Fall 3: Text-artige Formate per Sniff (XML/HTML/CSV).
  if (magic && (magic.type === "XML" || magic.type === "HTML" || magic.type === "CSV")) {
    return { kind: magic.type, mime: magic.mime || EXTENSION_MIME_MAP[magic.ext], ext: magic.ext, isFile: magic.type !== "HTML", source: "sniff" };
  }

  // Fall 4: Kein Buffer verfügbar (z.B. HEAD-Request) oder Sniff ergab nichts
  // -> auf Content-Type-Header zurückfallen, wenn er eindeutig ist.
  if (ctHeader === "application/pdf") return { kind: "PDF", mime: ctHeader, ext: "pdf", isFile: true, source: "header" };
  if (ctHeader === "application/zip" || ctHeader === "application/x-zip-compressed") return { kind: "ZIP", mime: ctHeader, ext: "zip", isFile: true, source: "header" };
  if (ctHeader.includes("wordprocessingml")) return { kind: "DOCX", mime: ctHeader, ext: "docx", isFile: true, source: "header" };
  if (ctHeader.includes("spreadsheetml")) return { kind: "XLSX", mime: ctHeader, ext: "xlsx", isFile: true, source: "header" };
  if (ctHeader === "text/csv") return { kind: "CSV", mime: ctHeader, ext: "csv", isFile: true, source: "header" };
  if (ctHeader === "application/xml" || ctHeader === "text/xml") return { kind: "XML", mime: ctHeader, ext: "xml", isFile: true, source: "header" };
  if (ctHeader === "text/html") return { kind: "HTML", mime: ctHeader, ext: "html", isFile: false, source: "header" };

  // Fall 5: gar nichts Eindeutiges -> nicht raten.
  return { kind: "UNKNOWN", mime: ctHeader || null, ext: declaredExt || null, isFile: false, source: "none", reason: `UNKNOWN_CONTENT_TYPE:${ctHeader || "n/a"}` };
}

// =====================================================================
// 4. COOKIE-JAR / SESSION-PERSISTENZ (Teil H)
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
// 5. HTTP MIT RETRY/BACKOFF + FEHLERHANDLER (Teile F, G)
// =====================================================================
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function parseRetryAfter(headers) {
  const val = headers && (headers["retry-after"] || headers["Retry-After"]);
  if (!val) return null;
  const asInt = parseInt(val, 10);
  if (!Number.isNaN(asInt)) return asInt * 1000;
  const asDate = Date.parse(val);
  if (!Number.isNaN(asDate)) return Math.max(0, asDate - Date.now());
  return null;
}

/**
 * Führt einen HTTP-Request mit Redirect-Folge, Cookie-Header und
 * Retry/Backoff für 408/429/5xx aus. Wirft NIE bei HTTP-Fehlerstatus
 * (Never-Error-Verhalten) – der Aufrufer entscheidet anhand von
 * result.status, wie weiter zu verfahren ist.
 */
async function robustRequest(helpers, { url, method = "GET", cookieHeader, extraHeaders = {} }) {
  let attempt = 0;
  let lastResult = null;
  while (attempt <= MAX_RETRIES) {
    attempt += 1;
    try {
      const response = await helpers.httpRequest({
        url,
        method,
        headers: { ...(cookieHeader ? { Cookie: cookieHeader } : {}), ...extraHeaders },
        encoding: "arraybuffer",
        returnFullResponse: true,
        ignoreHttpStatusErrors: true,
        timeout: 30000,
        followRedirect: true,
        maxRedirects: 10,
      });
      const status = response.statusCode || response.status || 200;
      const headers = response.headers || {};
      const body = Buffer.isBuffer(response.body) ? response.body : Buffer.from(response.body || "");
      lastResult = { status, headers, body, finalUrl: response.url || url, error: null };

      if (RETRYABLE_STATUS.has(status) && attempt <= MAX_RETRIES) {
        const retryAfterMs = status === 429 ? parseRetryAfter(headers) : null;
        const backoffMs = retryAfterMs != null ? retryAfterMs : Math.min(2000 * 2 ** (attempt - 1), 20000);
        await sleep(backoffMs);
        continue;
      }
      return lastResult;
    } catch (err) {
      // Netzwerkfehler (DNS, Connection Reset, Timeout) statt HTTP-Fehlerstatus.
      lastResult = { status: null, headers: {}, body: Buffer.alloc(0), finalUrl: url, error: err.message || String(err) };
      if (attempt <= MAX_RETRIES) {
        await sleep(Math.min(2000 * 2 ** (attempt - 1), 20000));
        continue;
      }
      return lastResult;
    }
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
    case 429: return { portalAccessStatus: "RATE_LIMITED", portalAccessReason: `HTTP_429_RATE_LIMITED_AFTER_RETRIES:${parseRetryAfter(headers) || "n/a"}` };
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
    t.includes("access denied") && t.includes("reference #")
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
// 6. PORTAL-ADAPTER (Teil C – Router) + Beispiel-Adapter (L, M, N)
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
      links.push({ url: href, label: text || null });
    }
  }
  // Zusätzlich data-* Attribute mit Datei-Endungen erfassen (z.B. data-href, data-download-url).
  const dataAttrRe = /data-(?:href|download-url|file-url|url)=["']([^"']+)["']/gi;
  while ((m = dataAttrRe.exec(html)) !== null) {
    if (DOC_EXT_RE.test(m[1])) links.push({ url: m[1], label: null });
  }
  const absoluteUrls = absolutizeAll(links.map((l) => l.url), baseUrl);
  return { documentUrls: absoluteUrls, latestVersion: null, adapterUsed: "genericHtml" };
}

// L) Beispieladapter vergabe.muenchen.de – nutzt latestDocumentOid/-Token,
// wie im München-Test ermittelt. Baut daraus die konkrete Download-URL.
function vergabeMuenchenAdapter(html, baseUrl) {
  const versionMatches = [...html.matchAll(/data-version=["']?(\d+)["']?/gi)].map((m) => parseInt(m[1], 10));
  const latestVersion = versionMatches.length ? Math.max(...versionMatches) : null;

  const oidMatch = html.match(/oid=([A-Za-z0-9\-_]+)/i) || html.match(/data-oid=["']([A-Za-z0-9\-_]+)["']/i);
  const tokenMatch = html.match(/token=([A-Za-z0-9\-_.]+)/i) || html.match(/data-token=["']([A-Za-z0-9\-_.]+)["']/i);
  const dateMatch = html.match(/data-date=["']([^"']+)["']/i);

  const latestDocumentOid = oidMatch ? oidMatch[1] : null;
  const latestDocumentToken = tokenMatch ? tokenMatch[1] : null;
  const latestDocumentDate = dateMatch ? dateMatch[1] : null;

  if (!latestDocumentOid || !latestDocumentToken) {
    // Muster nicht gefunden -> nicht raten, generischer Adapter als Fallback.
    return { ...genericHtmlAdapter(html, baseUrl), adapterUsed: "vergabeMuenchen->genericHtmlFallback" };
  }

  const downloadUrl = resolveUrl(
    `/vergabe/document/download?oid=${encodeURIComponent(latestDocumentOid)}&token=${encodeURIComponent(latestDocumentToken)}`,
    baseUrl
  );

  return {
    documentUrls: [downloadUrl],
    latestVersion,
    adapterUsed: "vergabeMuenchen",
    meta: { latestDocumentOid, latestDocumentToken, latestDocumentDate, latestDocumentVersion: latestVersion },
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

// Portal Adapter Router (Teil C)
function routeToAdapter(parserName, html, baseUrl, hadValidSession) {
  const adapterFn = ADAPTERS[parserName] || ADAPTERS.genericHtml;
  try {
    if (adapterFn === loginSessionPortalAdapter) return adapterFn(html, baseUrl, hadValidSession);
    return adapterFn(html, baseUrl);
  } catch (err) {
    return { documentUrls: [], latestVersion: null, adapterUsed: `${parserName}:ERROR`, error: err.message };
  }
}

// =====================================================================
// 7. UNIVERSAL RESPONSE CLASSIFIER (Teil B)
// =====================================================================
function classifyResponse({ result, portalCfg, hadValidSession }) {
  const { status, headers, body, error } = result;
  const contentType = (headers["content-type"] || headers["Content-Type"] || "");
  const contentDisposition = headers["content-disposition"] || headers["Content-Disposition"];

  if (error && status == null) {
    return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: `NETWORK_ERROR:${error}`, fileType: null, contentType, isBotChallenge: false };
  }

  const httpErrorClass = classifyHttpError(status, headers);
  if (httpErrorClass) {
    return { ...httpErrorClass, fileType: null, contentType, isBotChallenge: status === 403 };
  }

  if (status < 200 || status >= 300) {
    return { portalAccessStatus: "MANUAL_REVIEW", portalAccessReason: `UNEXPECTED_HTTP_STATUS:${status}`, fileType: null, contentType, isBotChallenge: false };
  }

  const fileType = detectFileType({ buffer: body, contentTypeHeader: contentType, url: result.finalUrl, contentDisposition });

  if (fileType.isFile) {
    return { portalAccessStatus: "DIRECT_FILE", portalAccessReason: `FILE_DETECTED:${fileType.kind}`, fileType, contentType, isBotChallenge: false };
  }

  if (fileType.kind === "HTML") {
    const bodyText = body.toString("utf8");
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
// 8. HAUPTABLAUF: pro Item verarbeiten
// =====================================================================
async function processItem(item, helpers, staticData) {
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
    return { json: out };
  }

  const portalCfg = getPortalConfig(procurementPortal, sourceUrl);
  const domain = portalCfg.resolvedDomain || "unknown";

  const persistedCookies = json.sessionCookies || loadPersistedSession(staticData, domain);
  let cookieJar = persistedCookies || {};
  const hadValidSession = !!(persistedCookies && Object.keys(persistedCookies).length);

  // --- 1. Probe-Request ---
  const result = await robustRequest(helpers, { url: sourceUrl, cookieHeader: cookiesToHeader(cookieJar) });
  out.finalUrl = result.finalUrl || sourceUrl;
  out.httpStatus = result.status;
  const freshCookies = parseSetCookies(result.headers);
  if (Object.keys(freshCookies).length) {
    cookieJar = mergeCookies(cookieJar, freshCookies);
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
    return { json: out, binary: item.binary };
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
      return { json: out };
    }

    const docUrls = adapterResult.documentUrls || [];
    out.documentUrls = docUrls;
    out.documentsFound = docUrls.length;

    if (!docUrls.length) {
      out.portalAccessStatus = "MANUAL_REVIEW";
      out.portalAccessReason = "NO_DOWNLOAD_LINKS_FOUND_IN_HTML";
      out.manualReviewRequired = true;
      return { json: out };
    }

    // --- 4. Alle gefundenen Dokumente herunterladen ---
    item.binary = item.binary || {};
    let idx = 0;
    for (const docUrl of docUrls) {
      const docResult = await robustRequest(helpers, { url: docUrl, cookieHeader: cookiesToHeader(cookieJar) });
      const docFresh = parseSetCookies(docResult.headers);
      if (Object.keys(docFresh).length) { cookieJar = mergeCookies(cookieJar, docFresh); persistSession(staticData, domain, cookieJar); }

      const docClass = classifyResponse({ result: docResult, portalCfg, hadValidSession: true });
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
    return { json: out, binary: item.binary };
  }

  // --- 5. AUTH_REQUIRED / BROWSER_REQUIRED / RATE_LIMITED / BLOCKED / MANUAL_REVIEW ---
  // Wird unverändert an den Hauptworkflow zurückgegeben; dort entscheidet
  // die IF-Node über Auth/Browser-Orchestrator bzw. Telegram-Fehlermeldung.
  return { json: out };
}

// =====================================================================
// ENTRY POINT
// =====================================================================
const staticData = $getWorkflowStaticData("global");
const items = $input.all();
const results = [];
for (const item of items) {
  results.push(await processItem(item, $helpers, staticData));
}
return results;
