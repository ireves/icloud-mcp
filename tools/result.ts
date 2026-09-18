/**
 * Every tool declares an output schema, so every successful result must carry
 * `structuredContent` matching it. The same value also goes out as JSON text
 * in `content`, for clients that do not read structured output.
 *
 * A result must be a JSON object, never a bare array or value, because that is
 * what the protocol allows a structured result to be. A tool whose natural
 * answer is a list wraps it in a named field.
 */
export function toResult(data: object) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
    structuredContent: data as Record<string, unknown>,
  };
}

/**
 * Error results carry no structured content and are not checked against the
 * output schema, so a refusal or failure still reaches the caller as plain
 * text whatever the tool normally returns.
 */
export function toErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}
