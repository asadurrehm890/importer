// Shared, dependency-free helpers used by BOTH the import UI (browser) and the
// import processing action (server). Keep this file free of any server-only or
// browser-only imports.

/**
 * The list of Shopify product fields a CSV column can be mapped to.
 * `value` is the internal field key used by the server; `label` is shown in the
 * mapping dropdown. `group` is used to visually group the options.
 */
export const SHOPIFY_FIELDS = [
  { value: "ignore", label: "— Do not import —", group: "" },

  { value: "title", label: "Title (required)", group: "Product" },
  { value: "descriptionHtml", label: "Description (HTML)", group: "Product" },
  { value: "vendor", label: "Vendor / Brand", group: "Product" },
  { value: "productType", label: "Product type", group: "Product" },
  { value: "handle", label: "Handle (URL slug)", group: "Product" },
  { value: "status", label: "Status (active / draft)", group: "Product" },
  { value: "tags", label: "Tags (split by | )", group: "Product" },
  {
    value: "collections",
    label: "Collections (category path, > separated)",
    group: "Product",
  },
  {
    value: "images",
    label: "Images (external URL → Shopify)",
    group: "Product",
  },

  { value: "price", label: "Price", group: "Variant" },
  { value: "compareAtPrice", label: "Compare-at price", group: "Variant" },
  { value: "sku", label: "SKU — match key", group: "Variant" },
  { value: "barcode", label: "Barcode (EAN / UPC)", group: "Variant" },
  {
    value: "inventoryQuantity",
    label: "Inventory quantity (available)",
    group: "Variant",
  },
];

export const FIELD_VALUES = new Set(SHOPIFY_FIELDS.map((f) => f.value));

// Field that uniquely identifies a product for create-vs-update matching.
export const MATCH_FIELD = "sku";

// A column can also be mapped to a product metafield. Such a mapping is encoded
// as a single field value string so it round-trips through the same mapping
// object as the built-in fields: "metafield:<namespace>:<key>:<type>".
// (Shopify namespaces/keys/type names never contain ":", so it's unambiguous.)
export const METAFIELD_PREFIX = "metafield:";

/** Encode a metafield definition into a dropdown option value. */
export function metafieldFieldValue(def) {
  return `${METAFIELD_PREFIX}${def.namespace}:${def.key}:${def.type}`;
}

/** Decode a "metafield:ns:key:type" value, or null if not a metafield value. */
export function parseMetafieldField(fieldValue) {
  if (typeof fieldValue !== "string" || !fieldValue.startsWith(METAFIELD_PREFIX))
    return null;
  const [namespace, key, type] = fieldValue
    .slice(METAFIELD_PREFIX.length)
    .split(":");
  if (!namespace || !key) return null;
  return { namespace, key, type: type || "single_line_text_field" };
}

/** Collect every metafield mapping for a row as `{ namespace, key, type, value }`. */
export function metafieldsForRow(mapping, row) {
  const out = [];
  for (const [header, field] of Object.entries(mapping)) {
    const def = parseMetafieldField(field);
    if (!def) continue;
    const value = row[header];
    if (value == null || String(value).trim() === "") continue;
    out.push({ ...def, value: String(value) });
  }
  return out;
}

/** Remove a leading UTF-8 BOM (U+FEFF) that often sticks to the first header. */
export function stripBom(value) {
  if (typeof value !== "string") return value;
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value;
}

/**
 * Best-effort automatic mapping of CSV headers to Shopify fields based on the
 * header name. Anything we don't recognise is left as "ignore".
 */
export function guessMapping(headers) {
  const mapping = {};
  for (const rawHeader of headers) {
    const header = stripBom(rawHeader || "").trim();
    const key = header.toLowerCase();
    let field = "ignore";

    if (key === "title" || key === "name") field = "title";
    else if (key === "description" || key === "body" || key === "body_html")
      field = "descriptionHtml";
    else if (key === "brand" || key === "vendor" || key === "manufacturer")
      field = "vendor";
    else if (key === "price") field = "price";
    else if (key.includes("compare")) field = "compareAtPrice";
    else if (key === "article_number" || key === "sku" || key === "mpn")
      field = "sku";
    else if (key === "ean" || key === "barcode" || key === "upc" || key === "gtin")
      field = "barcode";
    else if (key === "categories" || key === "category" || key === "collection")
      field = "collections";
    else if (key === "images" || key === "image" || key === "image_url")
      field = "images";
    else if (
      key === "inventory" ||
      key === "quantity" ||
      key === "qty" ||
      key === "stock" ||
      key === "inventory_quantity" ||
      key === "stock_quantity"
    )
      field = "inventoryQuantity";
    else if (key === "tab_tags" || key === "tags") field = "tags";
    else if (key === "status") field = "status";
    else if (key === "handle" || key === "slug") field = "handle";
    else if (key === "product_type" || key === "type") field = "productType";

    mapping[header] = field;
  }
  return mapping;
}

/**
 * Parse a localized price string into a "0.00" numeric string.
 * Handles "€43,40", "€35.87", "1.234,56", "1,234.56", "43,40", etc.
 * Returns null when no number can be parsed.
 */
export function parsePrice(raw) {
  if (raw == null) return null;
  let s = String(raw).replace(/[^\d.,-]/g, "").trim();
  if (!s) return null;

  const hasComma = s.includes(",");
  const hasDot = s.includes(".");

  if (hasComma && hasDot) {
    // Whichever separator comes last is the decimal separator.
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
  } else if (hasComma) {
    // Single comma → treat as decimal separator (European style).
    s = s.replace(/\./g, "").replace(",", ".");
  }

  const num = parseFloat(s);
  if (Number.isNaN(num)) return null;
  return num.toFixed(2);
}

/**
 * Parse an inventory quantity cell into a whole number.
 * Strips currency/grouping characters ("1,250" → 1250). Returns null when no
 * integer can be parsed so the variant's inventory is left untouched.
 */
export function parseQuantity(raw) {
  if (raw == null) return null;
  const s = String(raw).replace(/[^\d-]/g, "").trim();
  if (!s || s === "-") return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

/** Split "Accu | Akku | Battery" into ["Accu","Akku","Battery"] (deduped). */
export function splitTags(raw, separator = "|") {
  if (!raw) return [];
  const seen = new Set();
  const out = [];
  for (const part of String(raw).split(separator)) {
    const tag = part.trim();
    if (tag && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out;
}

/**
 * Split a category path into the collections it should belong to.
 * "Samsung > Galaxy A > Galaxy A22 5G" → ["Samsung", "Galaxy A"]
 * The LAST segment is intentionally dropped (it's the leaf product family).
 */
export function splitCategories(raw) {
  if (!raw) return [];
  const segments = String(raw)
    .split(">")
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length <= 1) return [];
  return segments.slice(0, -1);
}

/** Extract one or more image URLs from a cell. */
export function splitImages(raw) {
  if (!raw) return [];
  const matches = String(raw).match(/https?:\/\/[^\s,'"]+/g);
  if (!matches) return [];
  // dedupe, preserve order
  const seen = new Set();
  return matches.filter((u) => (seen.has(u) ? false : (seen.add(u), true)));
}

/** Normalize a free-form status cell into a Shopify ProductStatus enum value. */
export function parseStatus(raw, fallback = "ACTIVE") {
  if (!raw) return fallback;
  const v = String(raw).trim().toLowerCase();
  if (v.startsWith("draft") || v === "0" || v === "false") return "DRAFT";
  if (v.startsWith("arch")) return "ARCHIVED";
  if (v.startsWith("active") || v === "1" || v === "true") return "ACTIVE";
  return fallback;
}

/**
 * Build a `{ fieldKey: cellValue }` object for one CSV row given the
 * header→field mapping. Later columns win if two map to the same field.
 */
export function fieldsForRow(mapping, row) {
  const out = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (!field || field === "ignore") continue;
    const value = row[header];
    if (value != null && String(value).trim() !== "") out[field] = value;
  }
  return out;
}
