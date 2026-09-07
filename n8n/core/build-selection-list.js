/**
 * MAXSER – Build Selection List
 * ================================
 * NEU (ersetzt das ursprünglich geplante "Code in JavaScript3", das im
 * echten Router-Workflow nie gebaut wurde). Läuft direkt nach
 * "Code in JavaScript2" (Portal-Erkennung), bevor die Telegram-Auswahl
 * verschickt wird.
 *
 * Node-Modus: "Run Once for All Items"
 *
 * Fasst alle bis hierhin durchgekommenen Ausschreibungs-Items (nicht
 * abgelaufen, hat einen Dokumentlink) zu EINER nummerierten Liste für
 * genau EINE Telegram-Nachricht zusammen. Die Original-Items werden im
 * Feld `candidates` mitgeschickt, damit "Process Selection" (danach)
 * sie anhand der Nutzerantwort wieder herausfiltern kann.
 */
const items = $input.all();

function labelFor(json) {
  const title = json["notice-title"] || json.title || json.procurementPortal || "Ausschreibung";
  const deadline = json.deadline || json["deadline-receipt-tender-date-lot"] || "";
  return `${title}${deadline ? ` (Frist: ${deadline})` : ""}`;
}

const lines = items.map((item, i) => `${i + 1}. ${labelFor(item.json)}`);

const selectionListText = lines.length
  ? `Gefundene Ausschreibungen:\n\n${lines.join("\n")}\n\nAntworte mit der Nummer (z.B. "2") oder mehreren Nummern durch Komma getrennt (z.B. "1,3"), welche geprüft werden sollen.`
  : "Keine passenden Ausschreibungen gefunden.";

return [
  {
    json: {
      selectionListText,
      candidateCount: items.length,
      candidates: items.map((item) => item.json),
    },
  },
];
