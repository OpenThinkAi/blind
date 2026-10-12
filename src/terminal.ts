// Text bound for a terminal. File, folder and archive member names, masked
// values and reasons all come from the documents, so they can carry ANSI/OSC
// escape sequences, carriage returns or bidi overrides that would rewrite or
// hide lines of a report (a `leak` row, the status line). Every command's real
// stdout and stderr go through terminalStream, which escapes those characters
// as \uXXXX; a name printed inside a line also goes through oneLine, so an
// embedded newline cannot start a forged line. JSON output is unaffected: the
// characters escaped here are either already escaped by JSON.stringify or only
// ever occur inside a JSON string, where \uXXXX means the same character.

/** C0 controls but tab and newline, DEL, C1 controls, line/paragraph separators and bidi embeddings, overrides and isolates. */
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;
const UNSAFE_IN_LINE = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

const escape = (c: string): string => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`;

/** `s` with every character that can move the cursor or restyle the terminal escaped; tabs and newlines kept. */
export function terminalText(s: string): string {
  return s.replace(UNSAFE, escape);
}

/** `s` for use inside one line of output: as terminalText, and tabs and newlines escaped too. */
export function oneLine(s: string): string {
  return s.replace(UNSAFE_IN_LINE, escape);
}

/** `stream`, with every string written to it passed through terminalText. Everything else is the stream itself. */
export function terminalStream<T extends NodeJS.WritableStream>(stream: T): T {
  return new Proxy(stream, {
    get(target, prop) {
      if (prop === "write") {
        return (chunk: unknown, ...rest: unknown[]) =>
          (target.write as (...a: unknown[]) => boolean).call(target, typeof chunk === "string" ? terminalText(chunk) : chunk, ...rest);
      }
      const v = Reflect.get(target, prop, target);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
}
