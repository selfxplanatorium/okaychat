import type * as Docx from "./docx.js";
import type * as Pdf from "./pdf.js";
import type * as Xlsx from "./xlsx.js";

// The engines pull in exceljs, pdf-lib, docx, xmldom, and linkedom, together about 100 MB of memory. Most
// processes never touch a document, so callers outside documents/ go through these loaders instead of
// importing the engines, and each library loads on its first use. Tool schemas live in schemas.ts.

const xlsx = () => import("./xlsx.js");
const docx = () => import("./docx.js");
const pdf = () => import("./pdf.js");

export const createXlsx = async (...args: Parameters<typeof Xlsx.createXlsx>) => (await xlsx()).createXlsx(...args);
export const editXlsx = async (...args: Parameters<typeof Xlsx.editXlsx>) => (await xlsx()).editXlsx(...args);
export const readXlsx = async (...args: Parameters<typeof Xlsx.readXlsx>) => (await xlsx()).readXlsx(...args);
export const previewXlsx = async (...args: Parameters<typeof Xlsx.previewXlsx>) => (await xlsx()).previewXlsx(...args);

export const createDocx = async (...args: Parameters<typeof Docx.createDocx>) => (await docx()).createDocx(...args);
export const editDocx = async (...args: Parameters<typeof Docx.editDocx>) => (await docx()).editDocx(...args);
export const readDocxText = async (...args: Parameters<typeof Docx.readDocxText>) => (await docx()).readDocxText(...args);

export const editPdf = async (...args: Parameters<typeof Pdf.editPdf>) => (await pdf()).editPdf(...args);
export const readPdf = async (...args: Parameters<typeof Pdf.readPdf>) => (await pdf()).readPdf(...args);
