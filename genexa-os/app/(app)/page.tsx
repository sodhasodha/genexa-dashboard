import { redirect } from "next/navigation";
import { landingPath } from "@/lib/auth/nav";
import { requireStaff } from "@/lib/auth/staff";

export default async function Landing() {
  const staff = await requireStaff();
  redirect(landingPath(staff));
}
