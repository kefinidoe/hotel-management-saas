import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { z } from "zod";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";
import { recordAudit } from "@/lib/audit";

const MAX_FILE_SIZE = 2 * 1024 * 1024;
// Allow multipart framing while bounding the request before form-data parsing.
const MAX_BODY_SIZE = MAX_FILE_SIZE + 64 * 1024;
const types = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" } as const;

type ImageType = keyof typeof types;
function isImageType(type: string): type is ImageType { return Object.hasOwn(types, type); }
function matchesMagic(bytes: Uint8Array, type: ImageType): boolean {
  if (type === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((byte, i) => bytes[i] === byte);
  if (type === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return bytes.length >= 12 && Buffer.from(bytes.subarray(0, 4)).toString("ascii") === "RIFF" && Buffer.from(bytes.subarray(8, 12)).toString("ascii") === "WEBP";
}

async function readBoundedBody(req: Request): Promise<Uint8Array | null> {
  const length = req.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > MAX_BODY_SIZE)) return null;
  if (!req.body) return new Uint8Array();
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > MAX_BODY_SIZE) { await reader.cancel(); return null; }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks, total);
}

async function authorize() {
  const tenant = await getTenantFromRoute();
  if (tenant instanceof NextResponse) return tenant;
  const forbidden = requireRole(tenant.role, ROLE_GROUPS.MANAGEMENT);
  if (forbidden) return forbidden;
  return (await requireModule(tenant.hotelId, "RESERVATIONS")) || tenant;
}

export async function POST(req: Request) {
  const tenant = await authorize();
  if (tenant instanceof NextResponse) return tenant;

  const query = z.strictObject({}).safeParse(Object.fromEntries(new URL(req.url).searchParams));
  if (!query.success) return NextResponse.json({ error: "Invalid request.", issues: query.error.issues }, { status: 400 });
  if (!req.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
    return NextResponse.json({ error: "Expected a multipart image upload." }, { status: 400 });
  }
  try {
    const body = await readBoundedBody(req);
    if (!body) return NextResponse.json({ error: "Upload request is too large." }, { status: 413 });
    let formData: FormData;
    try {
      formData = await new Request(req.url, { method: "POST", headers: { "content-type": req.headers.get("content-type")! }, body: Buffer.from(body) }).formData();
    } catch {
      return NextResponse.json({ error: "Invalid multipart body." }, { status: 400 });
    }
    const entries = [...formData.entries()];
    if (entries.length !== 1 || entries[0][0] !== "file" || typeof entries[0][1] === "string") {
      return NextResponse.json({ error: "Provide exactly one image file." }, { status: 400 });
    }
    const file = entries[0][1];
    if (!isImageType(file.type)) return NextResponse.json({ error: "Use a PNG, JPG, or WebP image." }, { status: 400 });
    if (file.size === 0 || file.size > MAX_FILE_SIZE) return NextResponse.json({ error: "Image must be no larger than 2MB." }, { status: 400 });
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!matchesMagic(bytes, file.type)) return NextResponse.json({ error: "Image content does not match its type." }, { status: 400 });

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!supabaseUrl || !serviceRoleKey) return NextResponse.json({ error: "Server storage configuration error." }, { status: 500 });

    const bucket = createClient(supabaseUrl, serviceRoleKey).storage.from("hotel-logos");
    const filePath = `${encodeURIComponent(tenant.hotelId)}/${randomUUID()}.${types[file.type]}`;
    const { error: uploadError } = await bucket.upload(filePath, Buffer.from(bytes), { contentType: file.type, upsert: false });
    if (uploadError) {
      console.error("Supabase storage upload error:", uploadError);
      return NextResponse.json({ error: "Failed to upload logo to storage." }, { status: 500 });
    }
    try {
      await recordAudit({ hotelId: tenant.hotelId, userId: tenant.userId, action: "HOTEL_LOGO_UPLOADED", entity: "Hotel", entityId: tenant.hotelId, metadata: { filePath, contentType: file.type, size: file.size } }, undefined, { strict: true });
    } catch (error) {
      // Storage and PostgreSQL cannot share a transaction. Attempt compensation;
      // a failed cleanup is logged for operational follow-up.
      try {
        const result = await bucket.remove([filePath]);
        if (result.error) console.error("Logo upload cleanup failed:", result.error);
      } catch (cleanupError) { console.error("Logo upload cleanup failed:", cleanupError); }
      throw error;
    }
    const { data } = bucket.getPublicUrl(filePath);
    return NextResponse.json({ logoUrl: data.publicUrl });
  } catch (error) {
    console.error("Logo upload failed:", error);
    return NextResponse.json({ error: "Unexpected error uploading logo." }, { status: 500 });
  }
}
