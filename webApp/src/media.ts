import { createPage, id, pageImageDataBytes, MAX_PAGE_IMAGE_BYTES, type NotePage } from "./models";
import { renderPageExport } from "./canvas";

export const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
export type MediaProgress = (message: string) => void;

export function mediaType(file: File): string {
  if (file.type && file.type !== "application/octet-stream") return file.type.toLowerCase() === "image/jpg" ? "image/jpeg" : file.type.toLowerCase();
  const extension = file.name.split(".").pop()?.toLowerCase();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", pdf: "application/pdf" } as Record<string, string>)[extension ?? ""] ?? "";
}

export function canvasBlob(canvas: HTMLCanvasElement, type = "image/png"): Promise<Blob> {
  return new Promise((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not encode this image.")), type));
}

export function encodePageImage(canvas: HTMLCanvasElement): string {
  let src = canvas.toDataURL("image/png");
  if ((pageImageDataBytes(src) ?? Infinity) > MAX_PAGE_IMAGE_BYTES) {
    for (const quality of [.9, .8, .65]) {
      src = canvas.toDataURL("image/webp", quality);
      if ((pageImageDataBytes(src) ?? Infinity) <= MAX_PAGE_IMAGE_BYTES) break;
    }
  }
  if ((pageImageDataBytes(src) ?? Infinity) > MAX_PAGE_IMAGE_BYTES) throw new Error("This page image is too large. Choose a smaller image.");
  return src;
}

export async function imageCanvas(file: File): Promise<HTMLCanvasElement> {
  if (!IMAGE_TYPES.has(mediaType(file))) throw new Error("Use PNG, JPEG, WebP or GIF images.");
  if (file.size > 12 * 1024 * 1024) throw new Error("Images must be 12 MB or smaller.");
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    await new Promise<void>((resolve, reject) => {
      image.onload = () => resolve();
      image.onerror = () => reject(new Error(`Could not open ${file.name}. The image may be damaged.`));
      image.src = url;
    });
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("Invalid image dimensions.");
    const scale = Math.min(1, 2000 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image rendering is unavailable.");
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas;
  } finally { URL.revokeObjectURL(url); }
}

/** Raster backgrounds use the existing synced image model; ink remains independently editable. */
export async function importMediaPages(files: File[], notebookID: string, firstOrder: number, progress: MediaProgress, signal: AbortSignal): Promise<NotePage[]> {
  if (!files.length || files.length > 100) throw new Error("Choose between 1 and 100 files.");
  const pages: NotePage[] = [];
  let bytes = 0;
  const append = (canvas: HTMLCanvasElement, title: string, dimensions?: { width: number; height: number }): void => {
    signal.throwIfAborted();
    if (pages.length >= 100) throw new Error("Import up to 100 pages at a time. Split this document first.");
    const src = encodePageImage(canvas);
    bytes += src.length;
    if (bytes > 38 * 1024 * 1024) throw new Error("Imported pages exceed 38 MB. Split this document first.");
    const page = createPage(notebookID, title.slice(0, 500));
    // Keep both dimensions within the existing page schema, including panoramic images.
    const ratio = canvas.width / canvas.height;
    if (ratio < .04 || ratio > 25) throw new Error("This page is too narrow or too wide.");
    const scale = Math.max(320 / canvas.width, 320 / canvas.height, Math.min(1, 1400 / Math.max(canvas.width, canvas.height)));
    page.width = dimensions?.width ?? Math.round(canvas.width * scale);
    page.height = dimensions?.height ?? Math.round(canvas.height * scale);
    if (Math.min(page.width, page.height) < 320 || Math.max(page.width, page.height) > 10_000) throw new Error("This page size is unsupported (240–7,500 PDF points per side).");
    page.order = firstOrder + pages.length;
    page.formatVersion = 2;
    page.images = [{ id: id(), src, x: 0, y: 0, width: page.width, height: page.height }];
    pages.push(page);
  };
  for (const file of files) {
    signal.throwIfAborted();
    progress(`Opening ${file.name}…`);
    const title = file.name.replace(/\.[^.]+$/, "") || "Imported page";
    if (mediaType(file) !== "application/pdf") {
      progress(`Opening ${file.name}…`);
      const canvas = await imageCanvas(file);
      try { append(canvas, title); } finally { canvas.width = canvas.height = 1; }
      continue;
    }
    if (file.size > 50 * 1024 * 1024) throw new Error("PDF files must be 50 MB or smaller.");
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const { default: worker } = await import("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url");
    pdfjs.GlobalWorkerOptions.workerSrc = worker;
    const base = `${import.meta.env.BASE_URL}pdfjs/`;
    const task = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), cMapUrl: `${base}cmaps/`, cMapPacked: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/` });
    const cancel = (): void => { void task.destroy(); };
    signal.addEventListener("abort", cancel, { once: true });
    task.onPassword = () => { void task.destroy(); };
    try {
      const pdf = await task.promise;
      if (pdf.numPages + pages.length > 100) throw new Error("Import up to 100 PDF pages at a time. Split this document first.");
      for (let index = 1; index <= pdf.numPages; index++) {
        signal.throwIfAborted();
        progress(`${file.name} · page ${index} of ${pdf.numPages}`);
        const page = await pdf.getPage(index);
        const natural = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: 2000 / Math.max(natural.width, natural.height) });
        const canvas = document.createElement("canvas");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        try {
          await page.render({ canvas, viewport }).promise;
          append(canvas, `${title} · ${index}`, { width: natural.width / .75, height: natural.height / .75 });
        } finally { page.cleanup(); canvas.width = canvas.height = 1; }
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    } catch (error) {
      if (signal.aborted) signal.throwIfAborted();
      throw new Error(`Could not import ${file.name}. ${error instanceof Error ? error.message : "Invalid PDF"} If it is password protected, save an unlocked copy first.`);
    } finally { signal.removeEventListener("abort", cancel); await task.destroy(); }
  }
  return pages;
}

export async function exportPages(pages: NotePage[], format: "pdf" | "png", progress: MediaProgress, signal: AbortSignal): Promise<Blob> {
  if (!pages.length) throw new Error("There are no pages to export.");
  if (format === "png") {
    signal.throwIfAborted();
    const canvas = await renderPageExport(pages[0]!);
    try { return await canvasBlob(canvas); } finally { canvas.width = canvas.height = 1; }
  }
  const { PDFDocument } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  for (const [index, page] of pages.entries()) {
    signal.throwIfAborted();
    progress(`Exporting page ${index + 1} of ${pages.length}…`);
    const canvas = await renderPageExport(page);
    try {
      const image = await pdf.embedPng(await (await canvasBlob(canvas)).arrayBuffer());
      const output = pdf.addPage([page.width * .75, page.height * .75]);
      output.drawImage(image, { x: 0, y: 0, width: output.getWidth(), height: output.getHeight() });
    } finally { canvas.width = canvas.height = 1; }
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  signal.throwIfAborted();
  return new Blob([new Uint8Array(await pdf.save())], { type: "application/pdf" });
}
