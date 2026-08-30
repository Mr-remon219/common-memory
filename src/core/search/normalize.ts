export function normalizeSearchText(value: string): string { return value.normalize("NFKC").toLocaleLowerCase("und").replace(/\s+/gu, " ").trim(); }
export function unicodeLength(value: string): number { return [...value].length; }
