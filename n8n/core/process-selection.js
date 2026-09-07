/**
 * MAXSER – Process Selection
 * ============================
 * NEU (ersetzt das ursprünglich geplante "Code in JavaScript5", das im
 * echten Router-Workflow nie gebaut wurde). Läuft direkt nach dem
 * Telegram-Node "Send and Wait for Response" (Free Text).
 *
 * Node-Modus: "Run Once for All Items"
 *
 * WICHTIG, NICHT VERIFIZIERT: Der Feldname, unter dem n8n die Freitext-
 * Antwort des "Send and Wait for Response"-Node ablegt, hängt von der
 * n8n-Version ab (typischerweise `data.text` oder `text`). Das MUSS mit
 * einem echten Testlauf geprüft werden (Output-Panel des Telegram-Node
 * ansehen) – im Code unten wird beides versucht, mit Fallback.
 */
const input = $input.first().json;
const candidates = input.candidates || [];

const replyText = String(
  input.text ?? input.data?.text ?? input.message?.text ?? ""
).trim();

const selectedIndexes = replyText
  .split(",")
  .map((s) => parseInt(s.trim(), 10))
  .filter((n) => Number.isInteger(n) && n >= 1 && n <= candidates.length);

if (!selectedIndexes.length) {
  // Keine gueltige Auswahl erkannt -> nichts weiterverarbeiten (leeres
  // Ergebnis stoppt die nachfolgende Kette sauber, statt zu raten).
  return [];
}

return selectedIndexes.map((n) => ({ json: candidates[n - 1] }));
