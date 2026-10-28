/** A whole-operation deadline includes response-body consumption. Abort never
 * proves that a remote provider stopped work or billing. No automatic replay. */
export async function withinRequestBudget<T>(
  task: (signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  const controller = new AbortController();
  let rejectAbort!: (reason: unknown) => void;
  const stopped = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const stop = (reason: unknown) => { controller.abort(reason); rejectAbort(reason); };
  const onAbort = () => stop(new DOMException("Request cancelled; remote completion is unknown", "AbortError"));
  const timer = setTimeout(() => stop(new DOMException("Request deadline exceeded; remote completion is unknown", "TimeoutError")), options.timeoutMs ?? 120_000);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (options.signal?.aborted) { onAbort(); return await stopped; }
    controller.signal.throwIfAborted();
    return await Promise.race([stopped, task(controller.signal)]);
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", onAbort);
  }
}

/** Real fetch responses are read with a byte cap before JSON parsing. Minimal
 * injected test adapters may expose only json(); their serialized value is
 * checked as well. This is a response-size bound, not a capacity benchmark. */
export async function boundedJson(response: any, signal: AbortSignal, limit = 1_048_576): Promise<any> {
  const reader = response.body?.getReader?.();
  if (!reader) {
    const value = await response.json(); signal.throwIfAborted();
    if (new TextEncoder().encode(JSON.stringify(value)).length > limit) throw new Error("Response output limit exceeded");
    return value;
  }
  let bytes = 0;
  const decoder = new TextDecoder(); let text = "";
  try {
    while (true) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > limit) throw new Error("Response output limit exceeded");
      text += decoder.decode(item.value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode());
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
