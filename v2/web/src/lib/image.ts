/**
 * Centre-crop a picture to w×h and shrink it in the browser, so the server stores
 * something small and never needs an image library.
 */
export async function cropToBlob(file: File, w: number, h: number): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.max(w / bmp.width, h / bmp.height);
  const sw = w / scale, sh = h / scale;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  canvas.getContext("2d")!.drawImage(bmp, (bmp.width - sw) / 2, (bmp.height - sh) / 2, sw, sh, 0, 0, w, h);
  return new Promise<Blob>((ok, bad) =>
    canvas.toBlob((b) => (b ? ok(b) : bad(new Error("Couldn't read that picture."))), "image/webp", 0.85),
  );
}

/** Shrink a photo to fit within `max` px on its longest side, keeping its shape. */
export async function shrinkToBlob(file: File, max: number): Promise<{ blob: Blob; width: number; height: number }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const width = Math.round(bmp.width * scale), height = Math.round(bmp.height * scale);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  canvas.getContext("2d")!.drawImage(bmp, 0, 0, width, height);
  const blob = await new Promise<Blob>((ok, bad) =>
    canvas.toBlob((b) => (b ? ok(b) : bad(new Error("Couldn't read that picture."))), "image/webp", 0.85),
  );
  return { blob, width, height };
}
