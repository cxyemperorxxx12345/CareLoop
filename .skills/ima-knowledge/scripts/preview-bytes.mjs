// Runtime conversion only; never repairs a string decoded from binary.
export async function previewBytes(data) {
  let buffer;
  if (data instanceof Blob) buffer = await data.arrayBuffer();
  else if (data instanceof ArrayBuffer) buffer = data.slice(0);
  else if (ArrayBuffer.isView(data)) {
    buffer = new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice().buffer;
  } else throw new Error("Expected binary response; read the raw response again");
  if (!buffer.byteLength) throw new Error("Empty file response");
  return buffer;
}
export async function pdfBytes(data) {
  const buffer = await previewBytes(data);
  const header = new TextDecoder("ascii").decode(new Uint8Array(buffer, 0, Math.min(1024, buffer.byteLength)));
  if (!header.includes("%PDF-")) throw new Error("Response is not a PDF");
  return new Uint8Array(buffer.slice(0));
}
