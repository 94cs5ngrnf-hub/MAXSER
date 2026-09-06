/**
 * MAXSER – Dokument-Normalisierung & Pre-AI-Gate
 * ================================================
 * Code-Node im HAUPTWORKFLOW, direkt vor der IF-Node
 * "documentAccessStatus == OK?" (die wiederum vor Merge/AI-Agent steht).
 * Node-Modus: "Run Once for All Items".
 *
 * Zuständig für Teile Q (Binärdaten), R (Verhindern vorzeitiger Analyse),
 * S/T (documentAccessStatus setzen).
 */

const REQUIRED_DOC_KEY_PREFIX = "doc_";

function countBinaryDocs(item) {
  if (!item.binary) return 0;
  return Object.keys(item.binary).filter((k) => k.startsWith(REQUIRED_DOC_KEY_PREFIX)).length;
}

function allBinariesNonEmpty(item) {
  if (!item.binary) return false;
  return Object.keys(item.binary)
    .filter((k) => k.startsWith(REQUIRED_DOC_KEY_PREFIX))
    .every((k) => {
      const bin = item.binary[k];
      // n8n Binary-Objekte tragen entweder fileSize oder lassen sich über
      // die base64-Länge grob validieren.
      if (bin.fileSize != null) return Number(bin.fileSize) > 0;
      return !!(bin.data && bin.data.length > 0);
    });
}

const BLOCKING_STATUSES = new Set(["AUTH_REQUIRED", "BROWSER_REQUIRED", "RATE_LIMITED", "BLOCKED", "MANUAL_REVIEW"]);

function evaluateGate(item) {
  const json = item.json;
  const reasons = [];

  if (BLOCKING_STATUSES.has(json.portalAccessStatus)) {
    reasons.push(`OPEN_ACCESS_STATE:${json.portalAccessStatus}`);
  }
  if (!json.documentsFound || json.documentsFound <= 0) {
    reasons.push("NO_DOCUMENTS_FOUND");
  }
  if ((json.documentsDownloaded || 0) !== (json.documentsFound || 0)) {
    reasons.push(`INCOMPLETE_DOWNLOAD:${json.documentsDownloaded || 0}/${json.documentsFound || 0}`);
  }
  const binCount = countBinaryDocs(item);
  if (binCount === 0) {
    reasons.push("NO_BINARY_ATTACHED");
  } else if (binCount !== (json.documentsDownloaded || 0)) {
    reasons.push(`BINARY_COUNT_MISMATCH:${binCount}!=${json.documentsDownloaded}`);
  }
  if (!allBinariesNonEmpty(item)) {
    reasons.push("EMPTY_BINARY_DETECTED");
  }

  return reasons;
}

const out = [];
for (const item of $input.all()) {
  // Fail-safe Default (Teil T): PRÜFEN, solange nicht explizit alle
  // Bedingungen unten erfüllt sind.
  const failReasons = evaluateGate(item);

  const json = {
    ...item.json,
    documentAccessStatus: failReasons.length ? "PRÜFEN" : "OK", // Teil S/T
    documentAccessReasons: failReasons,
  };

  out.push({ json, binary: item.binary });
}
return out;
