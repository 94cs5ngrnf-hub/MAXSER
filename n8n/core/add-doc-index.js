/**
 * MAXSER – Add Doc Index (vor Loop Over Items)
 * ===============================================
 * Läuft direkt nach "Split Out" (Feld: documentUrls -> documentUrl).
 * Node-Modus: "Run Once for All Items".
 *
 * Vergibt einen pro Ausschreibung eindeutigen, stabilen `docIndex`
 * (0..N-1) für jedes einzelne Dokument-Item, BEVOR die Loop Over
 * Items/HTTP-Request-Schleife läuft. Wird für den Binary-Property-Namen
 * `doc_<docIndex>` gebraucht (siehe portal-access-core.js) – ohne
 * eindeutigen Index würden mehrere Dokumente sich im Aggregations-Node
 * gegenseitig überschreiben.
 *
 * WICHTIG: `_tenderKey` (aus prepare-request.js) muss von Split Out auf
 * jedes generierte Item mitkopiert worden sein (Split Out kopiert per
 * Default alle übrigen Felder) – wird hier nur durchgereicht, nicht neu
 * gesetzt.
 */
const items = $input.all();
const counters = {};
return items.map((item) => {
  const key = item.json._tenderKey || "unknown";
  const idx = counters[key] || 0;
  counters[key] = idx + 1;
  return {
    json: {
      ...item.json,
      requestUrl: item.json.documentUrl, // von Split Out erzeugtes Einzel-URL-Feld
      docIndex: idx,
      isDocumentSubFetch: true,
      retryCount: 0,
    },
  };
});
