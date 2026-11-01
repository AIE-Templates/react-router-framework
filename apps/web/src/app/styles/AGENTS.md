# Global styles

styles/index.css is the global stylesheet entry. Keep layer order theme, base, mantine, components, utilities; project styles belong to components, allowing utilities to override them. Colocated component modules do not belong here. Do not use light-dark() or bare rem(). Core window safety CSS, when present, stays inline and unlayered in layouts/app-shell/chrome-safety.ts; do not move it into this entry.
