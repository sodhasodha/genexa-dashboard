import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

// Refreshes the Supabase session cookie and sends logged-out visitors to /login.
// This is a convenience redirect only: RLS in the database is what protects data.
export async function proxy(request: NextRequest) {
  let response = NextResponse.next({ request });
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return response;

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (toSet) => {
        for (const { name, value } of toSet) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of toSet) response.cookies.set(name, value, options);
      },
    },
  });
  const { data } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;
  const isApi = pathname.startsWith("/api/");
  const isPublic = pathname.startsWith("/login") || pathname.startsWith("/auth");

  // CSRs use the confirmation desk and nothing else: every other page redirects
  // there and every other API answers 403. (Pages, server actions and the
  // database refuse them as well; this is the first of three locks.)
  if (data.user) {
    const { data: me } = await supabase.from("staff").select("role").eq("auth_user_id", data.user.id).neq("status", "left").maybeSingle();
    if (me?.role === "csr") {
      const allowed = pathname === "/confirmations" || pathname.startsWith("/confirmations/") || pathname.startsWith("/api/confirmations") || isPublic;
      if (!allowed) {
        if (isApi) return NextResponse.json({ error: "forbidden" }, { status: 403 });
        const desk = request.nextUrl.clone();
        desk.pathname = "/confirmations";
        desk.search = "";
        return NextResponse.redirect(desk);
      }
    }
  }

  // API routes authenticate themselves (cron secret, webhook signatures, MCP token, a staff login).
  if (isApi) return response;
  if (!data.user && !isPublic) {
    const login = request.nextUrl.clone();
    login.pathname = "/login";
    login.search = "";
    return NextResponse.redirect(login);
  }
  return response;
}

export const config = {
  // Everything except static assets. /api is included only so a CSR's session is
  // refused there; routes without a session pass straight through to their own checks.
  // The manifest and icons must load without a session (phones fetch them with no cookies).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|manifest.webmanifest|icon|apple-icon|icons/|logo.png).*)"],
};
