// Encoding helpers for the CLI's input and output. Windows shells re-encode text
// they pass to and read from native programs (PowerShell 5.1: ASCII/ANSI code page),
// so the CLI reads input files itself and keeps piped output ASCII-only.

/** Decode file/stdin bytes: UTF-16 with a BOM (PowerShell's Out-File), else UTF-8 (BOM dropped). */
export function decodeText(bytes: Uint8Array): string {
    if (bytes[0] === 0xff && bytes[1] === 0xfe) { return new TextDecoder('utf-16le').decode(bytes); }
    if (bytes[0] === 0xfe && bytes[1] === 0xff) { return new TextDecoder('utf-16be').decode(bytes); }
    return new TextDecoder('utf-8').decode(bytes);
}

/** Write every non-ASCII UTF-16 unit as \uXXXX, so any console code page reads it intact. */
export function asciiSafe(text: string): string {
    return text.replace(/[\u0080-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
