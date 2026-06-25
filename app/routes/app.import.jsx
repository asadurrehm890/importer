import { useCallback, useMemo, useRef, useState } from "react";
import Papa from "papaparse";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useAppBridge } from "@shopify/app-bridge-react";
import { authenticate } from "../shopify.server";
import {
  SHOPIFY_FIELDS,
  guessMapping,
  metafieldFieldValue,
  splitCategories,
  splitImages,
  splitTags,
  stripBom,
} from "../lib/import-fields";

const PRODUCT_METAFIELD_DEFS = `#graphql
  query ProductMetafieldDefs {
    metafieldDefinitions(first: 100, ownerType: PRODUCT) {
      edges { node { name namespace key type { name } } }
    }
  }`;

export const loader = async ({ request }) => {
  const { admin } = await authenticate.admin(request);

  let metafieldDefs = [];
  try {
    const response = await admin.graphql(PRODUCT_METAFIELD_DEFS);
    const json = await response.json();
    metafieldDefs = (json.data?.metafieldDefinitions?.edges || []).map(
      ({ node }) => ({
        name: node.name,
        namespace: node.namespace,
        key: node.key,
        type: node.type.name,
      }),
    );
  } catch {
    metafieldDefs = [];
  }

  return { metafieldDefs };
};

const STATUS_OPTIONS = [
  { value: "ACTIVE", label: "Active" },
  { value: "DRAFT", label: "Draft" },
];

// Group the field options for the mapping dropdowns.
const FIELD_GROUPS = ["Product", "Variant"];

function chunk(array, size) {
  const out = [];
  for (let i = 0; i < array.length; i += size) out.push(array.slice(i, i + size));
  return out;
}

export default function ImportPage() {
  const shopify = useAppBridge();
  const { metafieldDefs } = useLoaderData();
  const fileInputRef = useRef(null);

  // Dropdown options for each product metafield definition in the store.
  const metafieldOptions = useMemo(
    () =>
      metafieldDefs.map((def) => ({
        value: metafieldFieldValue(def),
        label: `${def.name} (${def.namespace}.${def.key})`,
      })),
    [metafieldDefs],
  );

  const [fileName, setFileName] = useState("");
  const [headers, setHeaders] = useState([]);
  const [rows, setRows] = useState([]);
  const [mapping, setMapping] = useState({});
  const [parseError, setParseError] = useState("");

  const [status, setStatus] = useState("ACTIVE");
  const [overwriteImages, setOverwriteImages] = useState(false);
  const [batchSize, setBatchSize] = useState(5);
  const [limit, setLimit] = useState("");

  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState([]);

  const totals = useMemo(() => {
    const t = { created: 0, updated: 0, failed: 0 };
    for (const r of results) {
      if (r.action === "created") t.created++;
      else if (r.action === "updated") t.updated++;
      else t.failed++;
    }
    return t;
  }, [results]);

  const onFileChange = useCallback((event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setParseError("");
    setResults([]);
    setProgress(0);
    setFileName(file.name);

    Papa.parse(file, {
      header: true,
      skipEmptyLines: "greedy",
      transformHeader: (h) => stripBom(h).trim(),
      complete: (parsed) => {
        const cleanHeaders = (parsed.meta.fields || []).filter(Boolean);
        if (!cleanHeaders.length) {
          setParseError("No columns found in this CSV.");
          return;
        }
        setHeaders(cleanHeaders);
        setRows(parsed.data || []);
        setMapping(guessMapping(cleanHeaders));
      },
      error: (err) => setParseError(err.message || "Failed to parse CSV."),
    });
  }, []);

  const setFieldFor = useCallback((header, field) => {
    setMapping((prev) => ({ ...prev, [header]: field }));
  }, []);

  // Which CSV header is currently mapped to a given field key (if any).
  const headerForField = useCallback(
    (field) => headers.find((h) => mapping[h] === field) || null,
    [headers, mapping],
  );

  const runImport = useCallback(async () => {
    if (!rows.length) return;
    setRunning(true);
    setResults([]);
    setProgress(0);

    // Optional row limit: blank/0 imports everything, otherwise the first N.
    const limitN = Number(limit);
    const selectedRows =
      Number.isFinite(limitN) && limitN > 0 ? rows.slice(0, limitN) : rows;

    const indexedRows = selectedRows.map((data, index) => ({ index, data }));
    const batches = chunk(indexedRows, Math.max(1, Number(batchSize) || 5));
    const options = { defaultStatus: status, overwriteImages };
    const collected = [];
    let processed = 0;

    for (const batch of batches) {
      try {
        const response = await fetch("/app/import/process", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ mapping, rows: batch, options }),
        });
        const body = await response.json();
        if (!response.ok || body.error) {
          for (const row of batch) {
            collected.push({
              rowIndex: row.index,
              title: row.data[headerForField("title")] || "",
              sku: row.data[headerForField("sku")] || "",
              action: "failed",
              errors: [body.error || `HTTP ${response.status}`],
              collections: [],
            });
          }
        } else {
          collected.push(...body.results);
        }
      } catch (e) {
        for (const row of batch) {
          collected.push({
            rowIndex: row.index,
            title: "",
            sku: "",
            action: "failed",
            errors: [e.message || "Request failed"],
            collections: [],
          });
        }
      }
      processed += batch.length;
      setProgress(Math.round((processed / indexedRows.length) * 100));
      setResults([...collected]);
    }

    setRunning(false);
    const failed = collected.filter((r) => r.action === "failed").length;
    shopify.toast.show(
      failed
        ? `Import finished with ${failed} error(s).`
        : "Import finished successfully.",
      failed ? { isError: true } : undefined,
    );
  }, [rows, batchSize, limit, status, overwriteImages, mapping, headerForField, shopify]);

  const titleMapped = Boolean(headerForField("title"));
  const skuMapped = Boolean(headerForField("sku"));
  const canRun = rows.length > 0 && titleMapped && !running;

  // How many rows the current limit will actually import.
  const importCount = useMemo(() => {
    const n = Number(limit);
    return Number.isFinite(n) && n > 0 ? Math.min(n, rows.length) : rows.length;
  }, [limit, rows.length]);

  // ---- Live preview of how a few rows will be interpreted ----
  const preview = useMemo(() => {
    if (!rows.length) return [];
    const tagsHeader = headerForField("tags");
    const catHeader = headerForField("collections");
    const imgHeader = headerForField("images");
    const titleHeader = headerForField("title");
    return rows.slice(0, 3).map((row) => ({
      title: titleHeader ? row[titleHeader] : "",
      tags: tagsHeader ? splitTags(row[tagsHeader]) : [],
      collections: catHeader ? splitCategories(row[catHeader]) : [],
      images: imgHeader ? splitImages(row[imgHeader]).length : 0,
    }));
  }, [rows, headerForField]);

  return (
    <s-page heading="Import products from CSV">
      <s-button
        slot="primary-action"
        variant="primary"
        onClick={runImport}
        {...(canRun ? {} : { disabled: true })}
        {...(running ? { loading: true } : {})}
      >
        Start import
      </s-button>

      {/* Step 1 — upload */}
      <s-section heading="1. Upload CSV">
        <s-stack direction="block" gap="base">
          <s-paragraph>
            Upload a product CSV (for example <s-text type="strong">products1-50.csv</s-text>).
            Parsing happens in your browser; nothing is sent to Shopify until you
            press <s-text type="strong">Start import</s-text>.
          </s-paragraph>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            onChange={onFileChange}
            style={{ display: "none" }}
          />
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-button onClick={() => fileInputRef.current?.click()}>
              Choose CSV file
            </s-button>
            {fileName ? (
              <s-text>
                {fileName} — {rows.length} row{rows.length === 1 ? "" : "s"}
              </s-text>
            ) : (
              <s-text color="subdued">No file selected</s-text>
            )}
          </s-stack>
          {parseError ? (
            <s-banner tone="critical" heading="Could not read CSV">
              {parseError}
            </s-banner>
          ) : null}
        </s-stack>
      </s-section>

      {/* Step 2 — mapping */}
      {headers.length ? (
        <s-section heading="2. Map columns to Shopify fields">
          <s-stack direction="block" gap="base">
            {!titleMapped ? (
              <s-banner tone="warning" heading="Title is required">
                Map one column to <s-text type="strong">Title</s-text> before importing.
              </s-banner>
            ) : null}
            {!skuMapped ? (
              <s-banner tone="info" heading="No SKU mapped">
                Without a SKU column, every row is created as a new product
                (existing products can&apos;t be matched for update).
              </s-banner>
            ) : null}

            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">CSV column</s-table-header>
                <s-table-header>Sample value</s-table-header>
                <s-table-header>Maps to</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {headers.map((header) => {
                  const sample = rows[0]?.[header] ?? "";
                  const sampleText =
                    String(sample).length > 60
                      ? String(sample).slice(0, 60) + "…"
                      : String(sample);
                  return (
                    <s-table-row key={header}>
                      <s-table-cell>
                        <s-text type="strong">{header}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-text color="subdued">{sampleText}</s-text>
                      </s-table-cell>
                      <s-table-cell>
                        <s-select
                          label="Maps to"
                          labelAccessibilityVisibility="exclusive"
                          value={mapping[header] || "ignore"}
                          onChange={(e) => setFieldFor(header, e.target.value)}
                        >
                          {SHOPIFY_FIELDS.filter((f) => f.value === "ignore").map(
                            (f) => (
                              <s-option key={f.value} value={f.value}>
                                {f.label}
                              </s-option>
                            ),
                          )}
                          {FIELD_GROUPS.map((group) =>
                            SHOPIFY_FIELDS.filter((f) => f.group === group).map(
                              (f) => (
                                <s-option key={f.value} value={f.value}>
                                  {group} · {f.label}
                                </s-option>
                              ),
                            ),
                          )}
                          {metafieldOptions.map((o) => (
                            <s-option key={o.value} value={o.value}>
                              Metafield · {o.label}
                            </s-option>
                          ))}
                        </s-select>
                      </s-table-cell>
                    </s-table-row>
                  );
                })}
              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      ) : null}

      {/* Step 3 — options + preview */}
      {headers.length ? (
        <s-section heading="3. Import options">
          <s-stack direction="block" gap="base">
            <s-select
              label="Default status (used when no Status column is mapped)"
              value={status}
              onChange={(e) => setStatus(e.target.value)}
            >
              {STATUS_OPTIONS.map((o) => (
                <s-option key={o.value} value={o.value}>
                  {o.label}
                </s-option>
              ))}
            </s-select>
            <s-switch
              label="Re-import images when updating existing products"
              {...(overwriteImages ? { checked: true } : {})}
              onChange={(e) => setOverwriteImages(e.target.checked)}
            />
            <s-number-field
              label="Products per batch"
              value={String(batchSize)}
              min={1}
              max={25}
              onChange={(e) => setBatchSize(e.target.value)}
            />
            <s-number-field
              label="Limit (number of rows to import — leave blank to import all)"
              placeholder="All"
              value={limit}
              min={1}
              onChange={(e) => setLimit(e.target.value)}
            />
            <s-text color="subdued">
              Will import {importCount} of {rows.length} row
              {rows.length === 1 ? "" : "s"}.
            </s-text>

            {preview.length ? (
              <s-box padding="base" background="subdued" borderRadius="base">
                <s-stack direction="block" gap="small-200">
                  <s-text type="strong">Preview (first {preview.length} rows)</s-text>
                  {preview.map((p, i) => (
                    <s-text key={i} color="subdued">
                      {p.title || "(no title)"} — {p.collections.length} collection(s)
                      {p.collections.length ? ` [${p.collections.join(", ")}]` : ""},{" "}
                      {p.tags.length} tag(s), {p.images} image(s)
                    </s-text>
                  ))}
                </s-stack>
              </s-box>
            ) : null}
          </s-stack>
        </s-section>
      ) : null}

      {/* Step 4 — progress + results */}
      {running || results.length ? (
        <s-section heading="4. Results">
          <s-stack direction="block" gap="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              {running ? <s-spinner size="base" accessibilityLabel="Importing" /> : null}
              <s-text type="strong">{progress}%</s-text>
              <s-badge tone="success">{totals.created} created</s-badge>
              <s-badge tone="info">{totals.updated} updated</s-badge>
              <s-badge tone={totals.failed ? "critical" : "neutral"}>
                {totals.failed} failed
              </s-badge>
            </s-stack>

            <s-table variant="auto">
              <s-table-header-row>
                <s-table-header listSlot="primary">Product</s-table-header>
                <s-table-header>SKU</s-table-header>
                <s-table-header>Result</s-table-header>
                <s-table-header>Details</s-table-header>
              </s-table-header-row>
              <s-table-body>
                {results.map((r) => (
                  <s-table-row key={r.rowIndex}>
                    <s-table-cell>{r.title || "(untitled)"}</s-table-cell>
                    <s-table-cell>{r.sku || "—"}</s-table-cell>
                    <s-table-cell>
                      <s-badge
                        tone={
                          r.action === "created"
                            ? "success"
                            : r.action === "updated"
                              ? "info"
                              : "critical"
                        }
                      >
                        {r.action}
                      </s-badge>
                    </s-table-cell>
                    <s-table-cell>
                      {r.errors?.length ? (
                        <s-text tone="critical">{r.errors.join("; ")}</s-text>
                      ) : (
                        <s-text color="subdued">
                          {[
                            r.collections?.length
                              ? `Collections: ${r.collections.join(", ")}`
                              : null,
                            r.metafields
                              ? `${r.metafields} metafield(s)`
                              : null,
                          ]
                            .filter(Boolean)
                            .join(" · ") || "OK"}
                        </s-text>
                      )}
                    </s-table-cell>
                  </s-table-row>
                ))}
              </s-table-body>
            </s-table>
          </s-stack>
        </s-section>
      ) : null}

      {/* Aside help 
      <s-section slot="aside" heading="How it works">
        <s-unordered-list>
          <s-list-item>Products are matched by <s-text type="strong">SKU</s-text> and updated, or created if new.</s-list-item>
          <s-list-item>Category paths like <s-text type="strong">A &gt; B &gt; C</s-text> add the product to collections <s-text type="strong">A</s-text> and <s-text type="strong">B</s-text> (the last segment is ignored). Missing collections are created.</s-list-item>
          <s-list-item>Tags are split on the <s-text type="strong">|</s-text> character.</s-list-item>
          <s-list-item>Image URLs are ingested by Shopify and re-hosted on its CDN.</s-list-item>
        </s-unordered-list>
      </s-section>*/}
    </s-page>
  );
}

export const headers = (headersArgs) => {
  return boundary.headers(headersArgs);
};
