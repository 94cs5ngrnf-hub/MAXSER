/**
 * MAXSER – Restore Probe Metadata (FIX für den bestehenden Node)
 * ==================================================================
 * Ersetzt 1:1 den bisherigen Code im bereits vorhandenen Node
 * "Restore Probe Metadata" (zwischen "HTTP Probe" und "Universal
 * Classifier"). KEIN neuer Node, keine neue Verkabelung.
 *
 * BISHERIGER BUG (bestätigt durch echten Node-Export):
 *   const originals = $("Prepare Request").all();
 * "Prepare Request" läuft in der Retry-Schleife nur EINMAL (vor dem
 * ersten Versuch). Bei jedem Retry lieferte $("Prepare Request").all()
 * trotzdem denselben, ersten Stand zurück – mit leerem
 * sessionCookiesHeader und retryCount=0. Der neue Cookie aus Classifier 1
 * ging dadurch beim erneuten Request verloren, und retryCount stieg nie,
 * wodurch die Retry-Obergrenzen (MAX_RETRY_COUNT / MAX_SESSION_HANDSHAKE_RETRIES)
 * nie griffen.
 *
 * FIX: Für genau diese zwei Felder (sessionCookiesHeader, retryCount) –
 * NICHT für alle Felder – wird zusätzlich in $getWorkflowStaticData
 * nachgeschaut. Das ist dieselbe Static-Data-Struktur, die
 * "Universal Classifier" (portal-access-core.js) ohnehin schon selbst
 * pflegt (staticData.sessions[domain], staticData.retryState[key]) –
 * hier wird nur zusätzlich daraus gelesen, nichts Neues eingeführt.
 * Alle anderen Felder (procurementPortal, _tenderKey, requestUrl, ...)
 * bleiben unverändert wie bisher aus "Prepare Request" + der
 * HTTP-Probe-Antwort zusammengeführt, weil die sich zwischen Retries
 * korrekterweise NICHT ändern.
 */
const responses = $input.all();
const originals = $("Prepare Request").all();
const staticData = $getWorkflowStaticData("global");

function domainFromUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch (e) { return null; }
}

function retryStateKey(json) {
  const tenderKey = json._tenderKey || "unknown";
  return json.isDocumentSubFetch ? `${tenderKey}::doc${json.docIndex ?? "?"}` : `${tenderKey}::probe`;
}

return responses.map((item, index) => {
  const original = originals[index]?.json || {};
  const merged = {
    ...original,
    ...item.json,
  };

  // --- Fix 1: sessionCookiesHeader aus staticData nachladen, falls leer ---
  if (!merged.sessionCookiesHeader) {
    const domain = domainFromUrl(merged.requestUrl || merged.firstDocumentUrl);
    const entry = domain && staticData.sessions && staticData.sessions[domain];
    if (entry && entry.expiresAt > Date.now()) {
      merged.sessionCookiesHeader = Object.entries(entry.cookies)
        .map(([k, v]) => `${k}=${v}`)
        .join("; ");
    }
  }

  // --- Fix 2: retryCount nie unter den zuletzt bekannten Stand fallen lassen ---
  const key = retryStateKey(merged);
  const persistedRetry = staticData.retryState && staticData.retryState[key];
  const persistedRetryCount = persistedRetry && persistedRetry.expiresAt > Date.now() ? persistedRetry.retryCount : 0;
  merged.retryCount = Math.max(Number(merged.retryCount) || 0, persistedRetryCount);

  return {
    json: merged,
    binary: item.binary,
    pairedItem: { item: index },
  };
});
