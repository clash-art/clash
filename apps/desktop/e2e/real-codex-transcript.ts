export function textFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.text === "string") return event.text;
  if (event.content && typeof event.content === "object") {
    if (typeof event.content.text === "string") return event.content.text;
    if (Array.isArray(event.content)) {
      return event.content.map(textFromEvent).join("");
    }
  }
  if (Array.isArray(event.content)) return event.content.map(textFromEvent).join("");
  if (event.type === "promptComplete") return "";
  return "";
}

function terminalOutputFromEvent(event) {
  if (!event || typeof event !== "object") return "";
  if (typeof event.rawOutput === "string") return event.rawOutput;
  if (event.rawOutput && typeof event.rawOutput === "object") {
    for (const key of ["formatted_output", "stdout", "output", "text"]) {
      if (typeof event.rawOutput[key] === "string") return event.rawOutput[key];
    }
  }
  if (typeof event.output === "string") return event.output;
  const terminalData = event._meta?.terminal_output?.data;
  return typeof terminalData === "string" ? terminalData : "";
}

export function terminalOutputsFromEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map(terminalOutputFromEvent).filter(Boolean);
}

export function finalAnswerTextFromEvents(events) {
  if (!Array.isArray(events)) return "";
  const finalAnswerChunks = events
    .filter((event) => event?._meta?.codex?.phase === "final_answer")
    .map(textFromEvent)
    .filter(Boolean);
  if (finalAnswerChunks.length > 0) return finalAnswerChunks.join("");

  return events
    .filter((event) => event?.type === "text" && typeof event.text === "string")
    .map((event) => event.text)
    .join("");
}

export function isTransportDiagnosticText(text) {
  const normalized = String(text).trim();
  return /^Falling back from WebSockets to HTTPS transport\./i.test(normalized);
}

export function assistantTextFromEvents(events) {
  return events
    .map(textFromEvent)
    .filter((text) => text && !isTransportDiagnosticText(text))
    .join("");
}

export function diagnosticTextFromEvents(events) {
  return events
    .map(textFromEvent)
    .filter((text) => text && isTransportDiagnosticText(text))
    .join("\n");
}
