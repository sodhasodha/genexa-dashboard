export type Role = "owner" | "media_buyer" | "tech" | "csr" | "freelance";

export type NavItem = { href: string; label: string };

export const NAV: NavItem[] = [
  { href: "/overview", label: "Overview" },
  { href: "/clients", label: "Clients" },
  { href: "/launches", label: "Launches" },
  { href: "/call-centre", label: "Call Centre" },
  { href: "/media-buying", label: "Media Buying" },
  { href: "/tech", label: "Tech" },
  { href: "/tasks", label: "Tasks" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/ideas", label: "Ideas" },
];

/** Where each role lands after login. A CSR lands on Call Centre filtered to themselves. */
export function landingPath(staff: { id: string; role: Role }): string {
  switch (staff.role) {
    case "owner":
      return "/overview";
    case "media_buyer":
      return "/media-buying";
    case "tech":
      return "/tech";
    case "csr":
      return `/call-centre?csr=${staff.id}`;
    default:
      return "/tasks";
  }
}
