import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { PDFDocument } from "pdf-lib";
import { importMediaPages, exportPages, mediaType } from "../src/media";
import { createPage } from "../src/models";

const mocks = vi.hoisted(() => ({ getDocument: vi.fn(), renderExport: vi.fn() }));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => ({ getDocument: mocks.getDocument, GlobalWorkerOptions: {} }));
vi.mock("pdfjs-dist/legacy/build/pdf.worker.min.mjs?url", () => ({ default: "/worker.mjs" }));
vi.mock("../src/canvas", () => ({ renderPageExport: mocks.renderExport }));
const notebookID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j1ZkAAAAASUVORK5CYII=";
const pdfFile = (): File => {
  const file = new File(["%PDF-test"], "Lesson.PDF", { type: "" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
  return file;
};

beforeEach(() => {
  vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue(`data:image/png;base64,${png}`);
});
afterEach(() => { vi.restoreAllMocks(); });

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
