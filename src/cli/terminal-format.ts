/** Render untrusted text without allowing control characters to affect the terminal. */
export function escapeTerminalControls(text: string): string {
  return text.replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/g, (character) => {
    if (character === "\u001b") return "␛";
    if (character === "\r") return "␍";
    if (character === "\t") return "⇥";
    if (character === "\u007f") return "␡";
    const code = character.charCodeAt(0);
    if (code <= 0x1f) return String.fromCharCode(0x2400 + code);
    return `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

export function wrapTerminalText(text: string, width: number, indent = "  "): string {
  const available = Math.max(20, width - indent.length);
  const points = Array.from(text);
  if (points.length <= available) return `${indent}${text}`;
  const lines: string[] = [];
  for (let offset = 0; offset < points.length; offset += available) {
    lines.push(`${indent}${points.slice(offset, offset + available).join("")}`);
  }
  return lines.join("\n");
}
