// Server-only logic that turns mapped CSV rows into Shopify products.
//
// For every row we:
//   1. Resolve the mapped field values.
//   2. Look up an existing product by variant SKU (the match key).
//   3. productSet (create or update) with title/description/tags/variant/images.
//   4. Find-or-create each category collection and add the product to it.
//
// All GraphQL operations in this file were validated against the 2025-10 Admin
// API schema with the Shopify dev MCP validator.

import {
  encodeMetafieldValue,
  fieldsForRow,
  metafieldsForRow,
  parsePrice,
  parseQuantity,
  parseStatus,
  splitCategories,
  splitImages,
  splitTags,
} from "./import-fields";

const FIND_VARIANT_BY_SKU = `#graphql
  query FindVariantBySku($q: String!) {
    productVariants(first: 1, query: $q) {
      edges { node { id sku product { id } } }
    }
  }`;

const PRODUCT_SET = `#graphql
  mutation ImportProductSet($input: ProductSetInput!) {
    productSet(input: $input, synchronous: true) {
      product { id title handle status }
      userErrors { field message code }
    }
  }`;

const PRIMARY_LOCATION = `#graphql
  query PrimaryLocation {
    locations(first: 1, query: "status:active") {
      edges { node { id } }
    }
  }`;

const FIND_COLLECTION = `#graphql
  query FindCollection($q: String!) {
    collections(first: 10, query: $q) {
      edges { node { id title } }
    }
  }`;

const CREATE_COLLECTION = `#graphql
  mutation MakeCollection($input: CollectionInput!) {
    collectionCreate(input: $input) {
      collection { id title }
      userErrors { field message }
    }
  }`;

const ADD_TO_COLLECTION = `#graphql
  mutation AddToCollection($id: ID!, $productIds: [ID!]!) {
    collectionAddProducts(id: $id, productIds: $productIds) {
      collection { id }
      userErrors { field message }
    }
  }`;

// metafieldsSet upserts by (ownerId, namespace, key) and leaves other
// metafields untouched — safer than productSet's list-field reconcile.
const SET_METAFIELDS = `#graphql
  mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { id namespace key }
      userErrors { field message code }
    }
  }`;

// In-memory collection cache (title → collection GID), per shop, shared across
// requests in the same server process. Avoids re-querying/creating the same
// collection for every product in a large import.
const collectionCaches = new Map();
function collectionCacheFor(shop) {
  let cache = collectionCaches.get(shop);
  if (!cache) {
    cache = new Map();
    collectionCaches.set(shop, cache);
  }
  return cache;
}

// In-memory primary-location cache (shop → location GID). Inventory quantities
// must be set against a location; we use the store's first active one.
const locationCaches = new Map();

// Escape single quotes for use inside a Shopify search query string.
function esc(value) {
  return String(value).replace(/'/g, "");
}

async function gql(admin, query, variables) {
  const response = await admin.graphql(query, { variables });
  const body = await response.json();
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }
  return body.data;
}

/** Find an existing product GID by its variant SKU. Returns null if none. */
async function findProductIdBySku(admin, sku) {
  if (!sku) return null;
  const data = await gql(admin, FIND_VARIANT_BY_SKU, {
    q: `sku:'${esc(sku)}'`,
  });
  const node = data?.productVariants?.edges?.[0]?.node;
  return node?.product?.id ?? null;
}

/** Resolve the store's primary (first active) location GID, cached per shop. */
async function primaryLocationId(admin, shop) {
  if (locationCaches.has(shop)) return locationCaches.get(shop);
  let id = null;
  try {
    const data = await gql(admin, PRIMARY_LOCATION);
    id = data?.locations?.edges?.[0]?.node?.id ?? null;
  } catch {
    id = null;
  }
  locationCaches.set(shop, id);
  return id;
}

/** Find-or-create a custom collection by title, using the per-shop cache. */
async function ensureCollection(admin, shop, title) {
  const cache = collectionCacheFor(shop);
  const key = title.toLowerCase();
  if (cache.has(key)) return cache.get(key);

  const data = await gql(admin, FIND_COLLECTION, {
    q: `title:'${esc(title)}'`,
  });
  const match = data?.collections?.edges?.find(
    (e) => e.node.title.toLowerCase() === key,
  );
  let id = match?.node?.id ?? null;

  if (!id) {
    const created = await gql(admin, CREATE_COLLECTION, {
      input: { title },
    });
    const errors = created?.collectionCreate?.userErrors ?? [];
    if (errors.length) {
      throw new Error(
        `collection "${title}": ${errors.map((e) => e.message).join(", ")}`,
      );
    }
    id = created.collectionCreate.collection.id;
  }

  cache.set(key, id);
  return id;
}

/** Build the ProductSetInput from a row's mapped field values. */
function buildProductInput(fields, options, existingId) {
  const status = parseStatus(fields.status, options.defaultStatus || "ACTIVE");

  const variant = {
    optionValues: [{ optionName: "Title", name: "Default Title" }],
  };
  if (fields.sku) variant.sku = String(fields.sku).trim();
  if (fields.barcode) variant.barcode = String(fields.barcode).trim();
  const price = parsePrice(fields.price);
  if (price != null) variant.price = price;
  const compareAt = parsePrice(fields.compareAtPrice);
  if (compareAt != null) variant.compareAtPrice = compareAt;

  // Inventory: only set when a quantity is mapped AND we resolved a location.
  // Setting a quantity requires the item to be tracked. On updates Shopify only
  // accepts quantities at locations where the variant is already stocked.
  const quantity = parseQuantity(fields.inventoryQuantity);
  if (quantity != null && options.locationId) {
    variant.inventoryItem = { tracked: true };
    variant.inventoryQuantities = [
      { locationId: options.locationId, name: "available", quantity },
    ];
  }

  const input = {
    status,
    productOptions: [{ name: "Title", values: [{ name: "Default Title" }] }],
    variants: [variant],
  };

  if (existingId) input.id = existingId;
  if (fields.title) input.title = String(fields.title).trim();
  if (fields.descriptionHtml) input.descriptionHtml = String(fields.descriptionHtml);
  if (fields.vendor) input.vendor = String(fields.vendor).trim();
  if (fields.productType) input.productType = String(fields.productType).trim();
  if (fields.handle) input.handle = String(fields.handle).trim();

  const tags = splitTags(fields.tags);
  if (tags.length) input.tags = tags;

  // Only ingest images when creating, or when the user opts to re-import on
  // update. productSet treats `files` as a list field, so re-sending the same
  // URLs on every update would create duplicate media otherwise. Shopify
  // downloads each URL, re-hosts it on its CDN, and serves it as WebP/AVIF.
  if (fields.images && (!existingId || options.overwriteImages)) {
    const images = splitImages(fields.images);
    if (images.length) {
      input.files = images.map((url) => ({
        originalSource: url,
        contentType: "IMAGE",
        alt: input.title || undefined,
      }));
    }
  }

  return input;
}

/** Process a single mapped CSV row. Never throws — returns a result record. */
async function processRow(admin, shop, mapping, row, options, rowIndex) {
  const fields = fieldsForRow(mapping, row);
  const sku = fields.sku ? String(fields.sku).trim() : "";
  const title = fields.title ? String(fields.title).trim() : "";
  const result = {
    rowIndex,
    sku,
    title,
    action: "failed",
    productId: null,
    collections: [],
    metafields: 0,
    errors: [],
  };

  try {
    const existingId = await findProductIdBySku(admin, sku);
    if (!existingId && !title) {
      result.errors.push("No existing product matched and no title to create one.");
      return result;
    }

    const input = buildProductInput(fields, options, existingId);
    const data = await gql(admin, PRODUCT_SET, { input });
    const userErrors = data?.productSet?.userErrors ?? [];
    if (userErrors.length) {
      result.errors.push(...userErrors.map((e) => e.message));
      return result;
    }

    const product = data.productSet.product;
    result.productId = product.id;
    result.title = product.title || title;
    result.action = existingId ? "updated" : "created";

    // Metafields (additive upsert; never deletes other metafields).
    const metafields = metafieldsForRow(mapping, row);
    if (metafields.length) {
      try {
        const set = await gql(admin, SET_METAFIELDS, {
          metafields: metafields.map((m) => ({
            ownerId: product.id,
            namespace: m.namespace,
            key: m.key,
            type: m.type,
            value: encodeMetafieldValue(m.type, m.value),
          })),
        });
        const mfErrors = set?.metafieldsSet?.userErrors ?? [];
        if (mfErrors.length) {
          result.errors.push(
            ...mfErrors.map((e) => `metafield: ${e.message}`),
          );
        } else {
          result.metafields = metafields.length;
        }
      } catch (e) {
        result.errors.push(`metafields: ${e.message}`);
      }
    }

    // Categories → collections (additive; safe to repeat on re-import).
    const categoryNames = splitCategories(fields.collections);
    for (const name of categoryNames) {
      try {
        const collectionId = await ensureCollection(admin, shop, name);
        const add = await gql(admin, ADD_TO_COLLECTION, {
          id: collectionId,
          productIds: [product.id],
        });
        const addErrors = add?.collectionAddProducts?.userErrors ?? [];
        if (addErrors.length) {
          result.errors.push(
            `collection "${name}": ${addErrors.map((e) => e.message).join(", ")}`,
          );
        } else {
          result.collections.push(name);
        }
      } catch (e) {
        result.errors.push(`collection "${name}": ${e.message}`);
      }
    }
  } catch (e) {
    result.errors.push(e.message || String(e));
  }

  return result;
}

/**
 * Process a batch of rows sequentially. `rows` is an array of `{ index, data }`.
 * Returns an array of per-row result records.
 */
export async function runImportBatch(admin, shop, mapping, rows, options = {}) {
  // Resolve the location once per batch, but only if a column maps to inventory.
  const needsInventory = Object.values(mapping).includes("inventoryQuantity");
  const locationId = needsInventory
    ? await primaryLocationId(admin, shop)
    : null;
  const opts = { ...options, locationId };

  const results = [];
  for (const row of rows) {
    results.push(
      await processRow(admin, shop, mapping, row.data, opts, row.index),
    );
  }
  return results;
}
