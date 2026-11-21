export function safeErrorDetails(error: unknown) {
  const e = error as { status?: unknown; response?: { status?: unknown }; name?: unknown; message?: unknown; code?: unknown; cause?: { code?: unknown } } | null;
  const message = typeof e?.message === "string" ? e.message : "";
  const match = message.match(/^(?:Apple Music GET failed: |MusicBrainz |Spotify token failed: |Spotify GET failed: )([1-5][0-9]{2})(?:\s|:|$)/);
  const status = e?.status ?? e?.response?.status ?? (match ? Number(match[1]) : undefined);
  const code = e?.code ?? e?.cause?.code;
  return {
    category: e?.name === "AbortError" || e?.name === "TimeoutError" ? "timeout_or_abort" : "operation_failed",
    status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined,
    code: typeof code === "string" && /^(ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|UND_ERR_CONNECT_TIMEOUT|P[0-9]{4})$/.test(code) ? code : undefined,
  };
}
