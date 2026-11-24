export const deals = [
  { account: "Northline", stage: "Proposal", amount: 18000 },
  { account: "Aster Studio", stage: "Negotiation", amount: 12000 },
];
export const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export const recentLeads = [
  { contact: "Nora Chen", account: "Meridian Labs", initials: "NC", source: "Product demo" },
  { contact: "Miles Grant", account: "Fieldwork", initials: "MG", source: "Referral" },
  { contact: "Sofia Reed", account: "Orbit Systems", initials: "SR", source: "Website" },
  { contact: "Leo Park", account: "Juniper & Co.", initials: "LP", source: "Product demo" },
];

export const inboundLeads = [
  ["Jan", 12],
  ["Feb", 18],
  ["Mar", 15],
  ["Apr", 24],
  ["May", 21],
  ["Jun", 28],
] as const;
export const pipelineValue = deals.reduce((total, deal) => total + deal.amount, 0);
