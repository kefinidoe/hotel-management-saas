import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { getTenantFromRoute, requireModule, requireRole, ROLE_GROUPS } from "@/lib/authz";

const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB limit
const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

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

  try {
    const formData = await req.formData();
    const file = formData.get("file") as File | null;

    if (!file) {
      return NextResponse.json({ error: "No image file provided." }, { status: 400 });
    }
    if (!ALLOWED_TYPES.includes(file.type)) {
      return NextResponse.json({ error: "Use a PNG, JPG, WebP, or SVG image." }, { status: 400 });
    }
    if (file.size > MAX_FILE_SIZE) {
      return NextResponse.json({ error: "Image must be smaller than 2MB." }, { status: 400 });
    }

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !serviceRoleKey) {
      console.error("Missing Supabase environment variables.");
      return NextResponse.json({ error: "Server storage configuration error." }, { status: 500 });
    }

    const supabase = createClient(supabaseUrl, serviceRoleKey);

    const ext = file.name.split(".").pop() || "png";
    const filePath = `${tenant.hotelId}-${Date.now()}.${ext}`;
    const arrayBuffer = await file.arrayBuffer();

    const { error: uploadError } = await supabase.storage
      .from("hotel-logos")
      .upload(filePath, Buffer.from(arrayBuffer), {
        contentType: file.type,
        upsert: true,
      });

    if (uploadError) {
      console.error("Supabase storage upload error:", uploadError);
      return NextResponse.json({ error: "Failed to upload logo to storage." }, { status: 500 });
    }

    const { data: publicUrlData } = supabase.storage
      .from("hotel-logos")
      .getPublicUrl(filePath);

    return NextResponse.json({ logoUrl: publicUrlData.publicUrl });
  } catch (error) {
    console.error("Logo upload failed:", error);
    return NextResponse.json({ error: "Unexpected error uploading logo." }, { status: 500 });
  }
}