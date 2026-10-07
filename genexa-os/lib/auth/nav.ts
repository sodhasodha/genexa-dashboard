export type Role = "owner" | "media_buyer" | "tech" | "csr" | "freelance";

export type NavItem = { href: string; label: string };
export type NavGroup = { title: string; items: NavItem[] };

export const NAV_GROUPS: NavGroup[] = [
  {
    title: "Pacing",
    items: [
      { href: "/overview", label: "Overview" },
      { href: "/overview?period=today", label: "Today" },
      { href: "/overview?period=week", label: "Week" },
      { href: "/overview?period=month", label: "Month" },
    ],
  },
  {
    title: "Team",
    items: [
      { href: "/call-centre", label: "Call Centre" },
      { href: "/media-buying", label: "Media Buying" },
      { href: "/tech", label: "Tech" },
      { href: "/team", label: "Team" },
    ],
  },
  {
    title: "Clients",
    items: [
      { href: "/clients", label: "Clients" },
      { href: "/launches", label: "Launches" },
      { href: "/pipeline", label: "Pipeline" },
    ],
  },
  {
    title: "Work",
    items: [
      { href: "/tasks", label: "Tasks" },
      { href: "/ideas", label: "Ideas" },
    ],
  },
  {
    title: "System",
    items: [
      { href: "/integrations", label: "Integrations" },
      { href: "/data-review", label: "Data review" },
    ],
  },
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
