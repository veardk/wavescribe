import { XMLParser } from "fast-xml-parser";

const ALWAYS_ARRAY = new Set(["item", "entry", "enclosure", "podcast:transcript", "p", "span", "link"]);

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  textNodeName: "#text",
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: true,
  htmlEntities: true,
  isArray: (name) => ALWAYS_ARRAY.has(name),
});

export const parseXml = (xml: string): any => parser.parse(xml);

/** Text content of a parsed node (string, {#text}, or nested). */
export function textOf(node: unknown): string {
  if (node == null) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object") {
    const o = node as Record<string, unknown>;
    if ("#text" in o) return String(o["#text"]);
  }
  return "";
}

export const attr = (node: unknown, name: string): string | undefined =>
  node && typeof node === "object" ? ((node as Record<string, unknown>)[`@${name}`] as string | undefined) : undefined;
