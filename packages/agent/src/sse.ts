// Server-sent events from a fetch body: the two providers stream their replies this way. Reads the byte stream with
// a reader (async iteration of streams is missing in Safari), decodes UTF-8 across chunk boundaries and yields one
// event per blank line, as the SSE format defines.

export interface SseEvent {
  data: string;
  event: string | null;
}

function parseBlock(block: string): SseEvent | null {
  let event: string | null = null;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line === "" || line.startsWith(":")) {
      continue;
    }
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }
    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }
  return data.length > 0 || event !== null
    ? { data: data.join("\n"), event }
    : null;
}

export async function* readSse(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      // biome-ignore lint/performance/noAwaitInLoops: a stream is read in order, one chunk at a time
      const { done, value } = await reader.read();
      buffer += done
        ? decoder.decode()
        : decoder.decode(value, { stream: true });
      // a lone \r at the end may be half of \r\n: keep it for the next chunk
      const hold = !done && buffer.endsWith("\r") ? "\r" : "";
      buffer = (hold ? buffer.slice(0, -1) : buffer).replace(/\r\n?/g, "\n");
      for (
        let at = buffer.indexOf("\n\n");
        at >= 0;
        at = buffer.indexOf("\n\n")
      ) {
        const parsed = parseBlock(buffer.slice(0, at));
        buffer = buffer.slice(at + 2);
        if (parsed) {
          yield parsed;
        }
      }
      buffer += hold;
      if (done) {
        break;
      }
    }
    const last = parseBlock(buffer);
    if (last) {
      yield last;
    }
  } finally {
    reader.cancel().catch(() => undefined);
  }
}
