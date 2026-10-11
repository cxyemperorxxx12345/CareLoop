// Deno Edge example; deploy this dependency together with the function.
// Baseline import from the working app; still cold-start test every deployment.
import { XMLParser, XMLValidator } from "npm:fast-xml-parser@4.5.0";
const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_",
  parseTagValue: false, parseAttributeValue: false, trimValues: false,
});
export function parseOfficeXml(xml: string) {
  if (xml.length > 8_000_000) throw new Error("XML size limit exceeded");
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error("DTD/entities are not accepted");
  if (XMLValidator.validate(xml) !== true) throw new Error("Malformed XML");
  return parser.parse(xml); // Retains namespace prefixes; callers must use actual keys.
}
export function asArray<T>(value: T | T[] | undefined): T[] {
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}
