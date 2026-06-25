// Resource route: POST /app/import/process
// Receives one batch of mapped CSV rows as JSON and creates/updates the
// corresponding Shopify products. Called repeatedly by the import UI, one batch
// at a time, so that very large imports never run as a single long request.

import { authenticate } from "../shopify.server";
import { runImportBatch } from "../lib/import.server";

export const action = async ({ request }) => {
  const { admin, session } = await authenticate.admin(request);

  let payload;
  try {
    payload = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mapping, rows, options } = payload || {};
  if (!mapping || typeof mapping !== "object") {
    return Response.json({ error: "Missing column mapping" }, { status: 400 });
  }
  if (!Array.isArray(rows)) {
    return Response.json({ error: "Missing rows" }, { status: 400 });
  }

  try {
    const results = await runImportBatch(
      admin,
      session.shop,
      mapping,
      rows,
      options || {},
    );
    return Response.json({ results });
  } catch (e) {
    return Response.json(
      { error: e?.message || "Import batch failed" },
      { status: 500 },
    );
  }
};

// Guard against accidental GET navigation to this resource route.
export const loader = async () => {
  return Response.json({ error: "Method not allowed" }, { status: 405 });
};
