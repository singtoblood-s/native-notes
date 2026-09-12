import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { importMediaPages, exportPages, mediaType, encodePageImage, imageCanvas } from "../src/media";
import { createPage, pageImageDataBytes } from "../src/models";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), renderExport: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: mocks.getDocument, GlobalWorkerOptions: {}, PDFDataRangeTransport: class { onDataRange = vi.fn(); } }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/worker.mjs" }));
vi.mock("../src/canvas", () => ({ renderPageExport: mocks.renderExport }));
const notebookID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ZkAAAAASUVORK5CYII=";
const pdfFile = (): File => {
  const file = new File(["%PDF-test"], "Lesson.PDF", { type: "" });
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: async () => new ArrayBuffer(8) });
  return file;
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(callback => callback(new Blob([Uint8Array.from(atob(png), char => char.charCodeAt(0))], { type: "image/png" })));
});
afterEach(() => { vi.restoreAllMocks(); });

it("does not silently discard additional pages during PNG export", async () => {
  await expect(exportPages([createPage(notebookID), createPage(notebookID)], "png", vi.fn(), new AbortController().signal)).rejects.toThrow("one page");
});

it("honors cancellation while the PNG renderer is loading", async () => {
  const controller = new AbortController();
  const canvas = document.createElement("canvas");
  mocks.renderExport.mockImplementationOnce(async () => { controller.abort(); return canvas; });
  await expect(exportPages([createPage(notebookID)], "png", vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(canvas.width).toBe(1);
});

it("imports every PDF page with schema version, original physical dimensions and stable append order", async () => {
  const destroy = vi.fn();
  const cleanup = vi.fn();
  mocks.getDocument.mockReturnValue({ destroy, promise: Promise.resolve({ numPages: 2, getPage: async (index: number) => ({
    getViewport: ({ scale }: { scale: number }) => ({ width: (index === 1 ? 600 : 800) * scale, height: (index === 1 ? 800 : 600) * scale }),
    render: () => ({ promise: Promise.resolve() }), cleanup,
  }) }) });
  const pages = await importMediaPages([pdfFile()], notebookID, 7, vi.fn(), new AbortController().signal);
  expect(pages.map(page => [page.order, page.width * .75, page.height * .75, page.formatVersion])).toEqual([[7, 600, 800, 2], [8, 800, 600, 2]]);
  expect(pages[0]!.images![0]).toMatchObject({ x: 0, y: 0, width: 800, height: 800 / .75 });
  expect(pages[0]!.strokes).toEqual([]);
  expect(cleanup).toHaveBeenCalledTimes(2);
  expect(destroy).toHaveBeenCalledTimes(1);
});

it("rejects excessive page counts and destroys the PDF worker on failure", async () => {
  const destroy = vi.fn();
  mocks.getDocument.mockReturnValue({ destroy, promise: Promise.resolve({ numPages: 101 }) });
  await expect(importMediaPages([pdfFile()], notebookID, 0, vi.fn(), new AbortController().signal)).rejects.toThrow("100");
  expect(destroy).toHaveBeenCalledTimes(1);
});

it("cancels before reading, and rejects unsupported input without saving partial pages", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(importMediaPages([pdfFile()], notebookID, 0, vi.fn(), controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  await expect(importMediaPages([new File(["bad"], "bad.svg", { type: "image/svg+xml" })], notebookID, 0, vi.fn(), new AbortController().signal)).rejects.toThrow("PNG");
  expect(mediaType(pdfFile())).toBe("application/pdf");
});

it("exports a reopenable multi-page PDF in order, with original page sizes", async () => {
  const pages = [createPage(notebookID), createPage(notebookID)];
  pages[0]!.width = 600 / .75; pages[0]!.height = 800 / .75;
  pages[1]!.width = 800 / .75; pages[1]!.height = 600 / .75;
  mocks.renderExport.mockImplementation(async () => ({ width: 1, height: 1, toBlob: (callback: (blob: unknown) => void) => callback({ arrayBuffer: async () => Uint8Array.from(atob(png), char => char.charCodeAt(0)).buffer }) }));
  const blob = await exportPages(pages, "pdf", vi.fn(), new AbortController().signal);
  const bytes = await new Promise<ArrayBuffer>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result as ArrayBuffer); reader.onerror = reject; reader.readAsArrayBuffer(blob); });
  const pdf = await PDFDocument.load(bytes);
  expect(pdf.getPages().map(page => [page.getWidth(), page.getHeight()])).toEqual([[600, 800], [800, 600]]);
});

it("stops export when an image cannot render instead of delivering missing content", async () => {
  mocks.renderExport.mockRejectedValue(new Error("A page image could not be loaded"));
  await expect(exportPages([createPage(notebookID)], "pdf", vi.fn(), new AbortController().signal)).rejects.toThrow("image could not be loaded");
});

it("reduces resolution when quality alone cannot meet the image budget, preserving source dimensions", async () => {
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation(function (this: HTMLCanvasElement, callback) {
    // Also exercise browsers that fall back to PNG for unsupported WebP.
    callback(new Blob([new Uint8Array(this.width > 1000 ? 150_000 : 30_000)], { type: "image/png" }));
  });
  const canvas = document.createElement("canvas"); canvas.width = 2000; canvas.height = 1500;
  const src = await encodePageImage(canvas, 64 * 1024);
  expect(pageImageDataBytes(src)).toBeLessThanOrEqual(64 * 1024);
  expect([canvas.width, canvas.height]).toEqual([2000, 1500]);
});

it("uses asynchronous photo compression within the default budget and reports encoder failures", async () => {
  const syncEncode = vi.spyOn(HTMLCanvasElement.prototype, "toDataURL");
  const encode = vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback, type) => {
    setTimeout(() => callback(new Blob([new Uint8Array(type === "image/webp" ? 200_000 : 900_000)], { type })), 0);
  });
  const canvas = document.createElement("canvas");
  const src = await encodePageImage(canvas);
  expect(src.startsWith("data:image/webp;base64,")).toBe(true);
  expect(pageImageDataBytes(src)).toBeLessThanOrEqual(512 * 1024);
  expect(encode).toHaveBeenCalledWith(expect.any(Function), "image/webp", .9);
  expect(syncEncode).not.toHaveBeenCalled();
  encode.mockImplementation(callback => callback(null));
  await expect(encodePageImage(canvas)).rejects.toThrow("Could not encode");
});

it("accepts PDFs above the former 50 MB ceiling without reading the entire file", async () => {
  const file = pdfFile();
  Object.defineProperty(file, "size", { value: 80 * 1024 * 1024 });
  const wholeRead = vi.spyOn(file, "arrayBuffer");
  const slice = vi.spyOn(file, "slice").mockReturnValue({ arrayBuffer: async () => new ArrayBuffer(16) } as Blob);
  mocks.getDocument.mockImplementation(options => {
    options.range.requestDataRange(1024, 1040);
    return { destroy: vi.fn(), promise: Promise.resolve({ numPages: 1, getPage: async () => ({
      getViewport: ({ scale }: { scale: number }) => ({ width: 600 * scale, height: 800 * scale }), render: () => ({ promise: Promise.resolve() }), cleanup: vi.fn(),
    }) }) };
  });
  const pages = await importMediaPages([file], notebookID, 0, vi.fn(), new AbortController().signal);
  expect(pages).toHaveLength(1);
  expect(wholeRead).not.toHaveBeenCalled();
  expect(slice).toHaveBeenCalledWith(1024, 1040);
});

it("rejects sources beyond the device memory guard before decoding", async () => {
  const file = pdfFile();
  Object.defineProperty(file, "size", { value: 251 * 1024 * 1024 });
  await expect(importMediaPages([file], notebookID, 0, vi.fn(), new AbortController().signal)).rejects.toThrow("250 MB");
  const picture = new File(["x"], "large.png", { type: "image/png" });
  Object.defineProperty(picture, "size", { value: 51 * 1024 * 1024 });
  await expect(imageCanvas(picture)).rejects.toThrow("50 MB");
});
