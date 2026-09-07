/**
 * MAXSER – Telegram-Fehlermeldungen
 * ===================================
 * Code-Node im HAUPTWORKFLOW, im FALSE-Zweig der IF-Node
 * "documentAccessStatus == OK?", direkt vor dem finalen Telegram-Node.
 * Node-Modus: "Run Once for All Items".
 *
 * Baut aus portalAccessStatus/-Reason und documentAccessReasons eine
 * verständliche deutsche Nachricht für den verantwortlichen Menschen
 * (Teil 17/U). Erwartet, dass der nachfolgende Telegram-Node das Feld
 * `telegramMessage` als Text sendet.
 */

function pickPrimaryReason(json) {
  if (json.mfaPending || json.mfaRequired) return "MFA_REQUIRED";
  return json.portalAccessReason || (json.documentAccessReasons && json.documentAccessReasons[0]) || "UNKNOWN";
}

function buildTelegramMessage(json) {
  const ted = json["publication-number"] || json.selectedNumber || json.tedNumber || json.noticeNumber || json.id || "unbekannt";
  const portal = json.procurementPortal || "unbekannt";
  const link = json.sourceUrl || json.finalUrl || "kein Link";
  const reason = pickPrimaryReason(json);

  const header = `⚠️ Ausschreibung ${ted} (${portal}) benötigt manuelle Prüfung`;
  const footer = `\n\nLink: ${link}\nStatus: ${json.portalAccessStatus || "n/a"} / ${json.documentAccessStatus || "PRÜFEN"}\nGrund: ${reason}`;

  if (json.mfaPending || json.mfaRequired) {
    return `🔐 ${header}\n\nFür dieses Portal ist eine Zwei-Faktor-Bestätigung (MFA) nötig. Bitte den aktuellen Code eingeben, sobald du ihn erhalten hast (als Antwort auf die vorherige Nachricht).${footer}`;
  }
  if (json.portalAccessStatus === "AUTH_REQUIRED") {
    return `🔑 ${header}\n\nEs ist ein Login mit echten Firmen-Zugangsdaten nötig, der aktuell nicht automatisiert hinterlegt/erfolgreich war. Bitte manuell prüfen oder Zugangsdaten für dieses Portal hinterlegen.${footer}`;
  }
  if (json.portalAccessStatus === "BLOCKED") {
    return `🚫 ${header}\n\nDas Portal hat den Zugriff blockiert (403 / Bot-Schutz). Es wurde bewusst NICHT versucht, das zu umgehen. Bitte den Dokumenten-Download manuell durchführen.${footer}`;
  }
  if (json.portalAccessStatus === "RATE_LIMITED") {
    return `⏳ ${header}\n\nDas Portal hat wiederholt mit "429 Too Many Requests" geantwortet, auch nach Backoff. Bitte später erneut versuchen.${footer}`;
  }
  if (json.portalAccessStatus === "BROWSER_REQUIRED") {
    return `🖥️ ${header}\n\nDie Seite ist stark JavaScript-basiert; ohne Browser-Automation konnten keine Downloads ermittelt werden. Bitte die Unterlagen manuell im Browser öffnen.${footer}`;
  }
  if (json.downloadResolverRequired) {
    const meta = json.downloadResolverMetadata ? JSON.stringify(json.downloadResolverMetadata) : "n/a";
    return `🧩 ${header}\n\nDas Portal liefert Download-Metadaten (z.B. OID/Token), aber keinen direkt nutzbaren Downloadlink. Es wurde bewusst NICHTS geraten. Metadaten: ${meta}${footer}`;
  }
  if (json.portalAccessReason === "NO_DOWNLOAD_LINKS_FOUND_IN_HTML") {
    return `📭 ${header}\n\nAuf der öffentlichen Seite wurden keine Downloadlinks gefunden. Bitte die Seite manuell prüfen.${footer}`;
  }
  if ((json.documentAccessReasons || []).some((r) => r.startsWith("INCOMPLETE_DOWNLOAD") || r.startsWith("PARTIAL_DOWNLOAD"))) {
    return `📄 ${header}\n\nEs konnten nicht alle Vergabeunterlagen heruntergeladen werden (${json.documentsDownloaded || 0}/${json.documentsFound || 0}). Bitte die fehlenden Dokumente manuell prüfen.${footer}`;
  }
  return `❓ ${header}\n\nDer Downloadweg konnte nicht zuverlässig automatisiert bestimmt werden. Bitte manuell prüfen.${footer}`;
}

const out = [];
for (const item of $input.all()) {
  out.push({ json: { ...item.json, telegramMessage: buildTelegramMessage(item.json) } });
}
return out;
