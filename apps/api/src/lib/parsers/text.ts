export async function parseText(bytes: ArrayBuffer): Promise<string> {
  return new TextDecoder("utf-8").decode(bytes);
}
