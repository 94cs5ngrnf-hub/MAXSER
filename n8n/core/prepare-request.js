/**
 * MAXSER – Prepare Request
 * ==========================
 * Erster Node im Sub-Workflow "MAXSER – Portal Access Core", direkt nach
 * dem Execute-Workflow-Trigger. Node-Modus: "Run Once for All Items".
 *
 * Setzt die Felder, die "HTTP Request – Probe" und "Universal Classifier"
 * (portal-access-core.js) als Startzustand erwarten. Reine Feldzuweisung,
 * keine n8n-spezifische API nötig.
 */
const items = $input.all();
return items.map((item, i) => ({
  json: {
    ...item.json,
    requestUrl: item.json.firstDocumentUrl,
    _tenderKey: item.json["publication-number"] || item.json.selectedNumber || item.json.tedNumber || `tender_${i}`,
    retryCount: 0,
    sessionCookiesHeader: item.json.sessionCookiesHeader || "",
    docIndex: 0,
    isDocumentSubFetch: false,
  },
}));
