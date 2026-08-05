const BARE_TERMINAL_TOKEN = /^[A-Z][A-Z0-9_]*$/u;

export function extractTerminalToken(
  text: string | null | undefined,
): string | null {
  if (text === null || text === undefined) return null;
  const lines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line !== undefined && BARE_TERMINAL_TOKEN.test(line)) {
      return line;
    }
  }
  return null;
}
