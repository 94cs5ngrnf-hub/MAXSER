/**
 * MAXSER – Auth/Browser Orchestrator
 * ===================================
 * Code-Node im HAUPTWORKFLOW, direkt nach der IF-Node
 * "Login/Browser nötig?" (portalAccessStatus IN [AUTH_REQUIRED, BROWSER_REQUIRED]).
 * Node-Modus: "Run Once for All Items".
 *
 * Zuständig für Teile I (Login/Session), J (MFA), K (JS-Downloads).
 *
 * WICHTIG:
 * - Zugangsdaten kommen ausschließlich aus n8n-Credentials, niemals aus
 *   Item-Feldern oder Klartext im Code.
 * - Dieser Node ruft NIE selbst einen echten Browser auf (n8n kann das
 *   nicht nativ) – er spricht mit einem separat betriebenen, legitimen
 *   Browser-Automation-Microservice (z.B. selbst gehosteter
 *   Playwright/Browserless-Dienst), der:
 *     * ganz normal navigiert (keine Tarnung als Mensch, keine
 *       Anti-Bot-Umgehung),
 *     * bei MFA anhält und den Zustand zurückmeldet, statt zu raten,
 *     * bei SPA/JS-Portalen die realen Download-Requests der Seite
 *       beobachtet und zurückgibt.
 * - Dieser Node ersetzt in n8n am besten eine eigene Credential
 *   "MAXSER Browser Automation Service" (Header-Auth-Token für den
 *   Microservice) plus je Portal eine Login-Credential, z.B.
 *   "MAXSER_<PORTAL>_LOGIN" mit Feldern username/password.
 *
 * Die Konstante BROWSER_SERVICE_URL unten muss auf deinen eigenen,
 * autorisierten Microservice zeigen (kein Public-Dienst Dritter).
 */

const BROWSER_SERVICE_URL = $env.MAXSER_BROWSER_SERVICE_URL || "https://browser-automation.internal.example/api";

// Ordnet procurementPortal -> Name der n8n-Credential mit den
// Firmen-Login-Daten für dieses Portal. Fehlt ein Eintrag, ist der
// Login für dieses Portal (noch) nicht freigeschaltet -> MANUAL_REVIEW.
const LOGIN_CREDENTIAL_BY_PORTAL = {
  // Beispiel: BERLIN_VERGABE: "MAXSER_BERLIN_VERGABE_LOGIN",
};

async function callBrowserService(path, payload) {
  return $helpers.httpRequest({
    method: "POST",
    url: `${BROWSER_SERVICE_URL}${path}`,
    headers: { "Content-Type": "application/json" },
    body: payload,
    json: true,
    timeout: 60000,
    ignoreHttpStatusErrors: true,
    returnFullResponse: true,
  });
}

async function handleAuthRequired(item, staticData) {
  const portal = item.json.procurementPortal;
  const credentialName = LOGIN_CREDENTIAL_BY_PORTAL[portal];

  if (!credentialName) {
    return {
      ...item.json,
      portalAccessStatus: "MANUAL_REVIEW",
      portalAccessReason: `NO_AUTHORIZED_CREDENTIAL_CONFIGURED_FOR:${portal}`,
      manualReviewRequired: true,
    };
  }

  // Zugangsdaten werden über die n8n-Credential-Auflösung geladen, NICHT
  // hart codiert. `this.getCredentials` steht im Code-Node zur Verfügung,
  // wenn die Credential im Node als "Custom Credential" hinterlegt ist;
  // alternativ: eigenen "HTTP Request"-Node mit "Predefined Credential
  // Type" für den Login-Call verwenden und nur das Ergebnis hier
  // weiterverarbeiten. Beispiel mit Code-Node-API:
  let creds;
  try {
    creds = await this.getCredentials(credentialName);
  } catch (err) {
    return {
      ...item.json,
      portalAccessStatus: "MANUAL_REVIEW",
      portalAccessReason: `CREDENTIAL_LOOKUP_FAILED:${err.message}`,
      manualReviewRequired: true,
    };
  }

  const loginResponse = await callBrowserService("/login", {
    portal,
    loginUrl: item.json.finalUrl || item.json.sourceUrl,
    username: creds.username,
    password: creds.password,
  });

  const body = loginResponse.body || {};

  if (body.status === "MFA_REQUIRED") {
    // Session-Zwischenzustand merken, damit die Fortsetzung nach der
    // menschlichen MFA-Eingabe an derselben Stelle weitermachen kann.
    if (!staticData.pendingMfa) staticData.pendingMfa = {};
    staticData.pendingMfa[item.json.tedNumber || item.json.id || portal] = {
      mfaSessionToken: body.mfaSessionToken,
      portal,
      createdAt: Date.now(),
    };
    return {
      ...item.json,
      portalAccessStatus: "AUTH_REQUIRED",
      portalAccessReason: "MFA_REQUIRED",
      manualReviewRequired: false,
      mfaPending: true,
    };
  }

  if (body.status !== "LOGIN_OK" || !body.cookies) {
    return {
      ...item.json,
      portalAccessStatus: "MANUAL_REVIEW",
      portalAccessReason: `LOGIN_FAILED:${body.reason || loginResponse.statusCode}`,
      manualReviewRequired: true,
    };
  }

  if (!staticData.sessions) staticData.sessions = {};
  staticData.sessions[item.json.finalUrlDomain || new URL(item.json.finalUrl).hostname] = {
    cookies: body.cookies,
    expiresAt: Date.now() + 25 * 60 * 1000,
  };

  return {
    ...item.json,
    portalAccessStatus: "SESSION_REQUIRED", // Core beim 2. Aufruf mit dieser Session erneut probieren lassen
    portalAccessReason: "LOGIN_SUCCEEDED_RETRY_WITH_SESSION",
    sessionCookies: body.cookies,
    manualReviewRequired: false,
  };
}

/**
 * Setzt den MFA-Code fort, den der Nutzer per Telegram "Send and Wait for
 * Response" eingegeben hat. `item.json.mfaCodeFromUser` muss vor diesem
 * Node aus der Telegram-Antwort geschrieben worden sein (z.B. im
 * vorgeschalteten "Code in JavaScriptX" für die Antwort-Verarbeitung).
 */
async function continueMfa(item, staticData) {
  const key = item.json.tedNumber || item.json.id || item.json.procurementPortal;
  const pending = staticData.pendingMfa && staticData.pendingMfa[key];
  if (!pending) {
    return {
      ...item.json,
      portalAccessStatus: "MANUAL_REVIEW",
      portalAccessReason: "MFA_CONTINUATION_STATE_LOST",
      manualReviewRequired: true,
    };
  }

  const mfaResponse = await callBrowserService("/mfa", {
    mfaSessionToken: pending.mfaSessionToken,
    mfaCode: item.json.mfaCodeFromUser,
  });
  const body = mfaResponse.body || {};
  delete staticData.pendingMfa[key];

  if (body.status !== "LOGIN_OK" || !body.cookies) {
    return {
      ...item.json,
      portalAccessStatus: "MANUAL_REVIEW",
      portalAccessReason: `MFA_FAILED:${body.reason || mfaResponse.statusCode}`,
      manualReviewRequired: true,
    };
  }

  if (!staticData.sessions) staticData.sessions = {};
  staticData.sessions[new URL(item.json.finalUrl).hostname] = {
    cookies: body.cookies,
    expiresAt: Date.now() + 25 * 60 * 1000,
  };

  return {
    ...item.json,
    portalAccessStatus: "SESSION_REQUIRED",
    portalAccessReason: "MFA_SUCCEEDED_RETRY_WITH_SESSION",
    sessionCookies: body.cookies,
    manualReviewRequired: false,
  };
}

async function handleBrowserRequired(item) {
  const browserResponse = await callBrowserService("/render-and-collect-downloads", {
    url: item.json.finalUrl || item.json.sourceUrl,
    // Falls bereits eine (Session-)Cookie vorliegt, wird sie im Browser
    // gesetzt, statt sich erneut einzuloggen.
    cookies: item.json.sessionCookies || null,
  });
  const body = browserResponse.body || {};

  if (!body.documentUrls || !body.documentUrls.length) {
    return {
      ...item.json,
      portalAccessStatus: "MANUAL_REVIEW",
      portalAccessReason: `BROWSER_FOUND_NO_DOWNLOADS:${body.reason || "n/a"}`,
      manualReviewRequired: true,
    };
  }

  return {
    ...item.json,
    portalAccessStatus: "SESSION_REQUIRED", // Core lädt documentUrls mit den zurückgegebenen Cookies ganz normal herunter
    portalAccessReason: "BROWSER_RESOLVED_DOWNLOAD_URLS",
    documentUrls: body.documentUrls,
    sessionCookies: body.cookies || item.json.sessionCookies || null,
    manualReviewRequired: false,
  };
}

// ---- Entry point ----
const staticData = $getWorkflowStaticData("global");
const out = [];
for (const item of $input.all()) {
  if (item.json.mfaCodeFromUser) {
    out.push({ json: await continueMfa.call(this, item, staticData) });
  } else if (item.json.portalAccessStatus === "AUTH_REQUIRED") {
    out.push({ json: await handleAuthRequired.call(this, item, staticData) });
  } else if (item.json.portalAccessStatus === "BROWSER_REQUIRED") {
    out.push({ json: await handleBrowserRequired.call(this, item) });
  } else {
    out.push(item);
  }
}
return out;
