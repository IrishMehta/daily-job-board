import { SearchIndex } from "./search.js";

let index = null;

self.addEventListener("message", async (event) => {
  const message = event.data ?? {};
  if (message.type === "init") {
    try {
      const response = await fetch("./search-config.json");
      if (!response.ok) throw new Error(`Search configuration unavailable (${response.status}).`);
      index = new SearchIndex(message.documents ?? [], await response.json());
      self.postMessage({ type: "ready", documentCount: message.documents?.length ?? 0 });
    } catch (error) {
      self.postMessage({ type: "error", phase: "init", message: error?.message || "Search index failed to initialize." });
    }
    return;
  }
  if (message.type !== "query" || !index) return;
  try {
    const startedAt = performance.now();
    const result = index.search(message.query);
    self.postMessage({
      type: "results",
      requestId: message.requestId,
      elapsedMs: performance.now() - startedAt,
      ...result,
    });
  } catch (error) {
    self.postMessage({
      type: "error",
      phase: "query",
      requestId: message.requestId,
      message: error?.message || "Search query failed.",
    });
  }
});
