/**
 * MAXSER – Dokument-Aggregation & Pre-AI-Gate
 * ==============================================
 * Läuft NACH dem "done"-Ausgang von "Loop Over Items" UND parallel dazu
 * direkt hinter der "Bypass"-IF (siehe docs/architecture.md, Node C/D) –
 * beide Zweige münden in denselben Node-Input.
 *
 * Node-Modus: "Run Once for All Items"
 *
 * Zwei Arten von Eingabe-Items landen hier zusammen:
 *  a) "Bypass"-Items: EIN Item pro Ausschreibung (DIRECT_FILE direkt bei
 *     der Sondierung, oder ein Terminalstatus wie AUTH_REQUIRED/
 *     BROWSER_REQUIRED/BLOCKED/MANUAL_REVIEW/kein Downloadlink gefunden).
 *  b) "Loop"-Items: MEHRERE Items pro Ausschreibung (ein Item pro
 *     heruntergeladenem Einzeldokument, aus Split Out + Loop Over Items),
 *     die denselben `_tenderKey` tragen (von Split Out automatisch auf
 *     jedes generierte Item kopiert).
 *
 * Dieser Node gruppiert nach `_tenderKey`, fasst mehrere Dokument-Items
 * wieder zu EINEM Ausschreibungs-Item zusammen (inkl. aller binary.doc_N)
 * und setzt danach documentAccessStatus = OK / PRÜFEN (Teile 15/16).
 *
 * WICHTIG: `_tenderKey` MUSS vor dem "Split Out"-Node gesetzt worden sein
 * (z.B. `json['publication-number'] || json.selectedNumber`), sonst kann
 * hier nicht korrekt gruppiert werden – siehe docs/architecture.md, Node B.
 */

const SUCCESSFUL_STATUSES = new Set(["DIRECT_FILE", "PUBLIC_HTML_WITH_DOWNLOADS"]);

function groupByTenderKey(items) {
  const groups = new Map();
  items.forEach((item, idx) => {
    const key = item.json._tenderKey || item.json["publication-number"] || item.json.selectedNumber || item.json.tedNumber || `__no_key_${idx}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });
  return groups;
}

function mergeBinaries(groupItems) {
  const merged = {};
  for (const item of groupItems) {
    if (!item.binary) continue;
    for (const [key, value] of Object.entries(item.binary)) {
      merged[key] = value; // docIndex ist vor dem Split Out eindeutig vergeben worden
    }
  }
  return merged;
}

function aggregateGroup(groupItems) {
  const first = groupItems[0].json;
  const isMultiItemGroup = groupItems.length > 1;

  const documentsFound = Math.max(0, ...groupItems.map((i) => Number(i.json.documentsFound) || 0));
  // documentDownloadSucceeded (explizites Signal aus dem Classifier) ist die
  // primäre Quelle; isDirectFile als Fallback für ältere/abweichende Items.
  const successfulItems = groupItems.filter((i) => i.json.documentDownloadSucceeded === true || i.json.isDirectFile === true);
  const documentsDownloaded = successfulItems.length;
  const failedDocIndexes = groupItems
    .filter((i) => i.json.documentDownloadFailed === true)
    .map((i) => i.json.docIndex);

  const documentNames = [];
  const documentMimeTypes = [];
  const processingErrors = [];
  for (const item of groupItems) {
    if (Array.isArray(item.json.documentNames)) documentNames.push(...item.json.documentNames);
    if (Array.isArray(item.json.documentMimeTypes)) documentMimeTypes.push(...item.json.documentMimeTypes);
    if (Array.isArray(item.json.processingErrors)) processingErrors.push(...item.json.processingErrors);
  }

  let portalAccessStatus;
  let portalAccessReason;

  if (documentsFound > 0 && documentsDownloaded === documentsFound) {
    portalAccessStatus = isMultiItemGroup ? "PUBLIC_HTML_WITH_DOWNLOADS" : first.portalAccessStatus;
    portalAccessReason = isMultiItemGroup ? "ALL_DOCUMENTS_DOWNLOADED" : first.portalAccessReason;
  } else if (documentsFound > 0 && documentsDownloaded > 0) {
    portalAccessStatus = "MANUAL_REVIEW";
    portalAccessReason = `PARTIAL_DOWNLOAD:${documentsDownloaded}/${documentsFound}`;
  } else if (documentsFound > 0 && documentsDownloaded === 0) {
    portalAccessStatus = "MANUAL_REVIEW";
    portalAccessReason = "ALL_DOCUMENT_DOWNLOADS_FAILED";
  } else {
    // documentsFound === 0: kein Loop gelaufen, Terminalstatus aus der
    // Sondierung/dem Bypass-Zweig 1:1 übernehmen (AUTH_REQUIRED,
    // BROWSER_REQUIRED, BLOCKED, MANUAL_REVIEW, NO_DOWNLOAD_LINKS_FOUND...).
    portalAccessStatus = first.portalAccessStatus;
    portalAccessReason = first.portalAccessReason;
  }

  const binary = mergeBinaries(groupItems);
  const binaryCount = Object.keys(binary).length;

  const out = {
    ...first,
    portalAccessStatus,
    portalAccessReason,
    documentsFound,
    documentsDownloaded,
    documentNames,
    documentMimeTypes,
    downloadSucceeded: documentsFound > 0 && documentsDownloaded === documentsFound,
    processingErrors,
  };
  // Per-Dokument-Hilfsfelder aus der Loop-Verarbeitung gehören nicht mehr
  // auf die Tender-Ebene.
  delete out.docIndex;
  delete out.isDocumentSubFetch;

  const reasons = [];
  if (!SUCCESSFUL_STATUSES.has(portalAccessStatus)) reasons.push(`PORTAL_ACCESS_NOT_SUCCESSFUL:${portalAccessStatus}`);
  if (documentsFound <= 0) reasons.push("NO_DOCUMENTS_FOUND");
  if (documentsDownloaded !== documentsFound) reasons.push(`INCOMPLETE_DOWNLOAD:${documentsDownloaded}/${documentsFound}`);
  if (documentsDownloaded > 0 && binaryCount !== documentsDownloaded) reasons.push(`BINARY_COUNT_MISMATCH:${binaryCount}!=${documentsDownloaded}`);
  if (failedDocIndexes.length) reasons.push(`DOCUMENT_DOWNLOAD_FAILED_AT_INDEX:${failedDocIndexes.join(",")}`);

  out.documentAccessStatus = reasons.length ? "PRÜFEN" : "OK"; // Teile S/T: Default ist immer PRÜFEN, OK nur bei vollständigem, verifiziertem Erfolg
  out.documentAccessReasons = reasons;
  out.manualReviewRequired = out.documentAccessStatus !== "OK";

  return { json: out, binary: binaryCount ? binary : undefined };
}

const items = $input.all();
const groups = groupByTenderKey(items);
const results = [];
for (const groupItems of groups.values()) {
  results.push(aggregateGroup(groupItems));
}
return results;
