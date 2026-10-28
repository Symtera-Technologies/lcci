/**
 * The site's information architecture, straight from spec §4.1.
 *
 * Rule enforced here: no entry may be "#" or point back at "/". The legacy site
 * had seven placeholder links and six footer links that looped home; keeping the
 * IA as typed data means a dead link is a type error, not a thing QA finds later.
 */

export interface NavLink {
  label: string;
  href: `/${string}`;
  description?: string;
}

export interface NavSection {
  label: string;
  href: `/${string}`;
  children: NavLink[];
}

export const PRIMARY_NAV: NavSection[] = [
  {
    label: "About",
    href: "/about",
    children: [
      { label: "History & mission", href: "/about/history", description: "The chamber since 1923" },
      { label: "Leadership", href: "/about/leadership", description: "President, SVP, VP and the Executive Committee" },
      { label: "Committees", href: "/about/committees", description: "Standing and advisory committees" },
      { label: "Past leadership", href: "/about/past-leadership" },
      { label: "Secretariat", href: "/about/secretariat", description: "Departments and who to contact" },
      { label: "Careers", href: "/about/careers" },
      { label: "Contact", href: "/about/contact" },
    ],
  },
  {
    label: "Membership",
    href: "/membership",
    children: [
      { label: "Why join", href: "/membership/why-join", description: "What membership gets you" },
      { label: "Categories & dues", href: "/membership/categories" },
      { label: "Apply", href: "/membership/apply" },
      { label: "Renew", href: "/membership/renew" },
      { label: "Member directory", href: "/membership/directory", description: "Search 20,000+ businesses by sector" },
      { label: "FAQs", href: "/membership/faqs" },
    ],
  },
  {
    label: "Services",
    href: "/services",
    children: [
      { label: "Certificates of origin", href: "/services/certificates-of-origin" },
      { label: "Attestation", href: "/services/attestation" },
      { label: "Visa recommendation", href: "/services/visa-recommendation" },
      { label: "Women entrepreneurs", href: "/services/women-entrepreneurs" },
      { label: "Training", href: "/services/training" },
      { label: "Library & research centres", href: "/services/library", description: "Internet Library, EDRC, WTO Reference Centre" },
      { label: "Forms & downloads", href: "/services/forms" },
    ],
  },
  {
    label: "Advocacy",
    href: "/advocacy",
    children: [
      { label: "Policy positions", href: "/advocacy/positions", description: "What the chamber is asking for, and where it stands" },
      { label: "Budget proposals", href: "/advocacy/budget-proposals" },
      { label: "Economy", href: "/advocacy/economy", description: "Indicators, updated monthly" },
      { label: "Research & publications", href: "/advocacy/research" },
      { label: "Business confidence", href: "/advocacy/business-confidence" },
    ],
  },
  {
    label: "Trade & Events",
    href: "/trade",
    children: [
      { label: "Events calendar", href: "/trade/events" },
      { label: "Delegations", href: "/trade/delegations" },
      { label: "Exhibitions & fairs", href: "/trade/exhibitions" },
      { label: "Trade inquiries", href: "/trade/inquiries", description: "Buy, sell and partner leads" },
      { label: "Investment opportunities", href: "/trade/investment" },
      { label: "Humanitarian appeals", href: "/trade/humanitarian-appeals" },
    ],
  },
  {
    label: "Newsroom",
    href: "/news",
    children: [
      { label: "Press releases", href: "/news/press-releases" },
      { label: "Circulars & SROs", href: "/news/circulars" },
      { label: "Galleries", href: "/news/galleries" },
      { label: "Videos", href: "/news/videos" },
      { label: "Media contacts", href: "/news/media-contacts" },
    ],
  },
];

/** Footer quick tasks — spec §4.3. */
export const FOOTER_TASKS: NavLink[] = [
  { label: "Renew membership", href: "/membership/renew" },
  { label: "Certificates of origin", href: "/services/certificates-of-origin" },
  { label: "Circulars & SROs", href: "/news/circulars" },
  { label: "Member directory", href: "/membership/directory" },
  { label: "Forms & downloads", href: "/services/forms" },
];

export const FOOTER_LEGAL: NavLink[] = [
  { label: "Privacy policy", href: "/privacy" },
  { label: "Terms of use", href: "/terms" },
  { label: "Accessibility", href: "/accessibility" },
];

export const DEPARTMENTS: { name: string; email: string }[] = [
  { name: "Membership", email: "membership@lcci.org.pk" },
  { name: "Certificates & attestation", email: "certificates@lcci.org.pk" },
  { name: "Research", email: "research@lcci.org.pk" },
  { name: "Media & press", email: "media@lcci.org.pk" },
];

export const SOCIAL: { label: string; href: string }[] = [
  { label: "Facebook", href: "https://www.facebook.com/LCCIOfficial" },
  { label: "X", href: "https://x.com/LCCI_Official" },
  { label: "Instagram", href: "https://www.instagram.com/lcci_official" },
  { label: "YouTube", href: "https://www.youtube.com/@LCCIOfficial" },
];
